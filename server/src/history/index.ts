import crypto from 'node:crypto';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import { git } from './git.js';
import type { HistoryInfo } from './git.js';

const RS = '\x1e';
const US = '\x1f';
const FMT = `--format=${RS}%H${US}%an${US}%ae${US}%aI${US}%s${US}%b${US}`;

export interface CommitRow {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body?: string | null;
}

export interface FileTimelineEntry extends CommitRow {
  status: string; // A, M, D, R
  path: string; // name at that commit
  oldPath: string | null;
  added: number | null;
  deleted: number | null;
}

export interface FileHistory {
  available: true;
  path: string;
  created: (FileTimelineEntry & { uncertain: boolean }) | null;
  lastChanged: FileTimelineEntry | null;
  commitCount: number;
  authors: { name: string; commits: number; added: number; deleted: number }[];
  renames: { from: string; to: string; sha: string; date: string }[];
  commits: FileTimelineEntry[];
  truncated: boolean;
}

export type Unavailable = { available: false; reason: string };

/** `prefix/{old => new}/suffix` or `old => new` → [old, new] */
export function expandRenamePath(p: string): [string, string] | null {
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    const [, pre, a, b, post] = brace;
    const norm = (s: string) => s.replace(/\/\//g, '/').replace(/^\//, '');
    return [norm(pre + a + post), norm(pre + b + post)];
  }
  const plain = p.match(/^(.*) => (.*)$/);
  return plain ? [plain[1], plain[2]] : null;
}

function parseCommits(out: string) {
  const commits: (CommitRow & { email: string; tail: string })[] = [];
  for (const block of out.split(RS)) {
    if (!block.trim()) continue;
    const parts = block.split(US);
    if (parts.length < 7) continue;
    const [sha, author, email, date, subject, body, tail] = parts;
    commits.push({ sha, author, email, date, subject, body: body.trim().slice(0, 2000) || null, tail });
  }
  return commits;
}

/** Index commits and per-file changes from the clone's history (one pass each for statuses and line counts). */
export async function indexHistory(db: DB, repoId: string, dir: string, info: HistoryInfo, maxCommits: number): Promise<{ commits: number; total: number }> {
  const total = Number((await git(dir, ['rev-list', '--count', 'HEAD'])).trim()) || 0;
  const [statusOut, numOut] = await Promise.all([
    git(dir, ['log', '-n', String(maxCommits), '-M', '--name-status', FMT]),
    git(dir, ['log', '-n', String(maxCommits), '-M', '--numstat', '--format=' + RS + '%H' + US]),
  ]);
  const commits = parseCommits(statusOut);
  // Line counts: sha -> path -> [added, deleted]
  const counts = new Map<string, Map<string, [number | null, number | null]>>();
  for (const block of numOut.split(RS)) {
    if (!block.trim()) continue;
    const [sha, rest = ''] = block.split(US);
    const m = new Map<string, [number | null, number | null]>();
    for (const line of rest.split('\n')) {
      const t = line.split('\t');
      if (t.length < 3) continue;
      const ren = expandRenamePath(t[2]);
      m.set(ren ? ren[1] : t[2], [t[0] === '-' ? null : Number(t[0]), t[1] === '-' ? null : Number(t[1])]);
    }
    counts.set(sha.trim(), m);
  }
  const insC = db.prepare('INSERT OR REPLACE INTO commits (repo_id, sha, seq, author, email_hash, date, subject, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insF = db.prepare('INSERT INTO file_commits (repo_id, path, sha, status, old_path, added, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM commits WHERE repo_id=?').run(repoId);
    db.prepare('DELETE FROM file_commits WHERE repo_id=?').run(repoId);
    commits.forEach((c, seq) => {
      insC.run(repoId, c.sha, seq, c.author, c.email ? crypto.createHash('sha256').update(c.email.toLowerCase()).digest('hex').slice(0, 16) : null, c.date, c.subject, c.body);
      const cm = counts.get(c.sha);
      for (const line of c.tail.split('\n')) {
        const t = line.split('\t');
        if (t.length < 2 || !/^[AMDRCT]/.test(t[0])) continue;
        const status = t[0][0];
        const [oldPath, path] = status === 'R' || status === 'C' ? [t[1], t[2]] : [null, t[1]];
        const n = cm?.get(path);
        insF.run(repoId, path, c.sha, status === 'C' ? 'A' : status, oldPath, n?.[0] ?? null, n?.[1] ?? null);
      }
    });
    db.prepare('UPDATE repos SET history_depth=?, history_shallow=?, history_root=?, history_boundaries=?, history_total=?, history_capped=? WHERE id=?').run(
      info.depth,
      info.shallow ? 1 : 0,
      info.rootSha,
      JSON.stringify(info.boundaries ?? (info.shallow && info.rootSha ? [info.rootSha] : [])),
      total,
      commits.length < total ? 1 : 0,
      repoId,
    );
  })();
  return { commits: commits.length, total };
}

