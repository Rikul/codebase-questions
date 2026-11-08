import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Architecture, ReviewEvent } from '@cq/shared';
import type { AgentOptions } from '../src/llm/agent.js';

// Regression tests for the code review of 912277c..1f8fb3c (items 1-5; 5 is in upload.test.ts).
// Config is read when the app modules load, so set it before importing them.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-fixes-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.AUTH_DISABLED = 'true';
const { Auth } = await import('../src/auth.js');
const { openDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/index.js');
const { analyzeDirectory, saveAnalysis } = await import('../src/ingest/pipeline.js');
const { prepareCheckout } = await import('../src/ingest/clone.js');
const { getReview, listReviews, streamReview } = await import('../src/agent/review.js');
const { MockProvider } = await import('../src/llm/mock.js');
const { repoDir } = await import('../src/paths.js');

const FIXTURE = path.join(import.meta.dirname, 'fixtures/sample-app');
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'd@x', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'd@x' },
  });

/** A git checkout of the sample app with one commit whose subject no rule can type. */
async function checkout(id: string) {
  const origin = path.join(tmp, `${id}-origin`);
  fs.cpSync(FIXTURE, origin, { recursive: true });
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['add', '-A']);
  git(origin, ['commit', '-q', '-m', 'Make the sidebar sticky']);
  const dir = repoDir(id);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(tmp, ['clone', '-q', '--no-local', `file://${origin}`, dir]);
  const { history } = await prepareCheckout(dir, 'https://github.com/acme/demo', 0);
  return { dir, history };
}

describe('review fixes', () => {
  it('1. keeps LLM-assigned commit types across re-analysis', async () => {
    const db = openDb(':memory:');
    const { dir, history } = await checkout('types');
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('types', 'acme/demo', 'https://github.com/acme/demo', 'running')`).run();
    await analyzeDirectory(db, new MockProvider(), null, 'types', dir, () => undefined, () => undefined, history);
    const row = () => db.prepare(`SELECT type, type_source FROM commits WHERE repo_id='types'`).get() as { type: string; type_source: string };
    expect(row()).toEqual({ type: 'other', type_source: 'rule' });
    // What classifyCommits stores when the model types a commit the rules could not.
    db.prepare(`UPDATE commits SET type='feat', type_source='llm' WHERE repo_id='types'`).run();
    await analyzeDirectory(db, new MockProvider(), null, 'types', dir, () => undefined, () => undefined, history);
    expect(row()).toEqual({ type: 'feat', type_source: 'llm' });
  });

  it('2. flags a full review written for an earlier commit as stale and does not serve it as cached', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO repos (id, name, url, status, commit_sha) VALUES ('rev', 'acme/demo', 'https://github.com/acme/demo', 'running', 'aaa111')`).run();
    await analyzeDirectory(db, new MockProvider(), null, 'rev', FIXTURE, () => undefined);
    expect(getReview(db, 'rev', null)).toMatchObject({ stale: false });
    expect(listReviews(db, 'rev')[0]).toMatchObject({ path: null, stale: false });

    db.prepare(`UPDATE repos SET commit_sha='bbb222' WHERE id='rev'`).run(); // re-analyzed, review interrupted
    expect(getReview(db, 'rev', null)).toMatchObject({ stale: true });
    expect(listReviews(db, 'rev')[0]).toMatchObject({ path: null, stale: true });

    const events: ReviewEvent[] = [];
    await streamReview(db, new MockProvider(), null, 'rev', {}, (e) => events.push(e));
    expect(events.find((e) => e.type === 'result')).toMatchObject({ cached: false });
    expect(getReview(db, 'rev', null)).toMatchObject({ stale: false });
  });

  it('3. resolves a diagram edge the way the viewer drew it (collapsed vs expanded)', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('arch', 'acme/demo', 'https://github.com/acme/demo', 'ready')`).run();
    const comp = (id: string, parentId?: string) => ({ id, name: id, type: 'service' as const, description: id, responsibilities: [], paths: [], ...(parentId ? { parentId } : {}) });
    const link = (from: string, to: string, weight: number) => ({ id: `${from}--${to}`, from, to, kind: 'calls' as const, label: `${weight} imports`, description: `${from} uses ${to}`, evidence: [], weight });
    const arch: Architecture = { overview: '', components: [comp('a'), comp('a-child', 'a'), comp('b')], connections: [link('a', 'b', 2), link('a-child', 'b', 40)] };
    saveAnalysis(db, 'arch', arch, [], []);
    const app = createApp(db, new MockProvider(), null, new Auth(db, crypto.randomBytes(32)));
    const weight = async (q: string) => (await request(app).get(`/api/repos/arch/connections/a--b${q}`).expect(200)).body.connection.weight;
    expect(await weight('')).toBe(42); // default view: `a` collapsed, its child's links merged in
    expect(await weight('?expanded=')).toBe(42);
    expect(await weight('?expanded=a')).toBe(2); // `a` expanded: the edge is a's own link
  });

  it('4a. refuses to start a review while the repository is being analyzed', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('busy', 'acme/demo', 'https://github.com/acme/demo', 'running')`).run();
    const app = createApp(db, new MockProvider(), null, new Auth(db, crypto.randomBytes(32)));
    const res = await request(app).post('/api/repos/busy/review').send({}).expect(409);
    expect(res.body.error).toMatch(/in progress/);
  });

  it('4b. hands the background review back instead of holding up the caller', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    // A provider whose code review only finishes when the test says so.
    class SlowReview extends MockProvider {
      override async runAgent<T>(opts: AgentOptions<T>) {
        if (opts.final?.name === 'review') await gate;
        return super.runAgent(opts);
      }
    }
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('bg', 'acme/demo', 'https://github.com/acme/demo', 'running')`).run();
    let review: Promise<void> | null = null;
    await analyzeDirectory(db, new SlowReview(), null, 'bg', FIXTURE, () => undefined, () => undefined, null, () => undefined, (r) => (review = r));
    // analyzeDirectory returned while the review is still blocked.
    expect(review).not.toBeNull();
    expect(getReview(db, 'bg', null)).toBeNull();
    open();
    await review;
    expect(getReview(db, 'bg', null)).not.toBeNull();
  });
});
