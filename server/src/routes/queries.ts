import fs from 'node:fs';
import type { Architecture, FileNode } from '@cq/shared';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import { repoDir } from '../ingest/pipeline.js';
import { safeJoin } from '../ingest/scan.js';

export function getArchitecture(db: DB, repoId: string): Architecture {
  const repo = db.prepare('SELECT overview FROM repos WHERE id=?').get(repoId) as any;
  const components = (db.prepare('SELECT * FROM components WHERE repo_id=?').all(repoId) as any[]).map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    description: c.description,
    responsibilities: json<string[]>(c.responsibilities, []),
    paths: json<string[]>(c.paths, []),
  }));
  const connections = (db.prepare('SELECT * FROM connections WHERE repo_id=?').all(repoId) as any[]).map((e) => ({
    id: e.id,
    from: e.src,
    to: e.dst,
    kind: e.kind,
    label: e.label,
    description: e.description,
    evidence: json<any[]>(e.evidence, []),
  }));
  return { overview: repo?.overview ?? '', components, connections };
}

export function fileTree(db: DB, repoId: string): FileNode {
  const rows = db.prepare('SELECT path, lang, size, summary FROM files WHERE repo_id=? ORDER BY path').all(repoId) as any[];
  const root: FileNode = { path: '', type: 'dir', children: [] };
  const dirs = new Map<string, FileNode>([['', root]]);
  for (const r of rows) {
    const parts = r.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      let d = dirs.get(p);
      if (!d) {
        d = { path: p, type: 'dir', children: [] };
        dirs.set(p, d);
        cur.children!.push(d);
      }
      cur = d;
    }
    cur.children!.push({ path: r.path, type: 'file', lang: r.lang, size: r.size, summary: r.summary });
  }
  const sort = (n: FileNode) => {
    n.children?.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
    n.children?.forEach(sort);
  };
  sort(root);
  return root;
}

/** File content from the checkout, or reconstructed from indexed chunks (imported projects). */
export function fileContent(db: DB, repoId: string, rel: string): string | null {
  const known = db.prepare('SELECT 1 FROM files WHERE repo_id=? AND path=?').get(repoId, rel);
  if (!known) return null;
  const abs = safeJoin(repoDir(repoId), rel);
  if (abs && fs.existsSync(abs)) {
    const st = fs.lstatSync(abs);
    if (st.isFile()) return fs.readFileSync(abs, 'utf8');
  }
  const chunks = db.prepare('SELECT start_line, end_line, content FROM chunks WHERE repo_id=? AND path=? ORDER BY start_line').all(repoId, rel) as any[];
  if (!chunks.length) return null;
  const lines: string[] = [];
  for (const c of chunks) {
    const cl = String(c.content).split('\n');
    cl.forEach((l, i) => (lines[c.start_line - 1 + i] = l));
  }
  return Array.from(lines, (l) => l ?? '').join('\n');
}

export function snippet(db: DB, repoId: string, rel: string, start?: number, end?: number, pad = 3) {
  const content = fileContent(db, repoId, rel);
  if (content == null) return null;
  const lines = content.split('\n');
  const s = Math.max(1, (start ?? 1) - pad);
  const e = Math.min(lines.length, (end ?? start ?? 1) + pad + (start ? 0 : 20));
  return { path: rel, startLine: s, endLine: e, highlightStart: start ?? null, highlightEnd: end ?? start ?? null, code: lines.slice(s - 1, e).join('\n') };
}
