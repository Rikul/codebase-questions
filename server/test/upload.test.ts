import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Config is read when the app modules load, so set it before importing them.
process.env.DATA_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-upload-')), 'data');
process.env.AUTH_DISABLED = 'true';
const { Auth } = await import('../src/auth.js');
const { openDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/index.js');
const { runJob } = await import('../src/ingest/pipeline.js');
const { cleanEntryPath, extractZip } = await import('../src/ingest/upload.js');
const { MockProvider } = await import('../src/llm/mock.js');
const { repoDir } = await import('../src/paths.js');
const { verifyUploadedHistory } = await import('../src/history/git.js');

/** Build a ZIP in memory. Entries may be deflated, stored, symlinks, or lie about their size. */
function zip(entries: { name: string; data?: string | Buffer; store?: boolean; symlink?: boolean; declaredSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data ?? '');
    const method = e.store || e.symlink ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const size = e.declaredSize ?? raw.length;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x800, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(size, 22);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(((e.symlink ? 0o120777 : 0o100755) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    cens.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const limits = { maxBytes: 10 * 1024 * 1024, maxFiles: 1000, maxFileBytes: 100_000 };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-up-')), 'out');
const list = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => !e.isDirectory()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();

describe('entry paths', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['./src//a.ts', 'src/a.ts'],
    ['src\\win\\a.ts', 'src/win/a.ts'],
    ['../evil.sh', null],
    ['a/../../evil', null],
    ['/etc/passwd', null],
    ['C:/x.txt', null],
    ['repo/.git/config', null],
    ['__MACOSX/._a.ts', null],
    ['a/.DS_Store', null],
    ['a\0b', null],
  ])('%s → %s', (raw, want) => expect(cleanEntryPath(raw)).toBe(want));
});

describe('ZIP extraction', () => {
  it('writes only safe source files, stripping the shared top folder', async () => {
    const dest = tmp();
    const outside = path.join(path.dirname(dest), 'evil.txt');
    const r = await extractZip(
      zip([
        { name: 'proj-main/', store: true },
        { name: 'proj-main/src/index.ts', data: 'export const a = 1;\n'.repeat(50) },
        { name: 'proj-main/README.md', data: '# Proj\n', store: true },
        { name: 'proj-main/../evil.txt', data: 'x' },
        { name: 'proj-main/.git/config', data: '[core]\n\tfsmonitor = touch /tmp/pwned\n' },
        { name: 'proj-main/node_modules/dep/index.js', data: 'module.exports = 1' },
        { name: 'proj-main/link', data: '/etc/passwd', symlink: true },
        { name: 'proj-main/big.txt', data: 'x'.repeat(200_000) },
      ]),
      dest,
      limits,
    );
    expect(list(dest)).toEqual(['README.md', 'src/index.ts']);
    expect(r).toMatchObject({ files: 2, root: 'proj-main' });
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'src/index.ts'), 'utf8')).toContain('export const a = 1;');
    expect(fs.statSync(path.join(dest, 'src/index.ts')).mode & 0o111).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/symlink/);
    expect(r.warnings.join(' ')).toMatch(/MAX_FILE_BYTES/);
  });

  it('refuses archives over the size limit before writing anything', async () => {
    const dest = tmp();
    await expect(extractZip(zip([{ name: 'a.ts', data: 'x', declaredSize: 50_000 }, { name: 'b.ts', data: 'y', declaredSize: 50_000 }]), dest, { ...limits, maxBytes: 60_000 })).rejects.toThrow(/MAX_REPO_MB/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('keeps the first MAX_REPO_FILES files of a larger upload, like a clone', async () => {
    const dest = tmp();
    const capped = await extractZip(zip([{ name: 'b.ts', data: 'y' }, { name: 'a.ts', data: 'x' }]), dest, { ...limits, maxFiles: 1 });
    expect(capped.files).toBe(1);
    expect(capped.warnings.join(' ')).toMatch(/only the first 1 \(MAX_REPO_FILES\)/);
    expect(fs.readdirSync(dest)).toEqual(['a.ts']);
  });

  it('does not inflate past the declared size', async () => {
    const dest = tmp();
    // Declares 10 bytes but inflates to 50 000: the entry is not written.
    await expect(extractZip(zip([{ name: 'bomb.ts', data: 'a'.repeat(50_000), declaredSize: 10 }]), dest, limits)).rejects.toThrow(/could be read/);
  });

  it('does not write stored entries whose real size exceeds the declared size', async () => {
    const dest = tmp();
    // Many stored entries that each claim 1 byte would pass the MAX_REPO_MB check on declared sizes.
    const liars = Array.from({ length: 5 }, (_, i) => ({ name: `big${i}.ts`, data: 'x'.repeat(90_000), store: true, declaredSize: 1 }));
    const r = await extractZip(zip([{ name: 'ok.ts', data: 'export const ok = 1;\n', store: true }, ...liars]), dest, { ...limits, maxBytes: 100_000 });
    expect(list(dest)).toEqual(['ok.ts']);
    expect(r.bytes).toBeLessThan(100);
    expect(r.warnings.join(' ')).toMatch(/Could not write 5 file/);
  });

  it('rejects files that are not ZIP archives', async () => {
    await expect(extractZip(Buffer.from('not a zip at all'), tmp(), limits)).rejects.toThrow(/Not a ZIP/);
  });
});

describe('upload route', () => {
  const setup = () => {
    const db = openDb(':memory:');
    const app = createApp(db, new MockProvider(), null, new Auth(db, crypto.randomBytes(32)));
    return { db, app };
  };

  it('creates a repository from a ZIP and analyzes it without cloning', async () => {
    const { db, app } = setup();
    const archive = zip([
      { name: 'shop-main/package.json', data: JSON.stringify({ name: 'shop', dependencies: { express: '^4' } }) },
      { name: 'shop-main/src/server.js', data: "const express = require('express');\nconst app = express();\napp.get('/items', (req, res) => res.json([]));\n" },
    ]);
    const res = await request(app).post('/api/repos/upload').attach('file', archive, 'shop-main.zip');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { repoId, jobId } = res.body;
    const repo = db.prepare('SELECT name, url, status FROM repos WHERE id=?').get(repoId);
    expect(repo).toMatchObject({ name: 'shop-main', url: 'upload:shop-main.zip' });
    expect(list(repoDir(repoId))).toEqual(['package.json', 'src/server.js']);

    await runJob(db, new MockProvider(), null, jobId, repoId);
    // The code review runs after the job hands back the queue; the repo is ready once it finishes.
    await vi.waitFor(() => expect(db.prepare('SELECT status, commit_sha FROM repos WHERE id=?').get(repoId)).toMatchObject({ status: 'ready', commit_sha: null }));
    expect((db.prepare('SELECT path FROM files WHERE repo_id=? ORDER BY path').all(repoId) as any[]).map((f) => f.path)).toEqual(['package.json', 'src/server.js']);
    // Re-analysis reuses the uploaded files.
    await runJob(db, new MockProvider(), null, crypto.randomUUID(), repoId);
    await vi.waitFor(() => expect(db.prepare('SELECT status FROM repos WHERE id=?').get(repoId)).toMatchObject({ status: 'ready' }));
  });

  it('creates a repository from folder files and their relative paths', async () => {
    const { db, app } = setup();
    const res = await request(app)
      .post('/api/repos/upload')
      .field('paths', JSON.stringify(['tool/main.py', 'tool/lib/util.py', 'tool/.git/HEAD']))
      .attach('files', Buffer.from('from lib.util import f\nf()\n'), 'main.py')
      .attach('files', Buffer.from('def f():\n    return 1\n'), 'util.py')
      .attach('files', Buffer.from('ref: refs/heads/main\n'), 'HEAD');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(db.prepare('SELECT name, url FROM repos WHERE id=?').get(res.body.repoId)).toEqual({ name: 'tool', url: 'upload:tool/' });
    expect(list(repoDir(res.body.repoId))).toEqual(['lib/util.py', 'main.py']);
  });

  it('rejects bad uploads without creating a repository', async () => {
    const { db, app } = setup();
    expect((await request(app).post('/api/repos/upload').attach('file', Buffer.from('hello'), 'x.zip')).body.error).toMatch(/Not a ZIP/);
    expect((await request(app).post('/api/repos/upload').field('paths', '["a.py"]').attach('files', Buffer.from('1'), 'a.py').attach('files', Buffer.from('2'), 'b.py')).status).toBe(400);
    expect((await request(app).post('/api/repos/upload').field('name', 'x')).body.error).toMatch(/Choose a .zip/);
    expect((db.prepare('SELECT count(*) AS n FROM repos').get() as any).n).toBe(0);
  });
});

describe('uploaded git history', () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'd@x', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'd@x' };
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const marker = path.join(os.tmpdir(), `cq-pwned-${process.pid}`);

  /** A project folder with two commits and a hostile .git config and hook. */
  function project(packed: boolean) {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-gitup-')), 'proj');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, 'src/app.js'), 'function start() {\n  return 1;\n}\nmodule.exports = { start };\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'feat: add app']);
    fs.appendFileSync(path.join(dir, 'src/app.js'), '// fixed\n');
    git(dir, ['commit', '-q', '-am', 'fix: tweak app']);
    if (packed) git(dir, ['gc', '-q']);
    fs.appendFileSync(path.join(dir, '.git/config'), `[core]\n\tfsmonitor = touch ${marker}\n[diff]\n\texternal = touch ${marker}\n`);
    fs.writeFileSync(path.join(dir, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.git/objects/info/alternates'), '/etc\n');
    return dir;
  }
  const zipDir = (dir: string, drop: (rel: string) => boolean = () => false) =>
    zip(list(dir).filter((rel) => !drop(rel)).map((rel) => ({ name: `proj/${rel}`, data: fs.readFileSync(path.join(dir, rel)) })));
  const historyLimits = { ...limits, maxHistoryBytes: 50 * 1024 * 1024 };

  it.each([['loose objects', false], ['packed objects', true]])('keeps the history of a ZIP with its .git folder (%s), without its config or hooks', async (_, packed) => {
    const db = openDb(':memory:');
    const app = createApp(db, new MockProvider(), null, new Auth(db, crypto.randomBytes(32)));
    const res = await request(app).post('/api/repos/upload').attach('file', zipDir(project(packed as boolean)), 'proj.zip');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { repoId, jobId } = res.body;
    const dir = repoDir(repoId);
    expect(fs.readFileSync(path.join(dir, '.git/config'), 'utf8')).not.toMatch(/fsmonitor|external/);
    expect(fs.existsSync(path.join(dir, '.git/hooks'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.git/objects/info/alternates'))).toBe(false);

    await runJob(db, new MockProvider(), null, jobId, repoId);
    await vi.waitFor(() => expect(db.prepare('SELECT status FROM repos WHERE id=?').get(repoId)).toMatchObject({ status: 'ready' }));
    const commits = db.prepare('SELECT subject, type FROM commits WHERE repo_id=? ORDER BY seq').all(repoId);
    expect(commits).toEqual([{ subject: 'fix: tweak app', type: 'fix' }, { subject: 'feat: add app', type: 'feat' }]);
    expect((db.prepare(`SELECT count(*) AS n FROM file_commits WHERE repo_id=? AND path='src/app.js'`).get(repoId) as any).n).toBe(2);
    expect(fs.existsSync(marker)).toBe(false);
    // The scanner never indexes .git.
    expect((db.prepare(`SELECT count(*) AS n FROM files WHERE repo_id=? AND path LIKE '.git/%'`).get(repoId) as any).n).toBe(0);
  });

  it('drops the history when objects are missing, and analysis carries on', async () => {
    const src = project(false);
    const blob = git(src, ['rev-parse', 'HEAD:src/app.js']).trim();
    const dest = tmp();
    const r = await extractZip(zipDir(src, (rel) => rel === `.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`), dest, historyLimits);
    expect(r.history).toBe(true);
    const v = await verifyUploadedHistory(dest);
    expect(v).toMatchObject({ history: null, warning: expect.stringMatching(/incomplete or unreadable/) });
    expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
    expect(list(dest)).toEqual(['src/app.js']);
  });

  it('does not keep history over MAX_HISTORY_MB, with HISTORY_DEPTH=-1, or with a bad HEAD', async () => {
    const src = project(true);
    const over = await extractZip(zipDir(src), tmp(), { ...limits, maxHistoryBytes: 10 });
    expect(over).toMatchObject({ history: false, warnings: [expect.stringMatching(/MAX_HISTORY_MB/)] });
    const off = await extractZip(zipDir(src), tmp(), limits);
    expect(off).toMatchObject({ history: false, warnings: [] });
    fs.writeFileSync(path.join(src, '.git/HEAD'), 'ref: ../../../etc/passwd\n');
    const dest = tmp();
    const bad = await extractZip(zipDir(src), dest, historyLimits);
    expect(bad).toMatchObject({ history: false, warnings: [expect.stringMatching(/unexpected HEAD/)] });
    expect(fs.existsSync(path.join(dest, '.git'))).toBe(false);
  });

  it('drops nested .git folders (submodules, vendored checkouts)', async () => {
    const dest = tmp();
    const r = await extractZip(zip([{ name: 'p/src/a.ts', data: 'x' }, { name: 'p/lib/sub/.git/HEAD', data: 'ref: refs/heads/main\n' }]), dest, historyLimits);
    expect(r.history).toBe(false);
    expect(list(dest)).toEqual(['src/a.ts']);
  });
});
