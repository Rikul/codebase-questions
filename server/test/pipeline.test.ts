import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AskEvent } from '@cq/shared';
import { openDb } from '../src/db/index.js';
import { analyzeDirectory } from '../src/ingest/pipeline.js';
import { MockProvider } from '../src/llm/mock.js';
import { answerQuestion, classifyHeuristic } from '../src/qa/answer.js';
import { retrieve } from '../src/qa/retrieve.js';
import { exportProject, importProject } from '../src/export/export.js';
import { getArchitecture } from '../src/routes/queries.js';
import { getReview, listReviews, reviewRunning, startReview, streamReview } from '../src/agent/review.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/sample-app');

describe('analysis pipeline (offline provider)', () => {
  const db = openDb(':memory:');
  const llm = new MockProvider();
  const repoId = 'sample';

  beforeAll(async () => {
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES (?, 'acme/sample-app', 'https://github.com/acme/sample-app', 'running')`).run(repoId);
    await analyzeDirectory(db, llm, null, repoId, FIXTURE, () => undefined);
  });

  it('stores files, chunks and edges', () => {
    const files = db.prepare('SELECT count(*) n FROM files WHERE repo_id=?').get(repoId) as any;
    const chunks = db.prepare('SELECT count(*) n FROM chunks WHERE repo_id=?').get(repoId) as any;
    expect(files.n).toBeGreaterThan(8);
    expect(chunks.n).toBeGreaterThanOrEqual(files.n);
  });

  it('builds an architecture with components, connections and external systems', () => {
    const arch = getArchitecture(db, repoId);
    expect(arch.components.length).toBeGreaterThanOrEqual(4);
    expect(arch.components.some((c) => c.type === 'database')).toBe(true);
    expect(arch.connections.length).toBeGreaterThan(2);
    for (const e of arch.connections) {
      expect(arch.components.some((c) => c.id === e.from)).toBe(true);
      expect(arch.components.some((c) => c.id === e.to)).toBe(true);
      expect(e.evidence.length).toBeGreaterThan(0);
    }
  });

  it('writes insights and suggested questions for all four categories', () => {
    for (const cat of ['architecture', 'onboarding', 'security', 'api', 'repository']) {
      const n = db.prepare('SELECT count(*) n FROM insights WHERE repo_id=? AND category=?').get(repoId, cat) as any;
      const q = db.prepare('SELECT count(*) n FROM suggested_questions WHERE repo_id=? AND category=?').get(repoId, cat) as any;
      expect(n.n, cat).toBeGreaterThan(0);
      expect(q.n, cat).toBeGreaterThan(0);
    }
    const findings = db.prepare(`SELECT title FROM insights WHERE repo_id=? AND kind='finding'`).all(repoId) as any[];
    expect(findings.map((f) => f.title)).toEqual(expect.arrayContaining(['SQL built by string concatenation', 'Raw HTML rendering (XSS sink)']));
  });

  it('retrieves relevant code', async () => {
    const chunks = await retrieve(db, repoId, 'How does searchUsers query the database?', { category: 'security' });
    expect(chunks.slice(0, 2).map((c) => c.path)).toContain('src/services/userService.ts');
  });

  it('classifies questions', () => {
    expect(classifyHeuristic('Is there any SQL injection vulnerability?').category).toBe('security');
    expect(classifyHeuristic('How do the components interact in this architecture?').category).toBe('architecture');
    expect(classifyHeuristic('How do I get started and run it locally?').category).toBe('onboarding');
    expect(classifyHeuristic('How do I call the API client and handle retry behavior?').category).toBe('api');
  });

  it('answers questions with streaming events and citations', async () => {
    const events: AskEvent[] = [];
    for await (const ev of answerQuestion(db, llm, null, repoId, { question: 'Where is JWT auth enforced?' })) events.push(ev);
    expect(events[0]).toMatchObject({ type: 'meta', category: 'security' });
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.citations.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'token').length).toBeGreaterThan(0);
  });

  it('keeps a partial answer when the asker stops reading (Stop, closed tab)', async () => {
    let conversationId = 0;
    let tokens = 0;
    for await (const ev of answerQuestion(db, llm, null, repoId, { question: 'How is the API structured?' })) {
      if (ev.type === 'meta') conversationId = ev.conversationId;
      if (ev.type === 'token' && ++tokens === 2) break;
    }
    expect(tokens).toBe(2);
    const msgs = db.prepare('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id').all(conversationId) as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1].content).toMatch(/Stopped before the answer finished/);
    db.prepare('DELETE FROM conversations WHERE id=?').run(conversationId); // later tests count conversations
  });

  it('writes the full codebase review in the background step', () => {
    const full = getReview(db, repoId, null);
    expect(full?.review.summaryMd).toMatch(/Static review/);
    expect(listReviews(db, repoId)[0]).toMatchObject({ path: null });
  });

  it('reviews a file and caches it by content hash', async () => {
    const events: any[] = [];
    await streamReview(db, llm, null, repoId, { path: 'src/routes/users.ts' }, (e) => events.push(e));
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ path: 'src/routes/users.ts', cached: false });
    expect(events.some((e) => e.type === 'step')).toBe(true);
    const again: any[] = [];
    await streamReview(db, llm, null, repoId, { path: 'src/routes/users.ts' }, (e) => again.push(e));
    expect(again).toEqual([expect.objectContaining({ type: 'result', cached: true })]);
    expect(listReviews(db, repoId).map((e) => e.path)).toEqual([null, 'src/routes/users.ts']);
    expect(listReviews(db, repoId)[1].stale).toBe(false);
  });

  it('lets a page that left and came back join a review in progress', async () => {
    const run = startReview(db, llm, null, repoId, null);
    expect(reviewRunning(repoId, null)).toBe(true);
    // A second request while running joins the same run rather than starting another one.
    expect(startReview(db, llm, null, repoId, null)).toBe(run);
    const joined: any[] = [];
    await streamReview(db, llm, null, repoId, {}, (e) => joined.push(e));
    expect(joined.filter((e) => e.type === 'result')).toEqual([expect.objectContaining({ cached: false, path: null })]);
    expect(reviewRunning(repoId, null)).toBe(false);
  });

  it('round-trips through export and import', () => {
    const exp = exportProject(db, repoId, true);
    const json = JSON.parse(JSON.stringify(exp));
    const newId = importProject(db, json);
    const a = getArchitecture(db, repoId);
    const b = getArchitecture(db, newId);
    expect(b.components).toEqual(a.components);
    expect(b.connections).toEqual(a.connections);
    const ins = (id: string) => db.prepare('SELECT category, title, body_md FROM insights WHERE repo_id=? ORDER BY position').all(id);
    expect(ins(newId)).toEqual(ins(repoId));
    const convs = db.prepare('SELECT count(*) n FROM conversations WHERE repo_id=?').get(newId) as any;
    expect(convs.n).toBe(1);
    expect(listReviews(db, newId).map((e) => e.path)).toEqual(listReviews(db, repoId).map((e) => e.path));
    expect(() => importProject(db, { format: 'nope' })).toThrow(/Invalid export file/);
  });
});

describe('background code review', () => {
  it('publishes the diagram and insights before the review, which runs last', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('background', 'sample', 'https://github.com/acme/sample', 'running')`).run();
    const mock = new MockProvider();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const resultsReady = new Promise<void>((resolve) => { ready = resolve; });
    const llm = Object.create(mock) as import('../src/llm/provider.js').LLMProvider;
    Object.defineProperty(llm, 'name', { value: 'test' });
    llm.runAgent = async (opts) => {
      if (opts.final?.name === 'review') await blocked;
      return mock.runAgent(opts);
    };
    const stages: string[] = [];
    const progress: number[] = [];
    const analysis = analyzeDirectory(db, llm, null, 'background', FIXTURE, (stage, _message, fraction) => { stages.push(stage); progress.push(fraction); }, () => undefined, null, ready);
    await resultsReady;
    const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table} WHERE repo_id='background'`).get() as { n: number }).n;
    try {
      expect(count('insights')).toBeGreaterThan(0);
      expect(count('components')).toBeGreaterThan(0);
      expect(count('reviews')).toBe(0);
      expect(stages).not.toContain('architecture');
      expect(progress[stages.indexOf('store')]).toBeCloseTo(7 / 9);
    } finally {
      release();
    }
    await analysis;
    expect(progress[stages.indexOf('review')]).toBeCloseTo(8 / 9);
    expect(progress.every((value, i) => i === 0 || value >= progress[i - 1])).toBe(true);
    expect(count('reviews')).toBe(1);
    db.close();
  });
});

describe('insights from a model reply with missing optional fields', () => {
  it('keeps the model insights when refs are left out or the severity is unexpected', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('lenient', 'sample', 'https://github.com/acme/sample', 'running')`).run();
    const mock = new MockProvider();
    const llm = Object.create(mock) as import('../src/llm/provider.js').LLMProvider;
    Object.defineProperty(llm, 'name', { value: 'test' });
    llm.completeJSON = async <T,>(opts: import('../src/llm/provider.js').JSONOptions<T>): Promise<T> => {
      if (!opts.name.startsWith('insights_')) return mock.completeJSON(opts);
      return opts.schema.parse({ insights: [{ kind: 'finding', title: `Model ${opts.name}`, bodyMd: 'x', severity: 'Medium' }] });
    };
    const warnings: string[] = [];
    await analyzeDirectory(db, llm, null, 'lenient', FIXTURE, () => undefined, (w) => warnings.push(w));
    expect(warnings.filter((w) => w.startsWith('insights_'))).toEqual([]);
    const rows = db.prepare(`SELECT title, severity, refs FROM insights WHERE repo_id='lenient' AND category='security'`).all() as any[];
    expect(rows).toEqual([{ title: 'Model insights_security', severity: null, refs: '[]' }]);
    db.close();
  });
});
