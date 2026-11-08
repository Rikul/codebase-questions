import crypto from 'node:crypto';
import type { Review, ReviewEntry, ReviewEvent, ReviewFinding, ReviewSeverity } from '@cq/shared';
import { REVIEW_SEVERITIES, ReviewSchema, componentTitle, defaultView } from '@cq/shared';
import { getArchitecture } from '../routes/queries.js';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import { AGENT_GUIDANCE } from '../llm/agent.js';
import type { ToolCaller } from '../llm/agent.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/index.js';
import { agentWithFallback } from '../llm/index.js';
import { agentEventMapper } from './explain.js';
import { RepoIndex, repoTools } from './tools.js';

const FULL_KEY = 'full';
const fileKey = (path: string) => `file:${path}`;

const SEVERITY_GUIDE = `Severity: critical = exploitable vulnerability or data loss; high = likely bug or security hole on a main path; medium = real bug in an edge case, or a design problem that will cause bugs; low = minor issue; info = observation worth knowing.`;

const RULES = `Report only problems you confirmed in code you read. For each finding set path, startLine and endLine, cite the code as [path:start-end] in detail, explain why it matters, and give a concrete fix. Skip style nits and anything a linter or formatter would catch. Order findings most severe first. ${SEVERITY_GUIDE}`;

const FULL_SYSTEM = `You are a principal engineer doing a code review of an entire repository.
${AGENT_GUIDANCE}

Look for problems that matter: incorrect logic and bugs, security vulnerabilities, missing or wrong error handling, resource leaks, race conditions and concurrency mistakes, performance problems, and design issues that will cause bugs. Start from the facts below, then read the most important and riskiest code: entry points, request handlers, authentication, data access, concurrency, and parsing of external input. Static signals are regex matches and may be false positives; check them before reporting.

${RULES} Aim for 5-20 findings; if the code is solid, say so and report fewer. Submit with submit_review.`;

const FILE_SYSTEM = `You are a senior engineer reviewing one file of a repository.
${AGENT_GUIDANCE}

Read the whole file first (in ranges if it is long). Check callers or callees with find_references, symbol_calls or read_file when correctness depends on how the code is used. Look for bugs, unhandled errors and edge cases, security issues, resource leaks, concurrency mistakes, performance problems and maintainability issues in this file.

${RULES} Findings should be in this file unless the problem is in how a caller uses it. An empty findings list is fine when the file is clean. Submit with submit_review.`;

const SIGNAL_SEVERITY: Record<string, ReviewSeverity> = {
  'code-exec': 'high', 'command-exec': 'medium', 'shell-true': 'high', 'sql-concat': 'high', 'xss-sink': 'medium', deserialization: 'high',
  'weak-crypto': 'low', 'hardcoded-secret': 'high', 'tls-disabled': 'high', 'cors-wildcard': 'low', 'path-traversal': 'high', ssrf: 'high', redirect: 'medium',
};

const rank = (s: ReviewSeverity) => REVIEW_SEVERITIES.indexOf(s);
const sortFindings = (f: ReviewFinding[]) => [...f].sort((a, b) => rank(a.severity) - rank(b.severity));

interface FileRow { path: string; lines: number; summary: string | null; hash: string; meta: string | null }

function signalFindings(rows: FileRow[], limit: number): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const f of rows) {
    const meta = json<any>(f.meta, {});
    if (meta.isTest) continue;
    for (const s of (meta.security ?? []) as { kind: string; line: number; detail: string }[]) {
      const severity = SIGNAL_SEVERITY[s.kind];
      if (!severity || out.length >= limit) continue;
      out.push({
        severity,
        kind: 'security',
        title: `Possible ${s.kind.replace(/-/g, ' ')} in ${f.path.split('/').pop()}`,
        path: f.path,
        startLine: s.line,
        endLine: s.line,
        detail: `Static pattern match at [${f.path}:${s.line}-${s.line}]: \`${s.detail.replace(/`/g, "'")}\`. Confirm by reading the code; this may be a false positive.`,
      });
    }
  }
  return out;
}