export interface HistoryMeta {
  shallow: boolean;
  /** HISTORY_INDEX_COMMITS stopped indexing before the oldest available commit. */
  capped: boolean;
  /** Commits with missing parents: anything "added" there may be older. */
  boundaries: Set<string>;
  indexed: number;
  total: number;
  truncated: boolean;
}

export function historyMeta(db: DB, repoId: string): HistoryMeta {
  const r = (db.prepare('SELECT history_shallow, history_root, history_boundaries, history_total, history_capped FROM repos WHERE id=?').get(repoId) ?? {}) as any;
  const indexed = (db.prepare('SELECT count(*) AS n FROM commits WHERE repo_id=?').get(repoId) as any).n as number;
  // Older databases only stored one boundary in history_root (meaningful only for shallow clones).
  const boundaries = new Set<string>(json<string[]>(r.history_boundaries, r.history_shallow && r.history_root ? [r.history_root] : []));
  const capped = Boolean(r.history_capped);
  // A capped index needs no extra boundary: commits are still diffed against their real parents, so a file whose
  // oldest indexed change is not an "add" is already reported as uncertain.
  const shallow = Boolean(r.history_shallow);
  return { shallow, capped, boundaries, indexed, total: r.history_total ?? indexed, truncated: shallow || capped };
}

export function historyAvailable(db: DB, repoId: string): boolean {
  return Boolean((db.prepare('SELECT 1 FROM commits WHERE repo_id=? LIMIT 1').get(repoId)));
}

interface TimelineRow {
  path: string;
  status: string;
  old_path: string | null;
  added: number | null;
  deleted: number | null;
  sha: string;
  author: string;
  date: string;
  subject: string;
  seq: number;
}

const ROW_SQL = `SELECT fc.path, fc.status, fc.old_path, fc.added, fc.deleted, c.sha, c.author, c.date, c.subject, c.seq
  FROM file_commits fc JOIN commits c ON c.repo_id = fc.repo_id AND c.sha = fc.sha`;

/**
 * Build one file's timeline from per-path rows (each list ordered newest first),
 * following renames back through earlier names.
 */
function buildTimeline(path: string, rowsOf: (p: string) => TimelineRow[], meta: HistoryMeta): FileHistory {
  const entries: FileTimelineEntry[] = [];
  const renames: FileHistory['renames'] = [];
  let name = path;
  let after = -1; // only rows older than the rename we followed
  const visited = new Set<string>();
  outer: while (!visited.has(`${name}@${after}`)) {
    visited.add(`${name}@${after}`);
    for (const r of rowsOf(name)) {
      if (r.seq <= after) continue;
      entries.push({ sha: r.sha, author: r.author, date: r.date, subject: r.subject, status: r.status, path: r.path, oldPath: r.old_path, added: r.added, deleted: r.deleted });
      if (r.status === 'A') break outer;
      if (r.status === 'R' && r.old_path) {
        renames.push({ from: r.old_path, to: r.path, sha: r.sha, date: r.date });
        name = r.old_path;
        after = r.seq;
        continue outer;
      }
    }
    break;
  }
  const oldest = entries[entries.length - 1] ?? null;
  const uncertain = !oldest || oldest.status !== 'A' || meta.boundaries.has(oldest.sha);
  const authors = new Map<string, { name: string; commits: number; added: number; deleted: number }>();
  for (const e of entries) {
    const a = authors.get(e.author) ?? authors.set(e.author, { name: e.author, commits: 0, added: 0, deleted: 0 }).get(e.author)!;
    a.commits++;
    a.added += e.added ?? 0;
    a.deleted += e.deleted ?? 0;
  }
  return {
    available: true,
    path,
    created: oldest ? { ...oldest, uncertain } : null,
    lastChanged: entries[0] ?? null,
    commitCount: entries.length,
    authors: [...authors.values()].sort((a, b) => b.commits - a.commits),
    renames,
    commits: entries.slice(0, 200),
    truncated: meta.truncated,
  };
}

