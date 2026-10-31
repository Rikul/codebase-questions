import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Architecture } from '@cq/shared';
import { defaultExpanded, defaultView, findConnection, viewArchitecture } from '@cq/shared';
import { openDb } from '../src/db/index.js';
import { exportProject, importProject } from '../src/export/export.js';
import { buildHierarchy, flatten } from '../src/ingest/hierarchy.js';
import { linkHttpCalls, pathMatches, pathSegments } from '../src/ingest/http.js';
import { parseFile } from '../src/ingest/parse.js';
import { analyzeDirectory } from '../src/ingest/pipeline.js';
import { MockProvider } from '../src/llm/mock.js';
import { getArchitecture } from '../src/routes/queries.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/sample-app');
const ts = (p: string) => ({ path: p, lang: 'typescript' });

describe('component hierarchy', () => {
  it('uses packages as the top level in a workspace', () => {
    const files = [
      { path: 'package.json', lang: 'json', content: JSON.stringify({ name: 'root', workspaces: ['server', 'web'] }) },
      { path: 'server/package.json', lang: 'json', content: JSON.stringify({ name: '@x/server' }) },
      ts('server/src/index.ts'), ts('server/src/routes/a.ts'), ts('server/src/routes/b.ts'), ts('server/src/db/index.ts'),
      { path: 'web/package.json', lang: 'json', content: JSON.stringify({ name: '@x/web' }) },
      ts('web/src/main.tsx'), ts('web/src/components/A.tsx'), ts('web/src/components/B.tsx'),
      ts('shared/src/index.ts'),
    ];
    const tree = buildHierarchy(files);
    expect(tree.map((n) => [n.name, n.kind])).toEqual([['@x/server', 'package'], ['@x/web', 'package'], ['Shared', 'module']]);
    const server = tree[0];
    expect(flatten(server.children).map(({ node }) => node.path)).toEqual(expect.arrayContaining(['server/src/routes', 'server/src/db']));
    // Every code file has exactly one owner.
    const owned = flatten(tree).flatMap(({ node }) => node.ownFiles);
    expect(new Set(owned).size).toBe(owned.length);
    for (const f of files.filter((x) => x.lang === 'typescript')) expect(owned).toContain(f.path);
  });

  it('uses modules as the top level for a single package, nesting subdirectories', () => {
    const tree = buildHierarchy([
      { path: 'package.json', lang: 'json', content: '{"name":"app"}' },
      ts('src/index.ts'), ts('src/routes/users.ts'), ts('src/routes/admin/x.ts'), ts('src/routes/admin/y.ts'), ts('src/db/client.ts'), ts('lib/util.ts'),
    ]);
    expect(tree.every((n) => n.kind !== 'package')).toBe(true);
    const routes = flatten(tree).find(({ node }) => node.path === 'src/routes')!.node;
    expect(routes.children.map((c) => c.path)).toEqual(['src/routes/admin']);
  });
});

describe('HTTP call matching', () => {
  it('normalizes parameters and allows a mount prefix on the client side', () => {
    expect(pathSegments('/repos/${repo.id}/reviews?x=1')).toEqual(['repos', '*', 'reviews']);
    expect(pathSegments('/repos/:id/reviews')).toEqual(['repos', '*', 'reviews']);
    expect(pathMatches(pathSegments('/api/users'), pathSegments('/users'))).toBe(true);
    expect(pathMatches(pathSegments('/repos/abc/reviews'), pathSegments('/repos/:id'))).toBe(false);
    expect(pathMatches(pathSegments('/x/y/z/users'), pathSegments('/users'))).toBe(false);
  });

  it('extracts API calls but not route declarations or navigation', () => {
    const fx = parseFile('web/a.ts', 'typescript', "fetch('/api/users');\napi<X>(`/repos/${id}/files?path=${p}`);\nnavigate('/home');\nimport x from '/abs.js';\n");
    expect(fx.httpCalls.map((c) => c.path)).toEqual(['/api/users', '/repos/${id}/files?path=${p}']);
    const server = parseFile('server/r.ts', 'typescript', "router.get('/users', h);\n");
    expect(server.httpCalls).toEqual([]);
  });

  it('links a client call to the route that handles it', () => {
    const facts = new Map([
      ['web/App.tsx', parseFile('web/App.tsx', 'typescript', "fetch('/api/users/' + id);\nfetch('/api/users');\n")],
      ['src/routes/users.ts', parseFile('src/routes/users.ts', 'typescript', "usersRouter.get('/users/:id', h);\nusersRouter.get('/users', h);\n")],
    ]);
    const links = linkHttpCalls(facts);
    expect(links).toContainEqual(expect.objectContaining({ client: 'web/App.tsx', server: 'src/routes/users.ts', route: '/users' }));
  });
});

