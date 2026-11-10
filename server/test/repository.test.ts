import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { backfillCommitStats, openDb } from '../src/db/index.js';
import { classifyCommits } from '../src/history/classify.js';
import { listCommits, repoStats } from '../src/history/commits.js';
import { indexHistory } from '../src/history/index.js';
import { commitTypeOf } from '../src/history/types.js';
import { prepareCheckout } from '../src/ingest/clone.js';
import { MockProvider } from '../src/llm/mock.js';
import { RepoIndex, repoTools } from '../src/agent/tools.js';
import { exportProject, importProject } from '../src/export/export.js';

describe('commit type rules', () => {
  it.each([
    ['feat(api): add search', 'feat'],
    ['fix!: crash on empty input', 'fix'],
    ['refactor: split parser', 'refactor'],
    ['perf(db): faster queries', 'refactor'],
    ['chore(deps): bump express', 'chore'],
    ['ci: cache npm', 'chore'],
    ['docs: update README', 'docs'],
    ['test: cover login', 'test'],
    ['Merge pull request #12 from acme/branch', 'chore'],
    ['Fix crash when the list is empty', 'fix'],
    ['Fixed typo in error', 'fix'],
    ['Add dark mode', 'feat'],
    ['Implemented retries', 'feat'],
    ['Rename helpers', 'refactor'],
    ['Bump version to 1.2.0', 'chore'],
    ['[fix] wrong total', 'fix'],
    ['Make the sidebar sticky', 'other'],
    ['wip', 'other'],
  ])('%s → %s', (subject, type) => expect(commitTypeOf(subject)).toBe(type));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-repo-'));
const g = (cwd: string, args: string[], date = '2024-01-01T10:00:00Z', who = 'Alice') =>
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@x`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@x`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: 'utf8',
  });

function commit(src: string, msg: string, files: Record<string, string>, date: string, who = 'Alice') {
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), body);
  }
  g(src, ['add', '-A'], date, who);
  g(src, ['commit', '-q', '-m', msg], date, who);
}

