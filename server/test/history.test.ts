import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExplainEvent } from '@cq/shared';

// Point DATA_DIR at a temp dir before the app modules read their config.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-history-'));
process.env.DATA_DIR = path.join(tmp, 'data');

const g = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });

function commit(cwd: string, who: 'Alice' | 'Bob', date: string, msg: string) {
  const env = { GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase()}@example.com`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who.toLowerCase()}@example.com`, GIT_COMMITTER_DATE: date };
  g(cwd, ['add', '-A'], env);
  g(cwd, ['commit', '-q', '-m', msg], env);
}

/** A small repository with a known history. */
function makeOrigin() {
  const src = path.join(tmp, 'origin');
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  g(src, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(src, 'src/util.js'), 'export function helper() {\n  return 1;\n}\n');
  commit(src, 'Alice', '2024-01-01T10:00:00Z', 'Add util with helper');
  fs.appendFileSync(path.join(src, 'src/util.js'), '\nexport function foo(a) {\n  return a + 1;\n}\n');
  commit(src, 'Bob', '2024-02-01T10:00:00Z', 'Add foo');
  fs.writeFileSync(path.join(src, 'src/util.js'), 'export function helper() {\n  return 1;\n}\n\nexport function foo(a) {\n  // handle negatives\n  return Math.abs(a) + 1;\n}\n');
  commit(src, 'Alice', '2024-03-01T10:00:00Z', 'Make foo handle negatives');
  g(src, ['mv', 'src/util.js', 'src/lib.js']);
  commit(src, 'Bob', '2024-04-01T10:00:00Z', 'Rename util to lib');
  fs.appendFileSync(path.join(src, 'src/lib.js'), '\nexport const BAR = 42;\n');
  commit(src, 'Alice', '2024-05-01T10:00:00Z', 'Add BAR constant');
  return src;
}

