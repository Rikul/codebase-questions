import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildImportGraph, groupModules } from '../src/ingest/graph.js';
import { parseFile } from '../src/ingest/parse.js';
import { scanRepo } from '../src/ingest/scan.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/sample-app');

describe('scan + import graph', () => {
  const files = scanRepo(FIXTURE, { maxFileBytes: 1e6, maxFiles: 1000 });
  const facts = new Map(files.map((f) => [f.path, parseFile(f.path, f.lang, f.content)]));
  const graph = buildImportGraph(files, facts, new Map());

  it('scans the fixture', () => {
    expect(files.map((f) => f.path)).toContain('src/index.ts');
    expect(files.find((f) => f.path === 'worker/tasks.py')?.lang).toBe('python');
  });

  it('resolves relative imports to files', () => {
    const e = graph.edges.map((x) => `${x.from}->${x.to}`);
    expect(e).toEqual(
      expect.arrayContaining([
        'src/index.ts->src/routes/users.ts',
        'src/index.ts->src/auth/jwt.ts',
        'src/routes/users.ts->src/services/userService.ts',
        'src/services/userService.ts->src/db/client.ts',
      ]),
    );
    expect([...(graph.external.get('src/db/client.ts') ?? [])]).toContain('pg');
  });

  it('groups files into modules', () => {
    const groups = groupModules(files);
    const ids = groups.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(['src/routes', 'src/db', 'worker']));
  });
});