describe('architecture views', () => {
  const comp = (id: string, parentId?: string, extra: object = {}) => ({ id, name: id, type: 'service' as const, description: '', responsibilities: [], paths: [id], ...(parentId ? { parentId } : {}), ...extra });
  const link = (from: string, to: string, weight = 1) => ({ id: `${from}--${to}`, from, to, kind: 'calls' as const, label: '', description: '', evidence: [{ path: `${from}.ts`, startLine: 1 }], weight });
  const arch: Architecture = {
    overview: '',
    components: [comp('pkg', undefined, { expandByDefault: true }), comp('a', 'pkg'), comp('b', 'pkg'), comp('a1', 'a'), comp('a2', 'a'), comp('c'), comp('d'), comp('util'), comp('e'), comp('f'), comp('g')],
    connections: [link('a1', 'b', 2), link('a2', 'b', 3), link('a1', 'a2'), link('c', 'd'), link('d', 'b'), link('c', 'b'), link('a1', 'util'), link('b', 'util'), link('c', 'util'), link('d', 'util')],
  };

  it('lifts connections to visible components and merges them', () => {
    const v = viewArchitecture(arch, defaultExpanded(arch));
    expect(v.components.find((c) => c.id === 'pkg')).toMatchObject({ container: true });
    expect(v.components.some((c) => c.id === 'a1')).toBe(false);
    const ab = v.connections.find((e) => e.from === 'a' && e.to === 'b')!;
    expect(ab.weight).toBe(5);
    // a1 → a2 is internal to a once a is collapsed.
    expect(v.connections.some((e) => e.from === e.to)).toBe(false);
    // Fully collapsed: pkg stands in for a, b and their children.
    const collapsed = viewArchitecture(arch, new Set());
    expect(collapsed.visibleOf.get('a1')).toBe('pkg');
    expect(collapsed.connections.find((e) => e.from === 'c' && e.to === 'pkg')).toBeTruthy();
  });

  it('flags hub targets and edges implied by longer paths', () => {
    const v = viewArchitecture(arch, defaultExpanded(arch));
    expect(v.connections.filter((e) => e.to === 'util').every((e) => e.hub)).toBe(true);
    expect(v.connections.find((e) => e.from === 'c' && e.to === 'b')!.redundant).toBe(true);
    expect(v.connections.find((e) => e.from === 'c' && e.to === 'd')!.redundant).toBeFalsy();
    expect(defaultView(arch).connections.some((e) => e.to === 'util' || (e.from === 'c' && e.to === 'b'))).toBe(false);
  });

  it('finds merged connections by view id', () => {
    const e = findConnection(arch, 'a--b')!;
    expect(e).toMatchObject({ from: 'a', to: 'b', weight: 5 });
    expect(e.evidence.length).toBe(2);
    expect(findConnection(arch, 'b--a')).toBeNull();
  });
});

describe('static architecture from the sample app', () => {
  const db = openDb(':memory:');
  beforeAll(async () => {
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('s', 'acme/sample-app', 'https://github.com/acme/sample-app', 'running')`).run();
    await analyzeDirectory(db, new MockProvider(), null, 's', FIXTURE, () => undefined);
  });

  it('links the web client to the users routes over HTTP', () => {
    const arch = getArchitecture(db, 's');
    const http = arch.connections.filter((e) => e.kind === 'http');
    expect(http.length).toBeGreaterThan(0);
    const name = (id: string) => arch.components.find((c) => c.id === id)!.paths[0] ?? '';
    expect(http.some((e) => name(e.from).startsWith('web') && name(e.to).startsWith('src'))).toBe(true);
  });

  it('assigns every code file to a component in the tree', () => {
    const arch = getArchitecture(db, 's');
    const ids = new Set(arch.components.map((c) => c.id));
    const rows = db.prepare(`SELECT path, json_extract(meta, '$.component') AS c FROM files WHERE repo_id='s' AND lang IN ('typescript','tsx','python')`).all() as any[];
    for (const r of rows) expect(ids.has(r.c)).toBe(true);
  });

  it('keeps the tree and weights through export and import', () => {
    const id = importProject(db, JSON.parse(JSON.stringify(exportProject(db, 's', true))));
    const a = getArchitecture(db, 's');
    const b = getArchitecture(db, id);
    expect(b.components.map((c) => c.parentId)).toEqual(a.components.map((c) => c.parentId));
    expect(b.connections.map((e) => e.weight)).toEqual(a.connections.map((e) => e.weight));
  });
});

describe('LLM component labels', () => {
  it('adds labels and summaries next to the static names', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('l', 'acme/sample-app', 'https://github.com/acme/sample-app', 'running')`).run();
    const mock = new MockProvider();
    const llm = Object.create(mock) as import('../src/llm/provider.js').LLMProvider;
    Object.defineProperty(llm, 'name', { value: 'test' });
    let asked: string[] = [];
    llm.completeJSON = async <T,>(opts: import('../src/llm/provider.js').JSONOptions<T>): Promise<T> => {
      if (opts.name !== 'component_labels') return mock.completeJSON(opts);
      const text = String(opts.messages[0].content);
      asked = [...text.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]);
      const [first, second] = asked;
      const staticName = text.match(new RegExp(`- id: ${second}\\n  static name: (.+)`))![1];
      return opts.schema.parse({
        components: [
          { id: first, label: 'Request Handling', summary: 'Handles requests.' },
          { id: second, label: staticName, summary: 'Same name.' },
          { id: 'not-a-component', label: 'Ghost', summary: 'x' },
        ],
      });
    };
    await analyzeDirectory(db, llm, null, 'l', FIXTURE, () => undefined);
    const arch = getArchitecture(db, 'l');
    const [first, second] = asked;
    const a = arch.components.find((c) => c.id === first)!;
    expect(a).toMatchObject({ label: 'Request Handling', summary: 'Handles requests.' });
    expect(a.name).not.toBe('Request Handling');
    // A label that only repeats the static name is dropped; the summary is kept.
    expect(arch.components.find((c) => c.id === second)).toMatchObject({ summary: 'Same name.' });
    expect(arch.components.find((c) => c.id === second)!.label).toBeUndefined();
    // External systems are not sent for labelling.
    expect(asked.every((id) => arch.components.find((c) => c.id === id)!.paths.length > 0 || arch.components.some((c) => c.parentId === id))).toBe(true);
    db.close();
  });
});
