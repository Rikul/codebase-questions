import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression tests for the PR review findings on git history.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-history-review-'));
process.env.DATA_DIR = path.join(tmp, 'data');

let clock = Date.parse('2024-01-01T00:00:00Z');
const g = (cwd: string, args: string[]) => {
  const date = new Date((clock += 3600_000)).toISOString();
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
};
const commitAll = (cwd: string, msg: string) => {
  g(cwd, ['add', '-A']);
  g(cwd, ['commit', '-q', '-m', msg]);
};
function newRepo(name: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  g(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

describe('history review fixes', async () => {
  const { openDb } = await import('../src/db/index.js');
  const { analyzeDirectory } = await import('../src/ingest/pipeline.js');
  const { MockProvider } = await import('../src/llm/mock.js');
  const { finalizeHistory } = await import('../src/history/git.js');
  const { fileHistory, indexHistory, repoHistorySummary, storeFileHistorySummaries } = await import('../src/history/index.js');
  const { symbolHistory } = await import('../src/history/symbol.js');
  const { prepareCheckout } = await import('../src/ingest/clone.js');
  const { answerQuestion } = await import('../src/qa/answer.js');
  const { repoDir } = await import('../src/paths.js');
  const { config } = await import('../src/config.js');

  const db = openDb(':memory:');

  async function ingest(id: string, origin: string, depth = 0) {
    const dir = repoDir(id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    g(tmp, ['clone', '-q', '--no-local', ...(depth ? ['--depth', String(depth)] : []), `file://${origin}`, dir]);
    const { history } = await prepareCheckout(dir, 'https://github.com/acme/x', depth);
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES (?, 'acme/x', 'https://github.com/acme/x', 'running')`).run(id);
    await analyzeDirectory(db, new MockProvider(), null, id, dir, () => undefined, () => undefined, history);
    return dir;
  }

  it('finds the introducing commit even when a function changed more than 60 times', async () => {
    const o = newRepo('many');
    fs.writeFileSync(path.join(o, 'a.js'), 'export function f() {\n  return 0;\n}\n');
    commitAll(o, 'v0: add f');
    for (let i = 1; i <= 65; i++) {
      fs.writeFileSync(path.join(o, 'a.js'), `export function f() {\n  return ${i};\n}\n`);
      commitAll(o, `v${i}`);
    }
    await ingest('many', o);
    const h = await symbolHistory(db, 'many', { path: 'a.js', name: 'f' });
    if (!h.available) throw new Error(h.reason);
    expect(h.introduced).toMatchObject({ subject: 'v0: add f', how: 'line-history', uncertain: false });
    expect(h.totalCommits).toBe(66);
    expect(h.commits).toHaveLength(60);
    expect(h.timelineTruncated).toBe(true);
  }, 60_000);

  it('uses the first appearance of a variable name, not whatever last occupied its lines', async () => {
    const o = newRepo('vars');
    fs.writeFileSync(path.join(o, 'v.js'), 'export const OLD_NAME = 1;\nexport const KEEP = 2;\n');
    commitAll(o, 'add OLD_NAME');
    fs.writeFileSync(path.join(o, 'v.js'), 'export const NEW_NAME = 3;\nexport const KEEP = 2;\n');
    commitAll(o, 'replace OLD_NAME with NEW_NAME');
    await ingest('vars', o);
    const h = await symbolHistory(db, 'vars', { path: 'v.js', name: 'NEW_NAME' });
    if (!h.available) throw new Error(h.reason);
    expect(h.introduced).toMatchObject({ subject: 'replace OLD_NAME with NEW_NAME', how: 'pickaxe' });
  });

  it('treats every shallow boundary of a merge as uncertain', async () => {
    const o = newRepo('merge');
    fs.writeFileSync(path.join(o, 'base.js'), 'export const base = 1;\n');
    commitAll(o, 'base');
    g(o, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(o, 'feature.js'), 'export const feature = 1;\n');
    commitAll(o, 'feature work');
    g(o, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(o, 'main.js'), 'export const main = 1;\n');
    commitAll(o, 'main work');
    g(o, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);
    const dir = await ingest('merge', o, 2);
    const boundaries = fs.readFileSync(path.join(dir, '.git', 'shallow'), 'utf8').trim().split('\n');
    expect(boundaries.length).toBe(2);
    for (const f of ['base.js', 'main.js', 'feature.js']) {
      const h = fileHistory(db, 'merge', f);
      if (!h.available) throw new Error(h.reason);
      expect(h.created?.uncertain, f).toBe(true);
    }
  });

  it('reports truncation caused by the index commit cap', async () => {
    const id = 'many';
    await indexHistory(db, id, repoDir(id), await finalizeHistory(repoDir(id), 'https://github.com/acme/x', 0), 10);
    storeFileHistorySummaries(db, id);
    const s = repoHistorySummary(db, id)!;
    expect(s).toMatchObject({ commitCount: 10, totalCommits: 66, capped: true, shallow: false, truncated: true });
    const h = fileHistory(db, id, 'a.js');
    if (!h.available) throw new Error(h.reason);
    expect(h.truncated).toBe(true);
    expect(h.created?.uncertain).toBe(true); // its "add" is older than the indexed window
  });

  it('fails closed (and deletes the checkout) when credentials cannot be scrubbed', async () => {
    const o = newRepo('secret');
    fs.writeFileSync(path.join(o, 'x.js'), 'export const x = 1;\n');
    commitAll(o, 'x');
    const dir = path.join(tmp, 'secret-checkout');
    g(tmp, ['clone', '-q', '--no-local', `file://${o}`, dir]);
    // A token somewhere other than the remote URL must still be caught.
    g(dir, ['config', 'http.extraHeader', 'Authorization: Bearer TOPSECRET42']);
    await expect(prepareCheckout(dir, 'https://github.com/acme/x', 0, 'TOPSECRET42')).rejects.toThrow(/Post-clone setup failed/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('drops history over MAX_HISTORY_MB but keeps analyzing', async () => {
    const o = newRepo('bighist');
    fs.writeFileSync(path.join(o, 'y.js'), 'export const y = 1;\n');
    commitAll(o, 'y');
    const dir = path.join(tmp, 'bighist-checkout');
    g(tmp, ['clone', '-q', '--no-local', `file://${o}`, dir]);
    const prev = config.ingest.maxHistoryMb;
    config.ingest.maxHistoryMb = 0;
    try {
      const r = await prepareCheckout(dir, 'https://github.com/acme/x', 0);
      expect(r.history).toBeNull();
      expect(r.warnings[0]).toMatch(/MAX_HISTORY_MB/);
      expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'y.js'))).toBe(true);
    } finally {
      config.ingest.maxHistoryMb = prev;
    }
  });

  it('builds per-file summaries in one pass (scales with total rows, not files × rows)', async () => {
    const o = newRepo('wide');
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(o, `f${i}.txt`), `file ${i}\n`);
    commitAll(o, 'add 2000 files');
    for (let i = 0; i < 2000; i += 2) fs.appendFileSync(path.join(o, `f${i}.txt`), 'more\n');
    commitAll(o, 'touch half');
    await ingest('wide', o);
    const t = performance.now();
    storeFileHistorySummaries(db, 'wide');
    expect(performance.now() - t).toBeLessThan(1500);
    const meta = JSON.parse((db.prepare(`SELECT meta FROM files WHERE repo_id='wide' AND path='f0.txt'`).get() as any).meta);
    expect(meta.history).toMatchObject({ commits: 2, createdPath: 'f0.txt' });
  }, 120_000);

  it('keeps a focused file in Ask history answers instead of jumping to another file', async () => {
    const o = newRepo('focus');
    fs.writeFileSync(path.join(o, 'one.js'), 'export function alpha() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(o, 'two.js'), 'export function beta() {\n  return 2;\n}\n');
    commitAll(o, 'add one and two');
    await ingest('focus', o);
    let text = '';
    for await (const ev of answerQuestion(db, new MockProvider(), null, 'focus', { question: 'When was beta added?', focus: { path: 'one.js' } })) if (ev.type === 'token') text += ev.text;
    expect(text).toContain('one.js');
    expect(text).not.toContain('two.js');
  });
});
