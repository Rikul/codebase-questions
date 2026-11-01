import type { CommitList, CommitListItem, CommitType, RepoStats, SizeBucket } from '@cq/shared';
import { COMMIT_TYPES, SIZE_BUCKETS } from '@cq/shared';
import type { DB } from '../db/index.js';
import { historyAvailable, historyMeta } from './index.js';
import { commitTypeOf } from './types.js';

/** Fill stats and types for commits indexed by older versions (idempotent; cheap when nothing is missing). */
export function backfillCommitStats(db: DB, repoId: string) {
  const missing = db.prepare('SELECT sha, subject FROM commits WHERE repo_id=? AND (type IS NULL OR added IS NULL)').all(repoId) as { sha: string; subject: string }[];
  if (!missing.length) return;
  const sums = db.prepare('SELECT coalesce(sum(added),0) AS a, coalesce(sum(deleted),0) AS d, count(*) AS n FROM file_commits WHERE repo_id=? AND sha=?');
  const upd = db.prepare(`UPDATE commits SET added=?, deleted=?, files=?, type=coalesce(type, ?), type_source=coalesce(type_source, 'rule') WHERE repo_id=? AND sha=?`);
  db.transaction(() => {
    for (const c of missing) {
      const s = sums.get(repoId, c.sha) as { a: number; d: number; n: number };
      upd.run(s.a, s.d, s.n, commitTypeOf(c.subject), repoId, c.sha);
    }
  })();
}

export interface CommitFilter {
  types?: CommitType[];
  sizes?: SizeBucket[];
  minLines?: number;
  maxLines?: number;
  /** Text in the subject or body. */
  q?: string;
  author?: string;
  /** Commits that touched this file or directory. */
  path?: string;
  since?: string;
  until?: string;
  sort?: 'newest' | 'oldest' | 'largest';
  limit?: number;
  offset?: number;
}

const LINES = '(coalesce(c.added,0) + coalesce(c.deleted,0))';

