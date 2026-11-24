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
  fs.writeFileSync(path.join(dir, 'src/locales/fr.json'), '{"greeting": "Bonjour"}\n');
  let review: Promise<void> = Promise.resolve();
  await analyzeDirectory(db, new MockProvider(), null, 'exp', dir, () => undefined, () => undefined, null, () => undefined, (r) => (review = r));
  await review;
  expect(db.prepare(`SELECT count(*) AS n FROM chunks WHERE repo_id='exp' AND path='src/locales/fr.json'`).get()).toEqual({ n: 0 });

  const data = exportProject(db, 'exp', true);
  expect(data.chunks!.some((c) => c.path === 'src/locales/fr.json')).toBe(true);
  const imported = importProject(db, data);
  expect(fileContent(db, imported, 'src/locales/fr.json')).toContain('Bonjour');
  expect(fileContent(db, imported, 'src/index.ts')).toBeTruthy();
});
