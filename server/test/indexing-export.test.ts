import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

// Export reads files from the checkout under DATA_DIR, which is read when the app modules load.
process.env.DATA_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-index-export-')), 'data');
const { openDb } = await import('../src/db/index.js');
const { analyzeDirectory } = await import('../src/ingest/pipeline.js');
const { exportProject, importProject } = await import('../src/export/export.js');
const { MockProvider } = await import('../src/llm/mock.js');
const { repoDir } = await import('../src/paths.js');
const { fileContent } = await import('../src/routes/queries.js');

it('exports the source of files left out of search, so an import can still open them', async () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('exp', 'app', 'upload:app', 'running')`).run();
  const dir = repoDir('exp');
  fs.cpSync(path.join(import.meta.dirname, 'fixtures/sample-app'), dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/locales'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/locales/en.json'), '{"greeting": "Hello"}\n');
  fs.writeFileSync(path.join(dir, 'src/locales/fr.json'), '{"greeting": "Bonjour"}\n');
  let review: Promise<void> = Promise.resolve();
  await analyzeDirectory(db, new MockProvider(), null, 'exp', dir, () => undefined, () => undefined, null, () => undefined, (r) => (review = r));
  await review;
  expect(db.prepare(`SELECT searchable FROM chunks WHERE repo_id='exp' AND path='src/locales/fr.json'`).get()).toEqual({ searchable: 0 });

  const data = exportProject(db, 'exp', true);
  expect(data.chunks!.find((c) => c.path === 'src/locales/fr.json')).toMatchObject({ searchable: false });
  const imported = importProject(db, data);
  expect(fileContent(db, imported, 'src/locales/fr.json')).toContain('Bonjour');
  // Still out of keyword search in the imported copy.
  const hits = db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'Bonjour' AND repo_id=?`).get(imported);
  expect(hits).toEqual({ n: 0 });
  expect(fileContent(db, imported, 'src/index.ts')).toBeTruthy();
});

it('keeps summaries of left-out files out of search when importing an export without source', async () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('nos', 'app', 'upload:app', 'running')`).run();
  const dir = repoDir('nos');
  fs.cpSync(path.join(import.meta.dirname, 'fixtures/sample-app'), dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/locales'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/locales/en.json'), '{"greeting": "Hello"}\n');
  fs.writeFileSync(path.join(dir, 'src/locales/fr.json'), '{"greeting": "Bonjour"}\n');
  let review: Promise<void> = Promise.resolve();
  await analyzeDirectory(db, new MockProvider(), null, 'nos', dir, () => undefined, () => undefined, null, () => undefined, (r) => (review = r));
  await review;
  db.prepare(`UPDATE files SET summary='French strings zzfrench' WHERE repo_id='nos' AND path='src/locales/fr.json'`).run();
  db.prepare(`UPDATE files SET summary='English strings zzenglish' WHERE repo_id='nos' AND path='src/locales/en.json'`).run();

  const data = exportProject(db, 'nos', false);
  expect(data.chunks ?? []).toHaveLength(0);
  const imported = importProject(db, data);
  const hits = (q: string) => (db.prepare(`SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ? AND repo_id=?`).get(q, imported) as { n: number }).n;
  expect(hits('zzfrench')).toBe(0);
  expect(hits('zzenglish')).toBe(1);
});
