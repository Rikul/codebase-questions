import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
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

  it('stops compacting when a step frees nothing (database not in incremental mode)', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (x)');
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) db.prepare('INSERT INTO t VALUES (?)').run('x'.repeat(400));
    })();
    db.exec('DELETE FROM t');
    expect(db.pragma('freelist_count', { simple: true })).toBeGreaterThan(0);
    await expect(compactDb(db, 10)).resolves.toBeDefined();
  });

  it('still opens a legacy database when the one-time conversion fails', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-db-')), 'codebase.db');
    const legacy = new Database(file);
    legacy.exec('CREATE TABLE old (x)');
    legacy.close();
    const original = Database.prototype.exec;
    // What a locked database or a full disk does to the VACUUM.
    const spy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      if (sql === 'VACUUM') throw new Error('database or disk is full');
      return original.call(this, sql);
    });
    try {
      const db = openDb(file);
      expect(db.pragma('auto_vacuum', { simple: true })).toBe(0); // retried at the next open
      expect(db.prepare(`SELECT count(*) AS n FROM repos`).get()).toEqual({ n: 0 });
      db.close();
    } finally {
      spy.mockRestore();
    }
    const db = openDb(file);
    expect(db.pragma('auto_vacuum', { simple: true })).toBe(2);
    db.close();
  });

  it('upgrades the keyword-search triggers so chunks marked not searchable stay out', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-db-')), 'codebase.db');
    // A database from before the searchable column, with the old unconditional trigger.
    openDb(file).close();
    const old = new Database(file);
    old.exec(`DROP TRIGGER chunks_fts_ai; CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, content, path, repo_id) VALUES (new.id, new.content, new.path, new.repo_id); END;`);
    old.close();
    const db = openDb(file);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all().map((r: any) => r.name)).toEqual(['chunks_fts_ad', 'chunks_fts_ai']);
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('t', 't', 'upload:t', 'ready')`).run();
    db.prepare(`INSERT INTO chunks (repo_id, path, start_line, end_line, content, searchable) VALUES ('t', 'a.json', 1, 1, 'Bonjour', 0), ('t', 'b.ts', 1, 1, 'Hello', 1)`).run();
    expect(db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'Bonjour'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'Hello'`).get()).toEqual({ n: 1 });
    db.prepare(`DELETE FROM chunks WHERE repo_id='t'`).run(); // deleting an unindexed row must not touch the index
    expect(db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'Hello'`).get()).toEqual({ n: 0 });
    db.close();
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