describe('commit stats, filters and classification', () => {
  const db = openDb(':memory:');
  const id = 'r';
  let dir = '';
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

  beforeAll(async () => {
    const src = path.join(tmp, 'origin');
    fs.mkdirSync(src, { recursive: true });
    g(src, ['init', '-q', '-b', 'main']);
    commit(src, 'Initial import', { 'src/a.js': lines(400), 'src/b.js': lines(20) }, '2024-01-05T10:00:00Z'); // other, XL? 420 → L
    commit(src, 'feat: add search', { 'src/search.js': lines(60) }, '2024-02-10T10:00:00Z', 'Bob'); // feat, M
    commit(src, 'Fix off-by-one in pager', { 'src/b.js': lines(21) }, '2024-02-11T10:00:00Z'); // fix, XS
    commit(src, 'Make the sidebar sticky', { 'src/ui/side.js': lines(30) }, '2024-03-01T10:00:00Z', 'Bob'); // other, S
    dir = path.join(tmp, 'checkout');
    g(tmp, ['clone', '-q', '--no-local', `file://${src}`, dir]);
    const { history } = await prepareCheckout(dir, 'https://github.com/acme/r', 0);
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES (?, 'acme/r', 'https://github.com/acme/r', 'ready')`).run(id);
    await indexHistory(db, id, dir, history!, 1000);
  });

  it('stores lines changed, files and a rule type per commit', () => {
    const rows = db.prepare('SELECT subject, added, deleted, files, type, type_source FROM commits WHERE repo_id=? ORDER BY seq').all(id) as any[];
    expect(rows.map((r) => [r.subject, r.type])).toEqual([
      ['Make the sidebar sticky', 'other'],
      ['Fix off-by-one in pager', 'fix'],
      ['feat: add search', 'feat'],
      ['Initial import', 'other'],
    ]);
    expect(rows[3]).toMatchObject({ added: 420, deleted: 0, files: 2, type_source: 'rule' });
    expect(rows[1]).toMatchObject({ added: 1, deleted: 0, files: 1 });
  });

  it('filters by type, size bucket, line range, text, author, path and month', () => {
    const subjects = (f: Parameters<typeof listCommits>[2]) => listCommits(db, id, f).commits.map((c) => c.subject);
    expect(subjects({ types: ['feat', 'fix'] })).toEqual(['Fix off-by-one in pager', 'feat: add search']);
    expect(subjects({ sizes: ['XS'] })).toEqual(['Fix off-by-one in pager']);
    expect(subjects({ sizes: ['S', 'M'] })).toEqual(['Make the sidebar sticky', 'feat: add search']);
    expect(subjects({ minLines: 50, maxLines: 100 })).toEqual(['feat: add search']);
    expect(subjects({ q: 'pager' })).toEqual(['Fix off-by-one in pager']);
    expect(subjects({ author: 'Bob' })).toEqual(['Make the sidebar sticky', 'feat: add search']);
    expect(subjects({ path: 'src/ui' })).toEqual(['Make the sidebar sticky']);
    expect(subjects({ since: '2024-02-01', until: '2024-02-31T23:59:59Z' })).toEqual(['Fix off-by-one in pager', 'feat: add search']);
    expect(listCommits(db, id, { sort: 'largest', limit: 1 }).commits[0].subject).toBe('Initial import');
    expect(subjects({ sort: 'oldest' })).toEqual(['Initial import', 'feat: add search', 'Fix off-by-one in pager', 'Make the sidebar sticky']);
    expect(listCommits(db, id, { limit: 2, offset: 2 })).toMatchObject({ total: 4, commits: [{ subject: 'feat: add search' }, { subject: 'Initial import' }] });
  });

  it('summarizes the repository', () => {
    const s = repoStats(db, id);
    expect(s.history).toMatchObject({ commits: 4, types: { feat: 1, fix: 1, other: 2 }, sizes: { XS: 1, S: 1, M: 1, L: 1, XL: 0 } });
    expect(s.history!.months.map((m) => [m.month, m.commits])).toEqual([['2024-01', 1], ['2024-02', 2], ['2024-03', 1]]);
    expect(s.history!.authors.map((a) => a.author).sort()).toEqual(['Alice', 'Bob']);
  });

  it('asks the model only about unclassified commits, and keeps its answers across re-indexing', async () => {
    const llm = Object.create(new MockProvider()) as import('../src/llm/provider.js').LLMProvider;
    Object.defineProperty(llm, 'name', { value: 'test' });
    let sent: string[] = [];
    llm.completeJSON = async <T,>(opts: import('../src/llm/provider.js').JSONOptions<T>): Promise<T> => {
      sent = String(opts.messages[0].content).split('\n');
      return opts.schema.parse({ types: sent.map((l, i) => ({ i, type: l.includes('sidebar') ? 'feat' : 'chore' })) });
    };
    expect(await classifyCommits(db, llm, id, { concurrency: 2 })).toBe(2);
    expect(sent.map((l) => l.replace(/^\d+\. /, ''))).toEqual(['Make the sidebar sticky', 'Initial import']);
    const type = (s: string) => db.prepare('SELECT type, type_source FROM commits WHERE repo_id=? AND subject=?').get(id, s);
    expect(type('Make the sidebar sticky')).toEqual({ type: 'feat', type_source: 'llm' });
    // Re-indexing keeps the model's types and does not send them again.
    const info = { shallow: false, rootSha: null, boundaries: [], depth: 0 };
    await indexHistory(db, id, dir, info, 1000);
    expect(type('Make the sidebar sticky')).toEqual({ type: 'feat', type_source: 'llm' });
    sent = [];
    await classifyCommits(db, llm, id, { concurrency: 2 });
    expect(sent).toEqual([]);
  });

  it('fills stats for commits indexed before they existed (once, not on every read)', () => {
    db.prepare('UPDATE commits SET added=NULL, deleted=NULL, files=NULL, type=NULL, type_source=NULL WHERE repo_id=?').run(id);
    listCommits(db, id);
    expect(db.prepare(`SELECT added FROM commits WHERE repo_id=? AND subject='feat: add search'`).get(id)).toEqual({ added: null });
    backfillCommitStats(db); // what opening the database runs
    expect(db.prepare(`SELECT type, added FROM commits WHERE repo_id=? AND subject='feat: add search'`).get(id)).toEqual({ type: 'feat', added: 60 });
  });

  it('fills stats for commits imported from an older export', () => {
    const data = exportProject(db, id, false) as any;
    for (const c of data.history.commits) for (const k of ['type', 'typeSource', 'added', 'deleted', 'files']) delete c[k];
    const imported = importProject(db, data);
    const fix = listCommits(db, imported, { types: ['fix'] }).commits;
    expect(fix.map((c) => c.subject)).toEqual(['Fix off-by-one in pager']);
    expect(listCommits(db, imported).commits.find((c) => c.subject === 'feat: add search')).toMatchObject({ type: 'feat', added: 60 });
  });

  it('describes the size buckets list_commits accepts from SIZE_BUCKETS', () => {
    const tool = repoTools(new RepoIndex(db, id)).find((t) => t.name === 'list_commits')!;
    expect(tool.description).toContain('XS <10, S <50, M <250, L <1000, XL 1000+');
    expect(tool.schema.safeParse({ sizes: ['XL'] }).success).toBe(true);
    expect(tool.schema.safeParse({ sizes: ['XXL'] }).success).toBe(false);
  });

  it('exposes the commit list to the agent as list_commits', async () => {
    const tool = repoTools(new RepoIndex(db, id)).find((t) => t.name === 'list_commits')!;
    const out = (await tool.run(tool.schema.parse({ types: ['fix'] }))) as any;
    expect(out).toMatchObject({ total: 1, commits: [{ subject: 'Fix off-by-one in pager', type: 'fix' }] });
  });
});
