import type { DB } from '../db/index.js';
import { repoDir } from '../paths.js';
import { RepoIndex } from '../agent/tools.js';
import { git, hasGit, safeGitPath, safeSha } from './git.js';
import type { CommitRow, Unavailable } from './index.js';
import { historyMeta } from './index.js';

const RS = '\x1e';
const US = '\x1f';
const HDR = `--format=${RS}%H${US}%an${US}%aI${US}%s${US}`;

export interface SymbolCommit extends CommitRow {
  added: number;
  deleted: number;
  excerpt: string;
  /** File path at that commit (line history follows renames). */
  path?: string;
}

export interface SymbolHistory {
  available: true;
  path: string;
  name: string | null;
  kind: string | null;
  range: { start: number; end: number } | null;
  introduced: (CommitRow & { uncertain: boolean; how: 'line-history' | 'pickaxe' }) | null;
  lastChanged: CommitRow | null;
  /** Up to 60 most recent changes, with diff excerpts. */
  commits: SymbolCommit[];
  /** All changes found (may exceed `commits.length`). */
  totalCommits: number;
  timelineTruncated: boolean;
  authors: { name: string; commits: number }[];
  /** The repository history itself is incomplete (shallow clone or index cap). */
  truncated: boolean;
}

const TIMELINE_LIMIT = 60;
const VALUE_KINDS = new Set(['variable', 'constant']);

function unavailable(db: DB, repoId: string): Unavailable | null {
  const repo = db.prepare('SELECT has_source FROM repos WHERE id=?').get(repoId) as any;
  if (!repo) return { available: false, reason: 'Repository not found' };
  if (!hasGit(repoDir(repoId))) return { available: false, reason: 'Git history is not available for this project (imported, or cloned with HISTORY_DEPTH=-1). Re-analyze to fetch it.' };
  return null;
}

function parseLogWithPatches(out: string): SymbolCommit[] {
  const commits: SymbolCommit[] = [];
  for (const block of out.split(RS)) {
    if (!block.trim()) continue;
    const parts = block.split(US);
    if (parts.length < 5) continue;
    const [sha, author, date, subject, patch] = parts;
    let added = 0;
    let deleted = 0;
    const lines = patch.split('\n');
    for (const l of lines) {
      if (l.startsWith('+++') || l.startsWith('---')) continue;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) deleted++;
    }
    const start = lines.findIndex((l) => l.startsWith('@@'));
    const plus = lines.find((l) => l.startsWith('+++ b/'));
    const minus = lines.find((l) => l.startsWith('--- a/'));
    const filePath = plus ? plus.slice(6) : minus ? minus.slice(6) : undefined;
    commits.push({ sha, author, date, subject, added, deleted, path: filePath, excerpt: (start >= 0 ? lines.slice(start, start + 40) : []).join('\n').slice(0, 4000) });
  }
  return commits;
}


