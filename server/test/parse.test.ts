import { describe, expect, it } from 'vitest';
import { parseFile, parseManifest } from '../src/ingest/parse.js';
import { parseRepoUrl } from '../src/ingest/clone.js';
import { chunkFile } from '../src/ingest/chunk.js';

describe('parseFile', () => {
  it('extracts JS imports, exported symbols, routes, env vars and security signals', () => {
    const src = [
      "import express from 'express';",
      "import { pool } from './db';",
      "const x = require('lodash');",
      'export async function getUser(id) {}',
      'export class Repo {}',
      "app.get('/users/:id', handler);",
      "router.post('/login', login);",
      'const url = process.env.DATABASE_URL;',
      'pool.query("SELECT * FROM t WHERE a = \'" + q + "\'");',
      'el.innerHTML = html;',
    ].join('\n');
    const f = parseFile('src/a.ts', 'typescript', src);
    expect(f.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['express', './db', 'lodash']));
    expect(f.symbols.filter((s) => s.exported).map((s) => s.name)).toEqual(expect.arrayContaining(['getUser', 'Repo']));
    expect(f.routes).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'GET', path: '/users/:id', line: 6 })]));
    expect(f.envVars.map((e) => e.detail)).toContain('DATABASE_URL');
    expect(f.security.map((s) => s.kind)).toEqual(expect.arrayContaining(['sql-concat', 'xss-sink']));
  });

  it('extracts Python imports, defs and Flask routes', () => {
    const src = "import os, sys\nfrom .models import User\n\n@app.route('/x')\ndef view():\n    return os.environ.get('SECRET_KEY')\n";
    const f = parseFile('app/views.py', 'python', src);
    expect(f.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['os', 'sys', '.models']));
    expect(f.symbols.map((s) => s.name)).toContain('view');
    expect(f.routes[0]).toMatchObject({ path: '/x' });
    expect(f.envVars.map((e) => e.detail)).toContain('SECRET_KEY');
  });

  it('extracts Go imports', () => {
    const src = 'package main\n\nimport (\n  "fmt"\n  "github.com/acme/app/internal/db"\n)\n\nfunc main() {}\n';
    const f = parseFile('cmd/app/main.go', 'go', src);
    expect(f.imports.map((i) => i.spec)).toEqual(['fmt', 'github.com/acme/app/internal/db']);
    expect(f.isEntry).toBe(true);
  });
});

describe('parseManifest', () => {
  it('reads package.json and requirements.txt', () => {
    const pkg = parseManifest('package.json', JSON.stringify({ dependencies: { express: '^4' }, devDependencies: { vitest: '1' } }));
    expect(pkg).toEqual([
      expect.objectContaining({ name: 'express', dev: false }),
      expect.objectContaining({ name: 'vitest', dev: true }),
    ]);
    const req = parseManifest('requirements.txt', 'celery==5.3\n# comment\nredis>=5\n');
    expect(req.map((d) => d.name)).toEqual(['celery', 'redis']);
  });
});

describe('parseRepoUrl', () => {
  it('normalizes GitHub URLs and shorthand', () => {
    expect(parseRepoUrl('expressjs/cors')).toMatchObject({ url: 'https://github.com/expressjs/cors', name: 'expressjs/cors' });
    expect(parseRepoUrl('https://github.com/a/b.git')).toMatchObject({ url: 'https://github.com/a/b' });
    expect(parseRepoUrl('https://github.com/a/b/tree/dev')).toMatchObject({ url: 'https://github.com/a/b', branch: 'dev' });
    expect(parseRepoUrl('https://gitlab.com/g/p#v1.2')).toMatchObject({ branch: 'v1.2' });
  });
  it('rejects unsafe URLs', () => {
    expect(() => parseRepoUrl('http://github.com/a/b')).toThrow();
    expect(() => parseRepoUrl('file:///etc/passwd')).toThrow();
    expect(() => parseRepoUrl('https://user:pw@github.com/a/b')).toThrow();
    expect(() => parseRepoUrl('https://github.com/a/b#--upload-pack=x;rm')).toThrow();
  });
});

describe('chunkFile', () => {
  it('splits long files into overlapping chunks covering every line', () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const chunks = chunkFile('a.txt', content);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(500);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine + 1);
  });
});