describe('git history', async () => {
  const { openDb } = await import('../src/db/index.js');
  const { analyzeDirectory } = await import('../src/ingest/pipeline.js');
  const { MockProvider } = await import('../src/llm/mock.js');
  const { finalizeHistory, safeGitPath, safeSha } = await import('../src/history/git.js');
  const { fileHistory } = await import('../src/history/index.js');
  const { blame, commitDetails, searchHistory, symbolHistory } = await import('../src/history/symbol.js');
  const { repoDir } = await import('../src/paths.js');
  const { explain } = await import('../src/agent/explain.js');
  const { exportProject, importProject } = await import('../src/export/export.js');

  const db = openDb(':memory:');
  let origin = '';

  async function cloneInto(id: string, depth: number) {
    const dir = repoDir(id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    g(tmp, ['clone', '-q', '--no-local', ...(depth ? ['--depth', String(depth)] : []), `file://${origin}`, dir]);
    // Simulate a credentialed remote, which finalizeHistory must scrub.
    g(dir, ['remote', 'set-url', 'origin', 'https://x-access-token:SECRET123@github.com/acme/demo']);
    const info = await finalizeHistory(dir, 'https://github.com/acme/demo', depth);
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES (?, 'acme/demo', 'https://github.com/acme/demo', 'running')`).run(id);
    await analyzeDirectory(db, new MockProvider(), null, id, dir, () => undefined, () => undefined, info);
    return dir;
  }

  beforeAll(async () => {
    origin = makeOrigin();
    await cloneInto('full', 0);
    await cloneInto('shallow', 2);
  });

  it('scrubs credentials from the kept .git directory', () => {
    const dir = repoDir('full');
    expect(g(dir, ['remote', 'get-url', 'origin']).trim()).toBe('https://github.com/acme/demo');
    const config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    expect(config).not.toContain('SECRET123');
    expect(fs.existsSync(path.join(dir, '.git', 'logs'))).toBe(false);
  });

  it('builds a file timeline that follows renames', () => {
    const h = fileHistory(db, 'full', 'src/lib.js');
    if (!h.available) throw new Error(h.reason);
    expect(h.commitCount).toBe(5);
    expect(h.created).toMatchObject({ author: 'Alice', subject: 'Add util with helper', status: 'A', path: 'src/util.js', uncertain: false });
    expect(h.created!.date.slice(0, 10)).toBe('2024-01-01');
    expect(h.lastChanged).toMatchObject({ subject: 'Add BAR constant' });
    expect(h.renames).toEqual([expect.objectContaining({ from: 'src/util.js', to: 'src/lib.js' })]);
    expect(h.authors.map((a) => a.name).sort()).toEqual(['Alice', 'Bob']);
    const meta = JSON.parse((db.prepare(`SELECT meta FROM files WHERE repo_id='full' AND path='src/lib.js'`).get() as any).meta);
    expect(meta.history).toMatchObject({ createdBy: 'Alice', commits: 5 });
  });

  it('finds when a function was introduced and how it changed', async () => {
    const h = await symbolHistory(db, 'full', { path: 'src/lib.js', name: 'foo' });
    if (!h.available) throw new Error(h.reason);
    expect(h.introduced).toMatchObject({ author: 'Bob', subject: 'Add foo', how: 'line-history', uncertain: false });
    expect(h.commits.map((c) => c.subject)).toEqual(['Make foo handle negatives', 'Add foo']);
    expect(h.commits[0].excerpt).toContain('Math.abs');
  });

  it('finds when a variable first appeared (pickaxe) and blames lines', async () => {
    const h = await symbolHistory(db, 'full', { path: 'src/lib.js', name: 'BAR' });
    if (!h.available) throw new Error(h.reason);
    expect(h.introduced).toMatchObject({ subject: 'Add BAR constant', author: 'Alice' });
    const b = await blame(db, 'full', 'src/lib.js');
    if (!b.available) throw new Error(b.reason);
    const at = (line: number) => b.ranges.find((r) => r.start <= line && r.end >= line)!;
    expect(at(1).summary).toBe('Add util with helper');
    expect(at(6).summary).toBe('Make foo handle negatives');
    expect(at(10).summary).toBe('Add BAR constant');
    const s = await searchHistory(db, 'full', 'Math.abs');
    if (!s.available) throw new Error('unavailable');
    expect(s.codeChanges.map((c) => c.subject)).toEqual(['Make foo handle negatives']);
  });

  it('returns commit details with a diff', async () => {
    const sha = g(repoDir('full'), ['rev-parse', 'HEAD~1']).trim();
    const c = await commitDetails(db, 'full', sha);
    if (!c.available) throw new Error(c.reason);
    expect(c.subject).toBe('Rename util to lib');
    expect(c.files).toEqual([{ status: 'R', oldPath: 'src/util.js', path: 'src/lib.js' }]);
  });

  it('marks creation as uncertain when history is truncated', async () => {
    const h = fileHistory(db, 'shallow', 'src/lib.js');
    if (!h.available) throw new Error(h.reason);
    expect(h.truncated).toBe(true);
    expect(h.created?.uncertain).toBe(true);
    const s = await symbolHistory(db, 'shallow', { path: 'src/lib.js', name: 'foo' });
    if (!s.available) throw new Error(s.reason);
    expect(s.introduced?.uncertain).toBe(true);
  });

  it('rejects unsafe paths and commit ids', () => {
    expect(() => safeGitPath('../etc/passwd')).toThrow();
    expect(() => safeGitPath('--output=/tmp/x')).toThrow();
    expect(() => safeSha('HEAD; rm -rf /')).toThrow();
    expect(safeGitPath('./src/lib.js')).toBe('src/lib.js');
  });

  it('includes history in explanations, and history survives export/import', async () => {
    const events: ExplainEvent[] = [];
    await explain(db, new MockProvider(), null, 'full', { path: 'src/lib.js', symbol: { name: 'foo' } }, (e) => events.push(e));
    const res = events.find((e) => e.type === 'result') as Extract<ExplainEvent, { type: 'result' }>;
    expect(res.explanation.history?.created).toMatch(/Bob/);
    expect(res.explanation.history?.created).toMatch(/2024-02-01/);
    expect(events.some((e) => e.type === 'step' && e.step.tool === 'symbol_history')).toBe(true);

    const id = importProject(db, JSON.parse(JSON.stringify(exportProject(db, 'full', false))));
    const h = fileHistory(db, id, 'src/lib.js');
    expect(h.available && h.commitCount).toBe(5);
    // Symbol history needs .git, which imports do not have.
    expect(await symbolHistory(db, id, { path: 'src/lib.js', name: 'foo' })).toMatchObject({ available: false });
  });

  it('returns history tool results to the model in the agent loop', async () => {
    const { startFakeApi } = await import('./fakeApi.js');
    const { AnthropicProvider } = await import('../src/llm/anthropic.js');
    const fake = await startFakeApi();
    try {
      const sha = g(repoDir('full'), ['rev-parse', 'HEAD~2']).trim();
      fake.anthropic.push(
        [{ tool: 'symbol_history', input: { path: 'src/lib.js', name: 'foo' } }, { tool: 'commit_details', input: { sha, path: 'src/util.js' } }],
        [{ tool: 'submit_explanation', input: { what: 'w', howItFits: 'h', whenUsed: 'u', contains: [], callers: [], callees: [], history: { created: 'Added by Bob', evolution: 'e', keyCommits: [{ sha: sha.slice(0, 7), why: 'negatives' }] } } }],
      );
      const events: ExplainEvent[] = [];
      await explain(db, new AnthropicProvider('k', 'c', 'c', fake.base), null, 'full', { path: 'src/lib.js', symbol: { name: 'foo' }, refresh: true }, (e) => events.push(e));
      const results = fake.requests[1].body.messages.at(-1).content;
      expect(results[0].content).toContain('Add foo');
      expect(results[1].content).toContain('Math.abs');
      const res = events.find((e) => e.type === 'result') as Extract<ExplainEvent, { type: 'result' }>;
      expect(res.explanation.history?.keyCommits[0].why).toBe('negatives');
    } finally {
      fake.close();
    }
  });
});

describe('history questions in Ask (offline)', async () => {
  it('answers "when was foo added?" from git history', async () => {
    const { openDb } = await import('../src/db/index.js');
    const { MockProvider } = await import('../src/llm/mock.js');
    const { answerQuestion, classifyHeuristic } = await import('../src/qa/answer.js');
    expect(classifyHeuristic('When was the login function added?').category).toBe('onboarding');
    // Reuse the clone made by the suite above (same DATA_DIR) by re-indexing into a fresh DB.
    const { analyzeDirectory } = await import('../src/ingest/pipeline.js');
    const { finalizeHistory } = await import('../src/history/git.js');
    const { repoDir } = await import('../src/paths.js');
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('full', 'acme/demo', 'https://github.com/acme/demo', 'ready')`).run();
    const info = await finalizeHistory(repoDir('full'), 'https://github.com/acme/demo', 0);
    await analyzeDirectory(db, new MockProvider(), null, 'full', repoDir('full'), () => undefined, () => undefined, info);
    let text = '';
    for await (const ev of answerQuestion(db, new MockProvider(), null, 'full', { question: 'When was foo added?' })) if (ev.type === 'token') text += ev.text;
    expect(text).toMatch(/introduced on \*\*2024-02-01\*\* by \*\*Bob\*\*/);
    expect(text).toContain('Make foo handle negatives');
  });
});