/** History of a function/class (by its current line range), a selection, or a plain name (pickaxe). */
export async function symbolHistory(
  db: DB,
  repoId: string,
  req: { path: string; name?: string; line?: number; start?: number; end?: number },
): Promise<SymbolHistory | Unavailable> {
  const na = unavailable(db, repoId);
  if (na) return na;
  const ix = new RepoIndex(db, repoId);
  const path = safeGitPath(ix.requireFile(req.path));
  const sym = req.start ? undefined : ix.findSymbol(path, req.name, req.line);
  const range = req.start ? { start: req.start, end: req.end ?? req.start } : sym ? { start: sym.line, end: sym.endLine } : null;
  const file = ix.fileRow(path);
  const key = `${path}#${sym?.name ?? req.name ?? ''}@${range ? `${range.start}-${range.end}` : ''}`;
  const hit = db.prepare('SELECT content, file_hash FROM symbol_history WHERE repo_id=? AND key=?').get(repoId, key) as any;
  if (hit && hit.file_hash === file.hash) return JSON.parse(hit.content);

  const dir = repoDir(repoId);
  const meta = historyMeta(db, repoId);
  const parseHeaders = (out: string): CommitRow[] =>
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split(US);
        return { sha, author, date, subject };
      });

  // 1. Line history of the current range: every change (headers only), plus diffs for the most recent ones.
  let commits: SymbolCommit[] = [];
  let allChanges: CommitRow[] | null = null;
  if (range) {
    const L = ['-L', `${range.start},${range.end}:${path}`];
    const [detail, headers] = await Promise.all([
      git(dir, ['log', '-n', String(TIMELINE_LIMIT), HDR, ...L], { timeoutMs: 90_000 }).catch(() => ''),
      git(dir, ['log', '-s', '--format=%H%x1f%an%x1f%aI%x1f%s', ...L], { timeoutMs: 120_000 }).then(parseHeaders, () => null),
    ]);
    commits = parseLogWithPatches(detail);
    allChanges = headers;
  }

  // 2. Pickaxe: the first commit that added this name to the file.
  const name = sym?.name ?? req.name?.split('.').pop();
  let firstAppeared: CommitRow | null = null;
  if (name && /^[\w$]+$/.test(name)) {
    const out = await git(dir, ['log', '--reverse', `-S${name}`, '--format=%H%x1f%an%x1f%aI%x1f%s', '--', path], { timeoutMs: 60_000 }).catch(() => '');
    firstAppeared = parseHeaders(out)[0] ?? null;
    if (!commits.length) {
      const [detail, headers] = await Promise.all([
        git(dir, ['log', '-n', String(TIMELINE_LIMIT), `-S${name}`, HDR, '-p', '--', path], { timeoutMs: 60_000 }).catch(() => ''),
        git(dir, ['log', `-S${name}`, '--format=%H%x1f%an%x1f%aI%x1f%s', '--', path], { timeoutMs: 60_000 }).then(parseHeaders, () => null),
      ]);
      commits = parseLogWithPatches(detail);
      allChanges = headers;
    }
  }

  // 3. Introduction is decided from the complete change list, never from the capped timeline.
  //    Variables/constants use pickaxe (their current lines may have held other code before);
  //    functions, classes and selections use line history, which follows the code through renames.
  const totalCommits = allChanges?.length ?? commits.length;
  const oldestChange = allChanges?.[allChanges.length - 1] ?? (commits.length < TIMELINE_LIMIT ? commits[commits.length - 1] : undefined);
  const preferPickaxe = !range || (sym ? VALUE_KINDS.has(sym.kind) : !req.start);
  let intro: (CommitRow & { how: 'line-history' | 'pickaxe' }) | null = null;
  if (preferPickaxe && firstAppeared) intro = { ...firstAppeared, how: 'pickaxe' };
  else if (oldestChange) intro = { sha: oldestChange.sha, author: oldestChange.author, date: oldestChange.date, subject: oldestChange.subject, how: 'line-history' };
  else if (firstAppeared) intro = { ...firstAppeared, how: 'pickaxe' };
  // Unknown when the full list could not be computed and the timeline hit its cap.
  const capUnknown = !allChanges && commits.length >= TIMELINE_LIMIT && intro?.how === 'line-history';

  const authors = new Map<string, number>();
  for (const c of allChanges ?? commits) authors.set(c.author, (authors.get(c.author) ?? 0) + 1);
  const result: SymbolHistory = {
    available: true,
    path,
    name: sym ? (sym.parent ? `${sym.parent}.${sym.name}` : sym.name) : req.name ?? null,
    kind: sym?.kind ?? null,
    range,
    introduced: intro ? { ...intro, uncertain: capUnknown || meta.boundaries.has(intro.sha) } : null,
    lastChanged: commits[0] ? { sha: commits[0].sha, author: commits[0].author, date: commits[0].date, subject: commits[0].subject } : null,
    commits,
    totalCommits,
    timelineTruncated: totalCommits > commits.length,
    authors: [...authors].map(([n, c]) => ({ name: n, commits: c })).sort((a, b) => b.commits - a.commits),
    truncated: meta.truncated,
  };
  db.prepare('INSERT OR REPLACE INTO symbol_history (repo_id, key, file_hash, content) VALUES (?, ?, ?, ?)').run(repoId, key, file.hash, JSON.stringify(result));
  return result;
}

export interface BlameRange {
  start: number;
  end: number;
  sha: string;
  author: string;
  date: string;
  summary: string;
}

