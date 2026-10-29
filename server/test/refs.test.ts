import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { analyzeDirectory } from '../src/ingest/pipeline.js';
import { stripNonCode } from '../src/ingest/refs.js';
import { MockProvider } from '../src/llm/mock.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/sample-app');

describe('symbol ranges and references', () => {
  const db = openDb(':memory:');
  beforeAll(async () => {
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('r', 'acme/sample', 'https://x/y', 'running')`).run();
    await analyzeDirectory(db, new MockProvider(), null, 'r', FIXTURE, () => undefined);
  });
  const sym = (p: string, n: string) => db.prepare('SELECT * FROM symbols WHERE repo_id=? AND path=? AND name=?').get('r', p, n) as any;
  const refs = (sql: string, ...a: unknown[]) => db.prepare(`SELECT * FROM refs WHERE repo_id='r' AND ${sql}`).all(...a) as any[];

  it('computes symbol ranges', () => {
    expect(sym('src/services/userService.ts', 'searchUsers')).toMatchObject({ line: 8, end_line: 12, kind: 'function' });
    expect(sym('src/routes/users.ts', 'GET /users/:id')).toMatchObject({ kind: 'route', line: 6, end_line: 8 });
    expect(sym('worker/tasks.py', 'send_welcome_email')).toMatchObject({ line: 8, end_line: 10 });
  });

  it('finds callers with their enclosing symbol', () => {
    const callers = refs(`target_path='src/services/userService.ts' AND name='getUser' AND kind='call'`);
    expect(callers).toEqual([expect.objectContaining({ path: 'src/routes/users.ts', line: 7, from_symbol: 'GET /users/:id', confidence: 'import' })]);
  });

  it('finds callees inside a function, including external packages', () => {
    const inSearch = refs(`path='src/services/userService.ts' AND line BETWEEN 8 AND 12`);
    expect(inSearch).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'pool', target_path: 'src/db/client.ts', target_line: 3 })]));
    const ext = refs(`path='src/db/client.ts' AND name='Pool'`);
    expect(ext.some((r) => r.target_path === 'pkg:pg' && r.kind === 'call')).toBe(true);
  });

  it('ignores identifiers in strings and comments', () => {
    expect(stripNonCode("a('pool') // pool\nb", 'typescript')).not.toContain('pool');
    expect(stripNonCode('x = "pool"  # pool\ny', 'python').includes('pool')).toBe(false);
  });
});