async function todoFindings(call: ToolCaller, prefix?: string): Promise<ReviewFinding[]> {
  const hits = ((await call('grep', { pattern: '\\b(TODO|FIXME|HACK|XXX)\\b', ...(prefix ? { path_prefix: prefix } : {}) }).catch(() => [])) ?? []) as { path: string; line: number; code: string }[];
  return hits.slice(0, 8).map((h) => ({
    severity: 'info' as const,
    kind: 'maintainability' as const,
    title: `Open ${/FIXME|HACK|XXX/i.test(h.code) ? 'FIXME' : 'TODO'} in ${h.path.split('/').pop()}`,
    path: h.path,
    startLine: h.line,
    endLine: h.line,
    detail: `[${h.path}:${h.line}-${h.line}]: \`${h.code.replace(/`/g, "'")}\``,
  }));
}

function staticSummary(findings: ReviewFinding[], scope: string): string {
  const counts = REVIEW_SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
  return [
    `Static review of ${scope}, built from pattern matches and file statistics (no LLM is configured, or the model run failed).`,
    findings.length ? `Found ${findings.length} item${findings.length === 1 ? '' : 's'}: ${counts.map(([s, n]) => `${n} ${s}`).join(', ')}. Pattern matches need confirming in the code.` : 'No static warning signs were found.',
  ].join(' ');
}