/** Timeline of one file, following renames back through its earlier names (indexed per-path queries). */
export function fileHistory(db: DB, repoId: string, path: string): FileHistory | Unavailable {
  if (!historyAvailable(db, repoId)) return { available: false, reason: 'No git history for this project (imported without history, or HISTORY_DEPTH=-1).' };
  const stmt = db.prepare(`${ROW_SQL} WHERE fc.repo_id = ? AND fc.path = ? ORDER BY c.seq`);
  return buildTimeline(path, (p) => stmt.all(repoId, p) as TimelineRow[], historyMeta(db, repoId));
}

/** Compact per-file history facts stored in files.meta.history. Loads the history once: O(total rows). */
export function storeFileHistorySummaries(db: DB, repoId: string) {
  if (!historyAvailable(db, repoId)) return;
  const meta = historyMeta(db, repoId);
  const byPath = new Map<string, TimelineRow[]>();
  for (const r of db.prepare(`${ROW_SQL} WHERE fc.repo_id = ? ORDER BY c.seq`).all(repoId) as TimelineRow[]) {
    (byPath.get(r.path) ?? byPath.set(r.path, []).get(r.path)!).push(r);
  }
  const files = db.prepare('SELECT path FROM files WHERE repo_id=?').all(repoId) as { path: string }[];
  const upd = db.prepare(`UPDATE files SET meta=json_set(coalesce(meta,'{}'), '$.history', json(?)) WHERE repo_id=? AND path=?`);
  db.transaction(() => {
    for (const f of files) {
      if (!byPath.has(f.path)) continue;
      const h = buildTimeline(f.path, (p) => byPath.get(p) ?? [], meta);
      if (!h.commitCount) continue;
      upd.run(
        JSON.stringify({
          createdSha: h.created?.sha,
          createdAt: h.created?.date,
          createdBy: h.created?.author,
          createdPath: h.created?.path,
          uncertain: h.created?.uncertain,
          lastSha: h.lastChanged?.sha,
          lastAt: h.lastChanged?.date,
          lastBy: h.lastChanged?.author,
          commits: h.commitCount,
          authors: h.authors.slice(0, 3).map((a) => a.name),
        }),
        repoId,
        f.path,
      );
    }
  })();
}

/** Repo-level history facts for prompts and insights. */
export function repoHistorySummary(db: DB, repoId: string) {
  if (!historyAvailable(db, repoId)) return null;
  const meta = historyMeta(db, repoId);
  const range = db.prepare('SELECT min(date) AS first, max(date) AS last, count(*) AS n FROM commits WHERE repo_id=?').get(repoId) as any;
  const authors = db.prepare('SELECT author, count(*) AS n FROM commits WHERE repo_id=? GROUP BY author ORDER BY n DESC LIMIT 8').all(repoId) as any[];
  const hotspots = (db
    .prepare(
      `SELECT fc.path, count(*) AS n, sum(coalesce(fc.added,0)+coalesce(fc.deleted,0)) AS churn FROM file_commits fc
       JOIN files f ON f.repo_id = fc.repo_id AND f.path = fc.path WHERE fc.repo_id=? GROUP BY fc.path ORDER BY n DESC, churn DESC LIMIT 12`,
    )
    .all(repoId) as any[]);
  const recent = db.prepare('SELECT sha, author, date, subject FROM commits WHERE repo_id=? ORDER BY seq LIMIT 10').all(repoId) as CommitRow[];
  return {
    firstCommit: range.first,
    lastCommit: range.last,
    commitCount: range.n,
    totalCommits: meta.total,
    truncated: meta.truncated,
    shallow: meta.shallow,
    capped: meta.capped,
    authors,
    hotspots,
    recent,
  };
}