function where(repoId: string, f: CommitFilter): { sql: string; args: unknown[] } {
  const parts = ['c.repo_id = ?'];
  const args: unknown[] = [repoId];
  const types = (f.types ?? []).filter((t) => (COMMIT_TYPES as readonly string[]).includes(t));
  if (types.length) {
    parts.push(`coalesce(c.type,'other') IN (${types.map(() => '?').join(',')})`);
    args.push(...types);
  }
  const buckets = SIZE_BUCKETS.filter((b) => f.sizes?.includes(b.id));
  if (buckets.length) {
    parts.push(`(${buckets.map((b) => (Number.isFinite(b.max) ? `(${LINES} >= ? AND ${LINES} < ?)` : `${LINES} >= ?`)).join(' OR ')})`);
    for (const b of buckets) args.push(b.min, ...(Number.isFinite(b.max) ? [b.max] : []));
  }
  if (f.minLines != null) parts.push(`${LINES} >= ?`), args.push(f.minLines);
  if (f.maxLines != null) parts.push(`${LINES} <= ?`), args.push(f.maxLines);
  if (f.q) parts.push(`(c.subject LIKE ? ESCAPE '\\' OR c.body LIKE ? ESCAPE '\\')`), args.push(...Array(2).fill(`%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`));
  if (f.author) parts.push('c.author = ?'), args.push(f.author);
  if (f.since) parts.push('c.date >= ?'), args.push(f.since);
  if (f.until) parts.push('c.date <= ?'), args.push(f.until);
  if (f.path) {
    const p = f.path.replace(/^\.?\//, '').replace(/\/+$/, '');
    parts.push(`EXISTS (SELECT 1 FROM file_commits fc WHERE fc.repo_id = c.repo_id AND fc.sha = c.sha AND (fc.path = ? OR fc.path LIKE ? ESCAPE '\\' OR fc.old_path = ?))`);
    args.push(p, `${p.replace(/[\\%_]/g, (m) => '\\' + m)}/%`, p);
  }
  return { sql: parts.join(' AND '), args };
}

const row = (r: any): CommitListItem => ({ sha: r.sha, author: r.author, date: r.date, subject: r.subject, type: (r.type ?? 'other') as CommitType, added: r.added ?? 0, deleted: r.deleted ?? 0, files: r.files ?? 0 });

/** Commits matching the filter, newest first. */
export function listCommits(db: DB, repoId: string, f: CommitFilter = {}): CommitList {
  backfillCommitStats(db, repoId);
  const w = where(repoId, f);
  const total = (db.prepare(`SELECT count(*) AS n FROM commits c WHERE ${w.sql}`).get(...w.args) as { n: number }).n;
  const limit = Math.max(1, Math.min(200, f.limit ?? 50));
  const offset = Math.max(0, f.offset ?? 0);
  // seq 0 is the newest commit.
  const order = f.sort === 'largest' ? `${LINES} DESC, c.seq` : f.sort === 'oldest' ? 'c.seq DESC' : 'c.seq';
  const rows = db.prepare(`SELECT c.* FROM commits c WHERE ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...w.args, limit, offset) as any[];
  return { total, commits: rows.map(row) };
}

/** Size, languages and history statistics for the Repository tab and its insights. */
export function repoStats(db: DB, repoId: string): RepoStats {
  const totals = db.prepare('SELECT count(*) AS files, coalesce(sum(lines),0) AS lines FROM files WHERE repo_id=?').get(repoId) as { files: number; lines: number };
  const languages = (db
    .prepare(`SELECT lang, count(*) AS files, coalesce(sum(lines),0) AS lines FROM files WHERE repo_id=? AND lang IS NOT NULL GROUP BY lang ORDER BY lines DESC LIMIT 12`)
    .all(repoId) as { lang: string; files: number; lines: number }[]);
  if (!historyAvailable(db, repoId)) return { ...totals, languages, history: null };
  backfillCommitStats(db, repoId);
  const meta = historyMeta(db, repoId);
  const range = db.prepare('SELECT count(*) AS n, min(date) AS first, max(date) AS last FROM commits WHERE repo_id=?').get(repoId) as { n: number; first: string | null; last: string | null };
  const authors = (db
    .prepare(`SELECT author, count(*) AS commits, coalesce(sum(added),0) AS added, coalesce(sum(deleted),0) AS deleted FROM commits WHERE repo_id=? GROUP BY author ORDER BY commits DESC LIMIT 12`)
    .all(repoId) as { author: string; commits: number; added: number; deleted: number }[]);
  const months = (db
    .prepare(`SELECT substr(date,1,7) AS month, count(*) AS commits, coalesce(sum(added),0) AS added, coalesce(sum(deleted),0) AS deleted FROM commits WHERE repo_id=? GROUP BY month ORDER BY month`)
    .all(repoId) as { month: string; commits: number; added: number; deleted: number }[]);
  const types = Object.fromEntries(COMMIT_TYPES.map((t) => [t, 0])) as Record<CommitType, number>;
  for (const r of db.prepare(`SELECT coalesce(type,'other') AS type, count(*) AS n FROM commits WHERE repo_id=? GROUP BY 1`).all(repoId) as { type: CommitType; n: number }[]) types[r.type in types ? r.type : 'other'] += r.n;
  const sizes = Object.fromEntries(SIZE_BUCKETS.map((b) => [b.id, 0])) as Record<SizeBucket, number>;
  for (const r of db.prepare(`SELECT coalesce(added,0)+coalesce(deleted,0) AS n FROM commits WHERE repo_id=?`).all(repoId) as { n: number }[]) {
    sizes[SIZE_BUCKETS.find((b) => r.n >= b.min && r.n < b.max)!.id]++;
  }
  const biggest = (db.prepare(`SELECT * FROM commits WHERE repo_id=? ORDER BY coalesce(added,0)+coalesce(deleted,0) DESC LIMIT 8`).all(repoId) as any[]).map(row);
  return {
    ...totals,
    languages,
    history: { commits: range.n, total: meta.total, shallow: meta.shallow, capped: meta.capped || meta.truncated, first: range.first, last: range.last, authors, months, types, sizes, biggest },
  };
}