function save(db: DB, repoId: string, key: string, version: string, review: Review): string {
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO reviews (repo_id, key, version, content, created_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(repo_id, key) DO UPDATE SET version=excluded.version, content=excluded.content, created_at=excluded.created_at`).run(repoId, key, version, JSON.stringify(review), createdAt);
  return createdAt;
}

function stored(db: DB, repoId: string, key: string): { version: string; review: Review; createdAt: string } | null {
  const row = db.prepare('SELECT version, content, created_at FROM reviews WHERE repo_id=? AND key=?').get(repoId, key) as any;
  if (!row) return null;
  const parsed = ReviewSchema.safeParse(json(row.content, null));
  return parsed.success ? { version: row.version, review: parsed.data, createdAt: row.created_at } : null;
}

/** Drop findings that point at files outside the repo, and keep line numbers inside the file. */
function clean(ix: RepoIndex, review: Review): Review {
  const findings = review.findings.map((f) => {
    if (!f.path) return f;
    let row: FileRow | null = null;
    try {
      const p = ix.normalize(f.path);
      row = ix.hasFile(p) ? ix.fileRow(p) : null;
    } catch {
      /* path outside the repo */
    }
    if (!row) return { ...f, path: undefined, startLine: undefined, endLine: undefined };
    const start = f.startLine && f.startLine >= 1 && f.startLine <= row.lines ? f.startLine : undefined;
    const end = start && f.endLine && f.endLine >= start && f.endLine <= row.lines ? f.endLine : start;
    return { ...f, path: row.path, startLine: start, endLine: end };
  });
  return { ...review, findings: sortFindings(findings) };
}

function fullContext(db: DB, repoId: string): string {
  const repo = db.prepare('SELECT name, overview FROM repos WHERE id=?').get(repoId) as { name: string; overview: string | null };
  const comps = defaultView(getArchitecture(db, repoId)).components;
  const files = db.prepare('SELECT path, lines, summary, meta FROM files WHERE repo_id=?').all(repoId) as FileRow[];
  const scored = files.map((f) => {
    const m = json<any>(f.meta, {});
    const score = (m.isEntry ? 8 : 0) + (m.routes?.length ?? 0) * 2 + (m.security?.length ?? 0) * 2 + Math.min(4, f.lines / 150) - (m.isTest ? 6 : 0);
    return { f, m, score };
  });
  const key = scored.filter((x) => x.f.summary).sort((a, b) => b.score - a.score).slice(0, 60);
  const tests = scored.filter((x) => x.m.isTest).length;
  const signals = scored
    .filter((x) => !x.m.isTest)
    .flatMap((x) => ((x.m.security ?? []) as any[]).filter((s) => s.kind !== 'auth').map((s) => `- ${x.f.path}:${s.line} [${s.kind}] ${String(s.detail).slice(0, 140)}`))
    .slice(0, 80);
  const routes = scored.flatMap((x) => ((x.m.routes ?? []) as any[]).map((r) => `- ${r.method} ${r.path} (${x.f.path}:${r.line})`)).slice(0, 60);
  const big = scored.filter((x) => x.f.lines > 600 && !x.m.isTest).sort((a, b) => b.f.lines - a.f.lines).slice(0, 10);
  return [
    `Repository: ${repo.name}`,
    repo.overview ? `# Architecture overview\n${repo.overview.slice(0, 3000)}` : '',
    comps.length ? `# Components\n${comps.map((c) => `- ${componentTitle(c)} [${c.type}] (${c.paths.join(', ') || 'external'}): ${(c.summary ?? c.description).slice(0, 200)}`).join('\n')}` : '',
    `# Size\n${files.length} files, ${tests} test files.`,
    routes.length ? `# HTTP routes\n${routes.join('\n')}` : '',
    signals.length ? `# Static security signals (regex; may be false positives)\n${signals.join('\n')}` : '',
    big.length ? `# Largest files\n${big.map((x) => `- ${x.f.path} (${x.f.lines} lines)`).join('\n')}` : '',
    `# Key files (most important first)\n${key.map((x) => `- ${x.f.path} (${x.f.lines} lines): ${String(x.f.summary).slice(0, 300)}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The version a full review is written against: the analyzed commit, or for uploads (which have
 * no commit) a digest of the indexed files' paths and content hashes, so a changed upload counts as new code.
 */
export function repoVersion(db: DB, repoId: string): string {
  const r = db.prepare('SELECT commit_sha FROM repos WHERE id=?').get(repoId) as { commit_sha: string | null } | undefined;
  if (r?.commit_sha) return r.commit_sha;
  const h = crypto.createHash('sha1');
  for (const f of db.prepare('SELECT path, hash FROM files WHERE repo_id=? ORDER BY path').iterate(repoId) as Iterable<{ path: string; hash: string }>) h.update(`${f.path}\0${f.hash}\n`);
  return `content:${h.digest('hex')}`;
}

/** Review the whole codebase and store the result. */
async function runFull(db: DB, llm: LLMProvider, embeddings: EmbeddingProvider | null, repoId: string, emit: (e: ReviewEvent) => void, onWarn?: (msg: string) => void): Promise<void> {
  // Record the version the review starts from: if the code is re-analyzed meanwhile, the result is stale.
  const version = repoVersion(db, repoId);
  const ix = new RepoIndex(db, repoId, embeddings);
  const run = await agentWithFallback(
    llm,
    {
      system: FULL_SYSTEM,
      messages: [{ role: 'user', content: fullContext(db, repoId) }],
      tools: repoTools(ix),
      maxSteps: 24,
      maxTokens: 12_000,
      final: { name: 'review', schema: ReviewSchema, description: 'Submit the finished code review.' },
      onEvent: agentEventMapper(emit),
      scripted: async (call) => {
        const files = db.prepare('SELECT path, lines, summary, hash, meta FROM files WHERE repo_id=?').all(repoId) as FileRow[];
        const findings = signalFindings(files, 20);
        findings.push(...(await todoFindings(call)));
        for (const f of files.filter((x) => x.lines > 800 && !json<any>(x.meta, {}).isTest).sort((a, b) => b.lines - a.lines).slice(0, 5)) {
          findings.push({ severity: 'low', kind: 'maintainability', title: `Very large file: ${f.path.split('/').pop()}`, path: f.path, detail: `\`${f.path}\` has ${f.lines} lines. Large files are harder to review and change safely; consider splitting it by responsibility.` });
        }
        const code = files.filter((f) => !json<any>(f.meta, {}).isTest).length;
        if (code > 10 && !files.some((f) => json<any>(f.meta, {}).isTest)) {
          findings.push({ severity: 'medium', kind: 'testing', title: 'No tests found', detail: `None of the ${files.length} files look like tests, so changes are not checked automatically. Start with tests for the entry points and core logic.` });
        }
        return { final: { summaryMd: staticSummary(findings, 'the codebase'), findings: sortFindings(findings) } };
      },
    },
    onWarn ?? ((w) => emit({ type: 'step', step: { id: 'fallback', label: w, tool: 'fallback', status: 'error' } })),
  );
  const review = clean(ix, run.final as Review);
  if (!db.prepare('SELECT 1 FROM repos WHERE id=?').get(repoId)) return;
  const createdAt = save(db, repoId, FULL_KEY, version, review);
  emit({ type: 'result', path: null, review, cached: false, createdAt });
}

/** Review one file and store the result against its content hash. */
async function runFile(db: DB, llm: LLMProvider, embeddings: EmbeddingProvider | null, repoId: string, p: string, emit: (e: ReviewEvent) => void): Promise<void> {
  const ix = new RepoIndex(db, repoId, embeddings);
  const file = ix.fileRow(p) as FileRow;
  const key = fileKey(p);
  const meta = json<any>(file.meta, {});
  const context = [
    `Review this file: \`${p}\` (${file.lines} lines${meta.isTest ? ', test file' : ''}${meta.isEntry ? ', entry point' : ''}).`,
    file.summary ? `Summary: ${file.summary}` : '',
    meta.routes?.length ? `HTTP routes: ${meta.routes.map((r: any) => `${r.method} ${r.path} (line ${r.line})`).join(', ')}` : '',
    meta.security?.length ? `Static security signals (regex; may be false positives):\n${meta.security.filter((s: any) => s.kind !== 'auth').map((s: any) => `- line ${s.line} [${s.kind}] ${String(s.detail).slice(0, 140)}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const run = await agentWithFallback(
    llm,
    {
      system: FILE_SYSTEM,
      messages: [{ role: 'user', content: context }],
      tools: repoTools(ix),
      maxSteps: 12,
      maxTokens: 8000,
      final: { name: 'review', schema: ReviewSchema, description: 'Submit the finished review of this file.' },
      onEvent: agentEventMapper(emit),
      scripted: async (call) => {
        await call('read_file', { path: p }).catch(() => undefined);
        const findings = signalFindings([file], 12);
        findings.push(...(await todoFindings(call, p)).filter((f) => f.path === p));
        if (file.lines > 800) findings.push({ severity: 'low', kind: 'maintainability', title: 'Very large file', path: p, detail: `This file has ${file.lines} lines; consider splitting it by responsibility.` });
        return { final: { summaryMd: staticSummary(findings, `\`${p}\``), findings: sortFindings(findings) } };
      },
    },
    (w) => emit({ type: 'step', step: { id: 'fallback', label: w, tool: 'fallback', status: 'error' } }),
  );
  const review = clean(ix, run.final as Review);
  if (!db.prepare('SELECT 1 FROM repos WHERE id=?').get(repoId)) return;
  const createdAt = save(db, repoId, key, file.hash, review);
  emit({ type: 'result', path: p, review, cached: false, createdAt });
}

// ---------- running reviews ----------
// Reviews run on the server independently of any page: leaving the Review tab does not stop one,
// and coming back (or a second tab) joins the run in progress instead of starting another.

interface LiveReview {
  /** Every event so far, replayed to pages that join late. */
  events: ReviewEvent[];
  listeners: Set<(e: ReviewEvent) => void>;
  done: Promise<void>;
}

const live = new Map<string, LiveReview>();
const liveId = (repoId: string, key: string) => `${repoId}\0${key}`;

/** Start a review, or return the one already running for the same target. */
export function startReview(
  db: DB,
  llm: LLMProvider,
  embeddings: EmbeddingProvider | null,
  repoId: string,
  path: string | null,
  onWarn?: (msg: string) => void,
): LiveReview {
  const id = liveId(repoId, path ? fileKey(path) : FULL_KEY);
  const existing = live.get(id);
  if (existing) return existing;
  const run: LiveReview = { events: [], listeners: new Set(), done: Promise.resolve() };
  const emit = (e: ReviewEvent) => {
    run.events.push(e);
    for (const fn of run.listeners) fn(e);
  };
  live.set(id, run);
  run.done = (path ? runFile(db, llm, embeddings, repoId, path, emit) : runFull(db, llm, embeddings, repoId, emit, onWarn))
    .catch((err) => emit({ type: 'error', message: (err as Error).message }))
    .finally(() => live.delete(id));
  return run;
}

/** Whether a review is running for the full codebase (path null) or a file. */
export function reviewRunning(repoId: string, path: string | null): boolean {
  return live.has(liveId(repoId, path ? fileKey(path) : FULL_KEY));
}

/** Paths of file reviews running for a repo. */
export function runningFileReviews(repoId: string): string[] {
  const prefix = liveId(repoId, 'file:');
  return [...live.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/**
 * Stream a review: join the run in progress, else return the stored review (unless refresh or the
 * file changed), else start a new run. The run keeps going if the client disconnects.
 */
export async function streamReview(
  db: DB,
  llm: LLMProvider,
  embeddings: EmbeddingProvider | null,
  repoId: string,
  req: { path?: string; refresh?: boolean },
  emit: (e: ReviewEvent) => void,
): Promise<void> {
  const path = req.path ? new RepoIndex(db, repoId).requireFile(req.path) : null;
  if (!req.refresh && !reviewRunning(repoId, path)) {
    const hit = stored(db, repoId, path ? fileKey(path) : FULL_KEY);
    // A file review is current for the file's content; a full review for the analyzed commit.
    const current = hit?.version === (path ? (new RepoIndex(db, repoId).fileRow(path) as FileRow).hash : repoVersion(db, repoId));
    if (hit && current) return void emit({ type: 'result', path, review: hit.review, cached: true, createdAt: hit.createdAt });
  }
  const run = startReview(db, llm, embeddings, repoId, path);
  for (const e of run.events) emit(e);
  run.listeners.add(emit);
  try {
    await run.done;
  } finally {
    run.listeners.delete(emit);
  }
}

/** Stored reviews for the sidebar: the full review first, then files by most recent. */
export function listReviews(db: DB, repoId: string): ReviewEntry[] {
  const head = repoVersion(db, repoId);
  const rows = db
    .prepare(`SELECT r.key, r.version, r.content, r.created_at, f.hash FROM reviews r
              LEFT JOIN files f ON f.repo_id = r.repo_id AND r.key = 'file:' || f.path
              WHERE r.repo_id=? ORDER BY r.key != 'full', r.created_at DESC`)
    .all(repoId) as any[];
  return rows.map((r) => {
    const review = json<Review | null>(r.content, null);
    const findings = review?.findings ?? [];
    const worst = findings.length ? findings.reduce((w, f) => (rank(f.severity) < rank(w) ? f.severity : w), findings[0].severity) : null;
    const path = r.key === FULL_KEY ? null : String(r.key).slice('file:'.length);
    return { path, createdAt: r.created_at, findings: findings.length, worst, stale: path ? r.hash !== r.version : r.version !== head };
  });
}

/** A stored review, or null when there is none. */
export function getReview(db: DB, repoId: string, path: string | null): { review: Review; createdAt: string; stale: boolean } | null {
  const hit = stored(db, repoId, path ? fileKey(path) : FULL_KEY);
  if (!hit) return null;
  const version = path ? (db.prepare('SELECT hash FROM files WHERE repo_id=? AND path=?').get(repoId, path) as { hash: string } | undefined)?.hash : repoVersion(db, repoId);
  return { review: hit.review, createdAt: hit.createdAt, stale: hit.version !== version };
}