/** `git blame` grouped into ranges of consecutive lines from the same commit. */
export async function blame(db: DB, repoId: string, path: string, start?: number, end?: number): Promise<{ available: true; ranges: BlameRange[] } | Unavailable> {
  const na = unavailable(db, repoId);
  if (na) return na;
  const ix = new RepoIndex(db, repoId);
  const p = safeGitPath(ix.requireFile(path));
  const args = ['blame', '--line-porcelain'];
  if (start) args.push('-L', `${start},${end ?? start}`);
  const out = await git(repoDir(repoId), [...args, '--', p], { timeoutMs: 60_000 });
  const ranges: BlameRange[] = [];
  const meta = new Map<string, { author: string; date: string; summary: string }>();
  let cur: { sha: string; line: number } | null = null;
  let author = '';
  let time = 0;
  let summary = '';
  for (const l of out.split('\n')) {
    const h = l.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (h) {
      cur = { sha: h[1], line: Number(h[2]) };
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('author ')) author = l.slice(7);
    else if (l.startsWith('author-time ')) time = Number(l.slice(12));
    else if (l.startsWith('summary ')) summary = l.slice(8);
    else if (l.startsWith('\t')) {
      if (!meta.has(cur.sha)) meta.set(cur.sha, { author, date: new Date(time * 1000).toISOString(), summary });
      const m = meta.get(cur.sha)!;
      const last = ranges[ranges.length - 1];
      if (last && last.sha === cur.sha && last.end === cur.line - 1) last.end = cur.line;
      else ranges.push({ start: cur.line, end: cur.line, sha: cur.sha, ...m });
      cur = null;
    }
  }
  return { available: true, ranges };
}

export interface CommitDetails {
  available: true;
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: { status: string; path: string; oldPath?: string }[];
  patch: string;
  patchTruncated: boolean;
}

export async function commitDetails(db: DB, repoId: string, shaIn: string, path?: string): Promise<CommitDetails | Unavailable> {
  const na = unavailable(db, repoId);
  if (na) return na;
  const sha = safeSha(shaIn);
  const dir = repoDir(repoId);
  const head = await git(dir, ['show', '-s', '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b', sha]);
  const [full, author, date, subject, body] = head.split(US);
  const names = await git(dir, ['show', '--format=', '-M', '--name-status', sha]);
  const files = names
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((t) => t.length >= 2 && /^[AMDRCT]/.test(t[0]))
    .map((t) => (t[0][0] === 'R' ? { status: 'R', oldPath: t[1], path: t[2] } : { status: t[0][0], path: t[1] }));
  const p = path ? safeGitPath(path) : undefined;
  const patchArgs = ['show', '--format=', '-M', '--patch', sha];
  let patch = await git(dir, p ? [...patchArgs, '--', p] : patchArgs, { maxBuffer: 32 * 1024 * 1024 });
  const LIMIT = 60_000;
  const patchTruncated = patch.length > LIMIT;
  if (patchTruncated) patch = patch.slice(0, LIMIT) + '\n… [diff truncated]';
  return { available: true, sha: full.trim(), author, date, subject, body: (body ?? '').trim(), files, patch, patchTruncated };
}

/** Commits whose diff adds/removes a term (pickaxe), plus commits whose message mentions it. */
export async function searchHistory(db: DB, repoId: string, term: string, path?: string) {
  const na = unavailable(db, repoId);
  if (na) return na;
  if (!term || term.length > 200 || term.startsWith('-')) throw new Error('Invalid search term');
  const dir = repoDir(repoId);
  const fmt = '--format=%H%x1f%an%x1f%aI%x1f%s';
  const tail = path ? ['--', safeGitPath(path)] : [];
  const parse = (out: string) =>
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split(US);
        return { sha, author, date, subject };
      });
  const [code, msgs] = await Promise.all([
    git(dir, ['log', '-n', '20', `-S${term}`, fmt, ...tail], { timeoutMs: 60_000 }).catch(() => ''),
    git(dir, ['log', '-n', '20', '-i', '--fixed-strings', `--grep=${term}`, fmt, ...tail], { timeoutMs: 30_000 }).catch(() => ''),
  ]);
  return { available: true as const, codeChanges: parse(code), messageMatches: parse(msgs) };
}
