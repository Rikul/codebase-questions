import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { compactDb, openDb } from '../src/db/index.js';

describe('deleting a repository', () => {
  it('removes its rows and, after compacting, its bytes from the database file', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-db-')), 'codebase.db');
    const db = openDb(file);
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('gone', 'acme/gone', 'https://github.com/acme/gone', 'ready')`).run();
    const ins = db.prepare('INSERT INTO chunks (repo_id, path, start_line, end_line, content) VALUES (?, ?, 1, 1, ?)');
    const secret = 'SECRET_MARKER_7f3a';
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) ins.run('gone', `f${i}.ts`, `${secret} ${'x'.repeat(400)} ${i}`);
    })();
    db.prepare(`DELETE FROM repos WHERE id='gone'`).run();
    expect((db.prepare('SELECT count(*) AS n FROM chunks').get() as any).n).toBe(0);
    expect((db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?`).get(secret) as any).n).toBe(0);

    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const { beforeMb, afterMb } = await compactDb(db, 50);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0); // other work ran while it compacted
    expect(db.pragma('freelist_count', { simple: true })).toBe(0);
    expect(afterMb).toBeLessThan(beforeMb);
    db.close();
    const bytes = Buffer.concat([file, `${file}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)));
    expect(bytes.includes(secret)).toBe(false);
  });

  it('converts a database created without incremental auto-vacuum when it is opened', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-db-')), 'codebase.db');
    const legacy = new Database(file);
    legacy.pragma('journal_mode = WAL');
    legacy.exec('CREATE TABLE old (x)');
    expect(legacy.pragma('auto_vacuum', { simple: true })).toBe(0);
    legacy.close();
    const db = openDb(file);
    expect(db.pragma('auto_vacuum', { simple: true })).toBe(2);
    db.close();
  });
});
