import type { Category } from '@cq/shared';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import type { EmbeddingProvider } from '../llm/index.js';

export interface RetrievedChunk {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

const STOP = new Set(
  'a an the and or but if then else of to in on at for from by with without how what why where when which who whom does do did is are was were be been being this that these those it its into about can could should would will shall may might must i me my we our you your they them their there here not no yes any all some each every more most other such only own same so than too very just also as please explain show tell code codebase repo repository file files use used using work works'.split(' '),
);

export function tokenize(q: string): string[] {
  const raw = q
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
  const orig = q.match(/[A-Za-z_][\w]{2,}/g)?.filter((t) => /[A-Z_]/.test(t.slice(1))) ?? [];
  return [...new Set([...raw, ...orig.map((o) => o.toLowerCase())])].slice(0, 24);
}

const CATEGORY_TERMS: Record<Category, string[]> = {
  architecture: ['server', 'app', 'router', 'service', 'client', 'config', 'main', 'module'],
  onboarding: ['readme', 'main', 'setup', 'install', 'config', 'start'],
  security: ['auth', 'token', 'password', 'session', 'secret', 'validate', 'sanitize', 'permission', 'crypto', 'jwt', 'cookie', 'csrf', 'cors'],
  api: ['export', 'client', 'request', 'response', 'handler', 'route', 'interface', 'options'],
};

const vecCache = new Map<string, { ids: number[]; vecs: Float32Array[] }>();
export function invalidateVectors(repoId: string) {
  vecCache.delete(repoId);
}

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

export interface RetrieveOptions {
  category: Category;
  focusPaths?: string[];
  embeddings?: EmbeddingProvider | null;
  limit?: number;
}

export async function retrieve(db: DB, repoId: string, question: string, opts: RetrieveOptions): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 12;
  const rank = new Map<number, number>();
  const addRanked = (ids: number[], weight: number) => ids.forEach((id, i) => rank.set(id, (rank.get(id) ?? 0) + weight / (10 + i)));

  // 1. Keyword search (FTS5 BM25, path column weighted higher).
  const terms = tokenize(question);
  const catTerms = CATEGORY_TERMS[opts.category].filter((t) => !terms.includes(t));
  if (terms.length) {
    const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
    try {
      const rows = db
        .prepare(`SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? AND repo_id = ? ORDER BY bm25(chunks_fts, 1.0, 3.0) LIMIT 40`)
        .all(match, repoId) as { id: number }[];
      addRanked(rows.map((r) => r.id), 1.0);
    } catch {
      /* invalid FTS query: ignore */
    }
  }
  if (catTerms.length) {
    const match = catTerms.map((t) => `"${t}"`).join(' OR ');
    const rows = db
      .prepare(`SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? AND repo_id = ? ORDER BY bm25(chunks_fts, 1.0, 3.0) LIMIT 20`)
      .all(match, repoId) as { id: number }[];
    addRanked(rows.map((r) => r.id), 0.1);
  }

  // 2. Vector search when embeddings exist.
  if (opts.embeddings) {
    let cache = vecCache.get(repoId);
    if (!cache) {
      const rows = db.prepare('SELECT id, embedding FROM chunks WHERE repo_id=? AND embedding IS NOT NULL').all(repoId) as { id: number; embedding: Buffer }[];
      cache = {
        ids: rows.map((r) => r.id),
        vecs: rows.map((r) => new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength))),
      };
      vecCache.set(repoId, cache);
    }
    if (cache.ids.length) {
      try {
        const [qv] = await opts.embeddings.embed([question]);
        const scored = cache.ids.map((id, i) => ({ id, s: cosine(qv, cache!.vecs[i]) })).sort((a, b) => b.s - a.s).slice(0, 40);
        addRanked(scored.map((x) => x.id), 1.2);
      } catch {
        /* embedding failure: keyword results only */
      }
    }
  }

  // 3. Category / focus boosts at the file level.
  const boostFiles = new Map<string, number>();
  const metaRows = db.prepare('SELECT path, meta FROM files WHERE repo_id=?').all(repoId) as { path: string; meta: string }[];
  for (const r of metaRows) {
    const m = json<any>(r.meta, {});
    let b = 0;
    if (opts.category === 'security') b += Math.min(0.003, (m.security?.length ?? 0) * 0.0008) + (m.routes?.length ? 0.001 : 0);
    if (opts.category === 'api') b += m.routes?.length ? 0.001 : 0;
    if (opts.category === 'onboarding') b += m.isEntry ? 0.002 : 0;
    if (/^readme/i.test(r.path) && opts.category === 'onboarding') b += 0.004;
    if (m.isTest && !/test/i.test(question)) b -= 0.002;
    if (b) boostFiles.set(r.path, b);
  }
  const focus = opts.focusPaths ?? [];
  if (focus.length) {
    const ph = focus.map(() => '(path = ? OR path LIKE ?)').join(' OR ');
    const params = focus.flatMap((p) => [p, `${p}/%`]);
    const rows = db.prepare(`SELECT id FROM chunks WHERE repo_id=? AND (${ph}) LIMIT 400`).all(repoId, ...params) as { id: number }[];
    const ids = new Set(rows.map((r) => r.id));
    for (const id of ids) rank.set(id, (rank.get(id) ?? 0) + 0.05);
    if (!terms.length) addRanked([...ids].slice(0, 20), 0.5);
  }

  if (!rank.size) {
    // Nothing matched: fall back to README + entry points.
    const rows = db.prepare(`SELECT id FROM chunks WHERE repo_id=? ORDER BY CASE WHEN lower(path) LIKE 'readme%' THEN 0 ELSE 1 END, id LIMIT ?`).all(repoId, limit) as { id: number }[];
    addRanked(rows.map((r) => r.id), 0.5);
  }

  const ids = [...rank.keys()];
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT id, path, start_line AS startLine, end_line AS endLine, content FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Omit<RetrievedChunk, 'score'>[];
  const scored = rows
    .map((r) => ({ ...r, score: (rank.get(r.id) ?? 0) + (boostFiles.get(r.path) ?? 0) }))
    .sort((a, b) => b.score - a.score);
  // Diversify: at most 3 chunks per file.
  const perFile = new Map<string, number>();
  const out: RetrievedChunk[] = [];
  for (const c of scored) {
    const n = perFile.get(c.path) ?? 0;
    if (n >= 3) continue;
    perFile.set(c.path, n + 1);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}
