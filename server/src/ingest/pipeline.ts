import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Architecture, JobEvent, RepoSummary } from '@cq/shared';
import { config } from '../config.js';
import type { DB } from '../db/index.js';
import { clearAnalysis } from '../db/index.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/index.js';
import { analyzeArchitecture, assignFilesToComponents } from '../analyze/architecture.js';
import type { RepoContext } from '../analyze/context.js';
import { analyzeInsights } from '../analyze/insights.js';
import { summarizeFiles } from '../analyze/summarize.js';
import { chunkFile } from './chunk.js';
import { cloneRepo, parseRepoUrl } from './clone.js';
import { buildImportGraph, centrality, groupModules, moduleEdges, moduleOf } from './graph.js';
import { MANIFEST_NAMES, parseFile, parseManifest } from './parse.js';
import type { FileFacts } from './parse.js';
import { scanRepo } from './scan.js';

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

export function repoDir(repoId: string) {
  return path.join(config.reposDir, repoId);
}

export function rowToRepo(r: any): RepoSummary {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    commit: r.commit_sha,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    fileCount: r.file_count ?? 0,
    hasSource: Boolean(r.has_source),
    currentJobId: r.current_job_id,
  };
}

export function createRepo(db: DB, input: string): { repoId: string; jobId: string } {
  const parsed = parseRepoUrl(input);
  const repoId = `${parsed.name.replace(/[^\w.-]+/g, '-').toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;
  const displayUrl = parsed.branch ? `${parsed.url}#${parsed.branch}` : parsed.url;
  db.prepare('INSERT INTO repos (id, name, url, status) VALUES (?, ?, ?, ?)').run(repoId, parsed.name, displayUrl, 'queued');
  const jobId = enqueue(db, repoId);
  return { repoId, jobId };
}

// ---------- simple sequential job queue ----------

const queue: { jobId: string; repoId: string }[] = [];
let running = false;
let deps: { db: DB; llm: LLMProvider; embeddings: EmbeddingProvider | null } | null = null;

export function initJobs(db: DB, llm: LLMProvider, embeddings: EmbeddingProvider | null) {
  deps = { db, llm, embeddings };
  // Jobs interrupted by a restart are marked failed.
  db.prepare(`UPDATE jobs SET status='failed', error='Interrupted by server restart' WHERE status IN ('queued','running')`).run();
  db.prepare(`UPDATE repos SET status='failed', error='Interrupted by server restart' WHERE status IN ('queued','running')`).run();
}

export function enqueue(db: DB, repoId: string): string {
  const jobId = crypto.randomUUID();
  db.prepare('INSERT INTO jobs (id, repo_id, stage, status) VALUES (?, ?, ?, ?)').run(jobId, repoId, 'queued', 'queued');
  db.prepare(`UPDATE repos SET status='queued', error=NULL, current_job_id=?, updated_at=datetime('now') WHERE id=?`).run(jobId, repoId);
  queue.push({ jobId, repoId });
  void drain();
  return jobId;
}

async function drain() {
  if (running || !deps) return;
  running = true;
  try {
    while (queue.length) {
      const { jobId, repoId } = queue.shift()!;
      await runJob(deps.db, deps.llm, deps.embeddings, jobId, repoId);
    }
  } finally {
    running = false;
  }
}

function emitter(db: DB, jobId: string) {
  let last = 0;
  return (stage: string, message: string, progress: number, extra: Partial<JobEvent> = {}) => {
    const ev: JobEvent = { jobId, stage, message, progress: Math.max(0, Math.min(1, progress)), ...extra };
    const now = Date.now();
    if (now - last > 250 || extra.done || extra.error) {
      last = now;
      db.prepare(`UPDATE jobs SET stage=?, message=?, progress=?, updated_at=datetime('now') WHERE id=?`).run(stage, message, ev.progress, jobId);
    }
    jobEvents.emit(jobId, ev);
  };
}

export async function runJob(db: DB, llm: LLMProvider, embeddings: EmbeddingProvider | null, jobId: string, repoId: string) {
  const emit = emitter(db, jobId);
  const repo = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId) as any;
  if (!repo) return;
  db.prepare(`UPDATE jobs SET status='running' WHERE id=?`).run(jobId);
  db.prepare(`UPDATE repos SET status='running', updated_at=datetime('now') WHERE id=?`).run(repoId);
  const warnings: string[] = [];
  try {
    const dir = repoDir(repoId);
    emit('clone', `Cloning ${repo.url}`, 0.02);
    const { commit } = await cloneRepo(parseRepoUrl(repo.url), dir);
    db.prepare('UPDATE repos SET commit_sha=?, has_source=1 WHERE id=?').run(commit, repoId);
    await analyzeDirectory(db, llm, embeddings, repoId, dir, (stage, msg, p) => emit(stage, msg, 0.08 + p * 0.9), (w) => warnings.push(w));
    db.prepare(`UPDATE repos SET status='ready', error=?, updated_at=datetime('now') WHERE id=?`).run(warnings.length ? warnings.slice(0, 5).join('\n') : null, repoId);
    db.prepare(`UPDATE jobs SET status='done', progress=1 WHERE id=?`).run(jobId);
    emit('done', warnings.length ? `Ready (with ${warnings.length} warning(s))` : 'Ready', 1, { done: true });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    console.error(`[job ${jobId}]`, err);
    db.prepare(`UPDATE repos SET status='failed', error=?, updated_at=datetime('now') WHERE id=?`).run(msg, repoId);
    db.prepare(`UPDATE jobs SET status='failed', error=? WHERE id=?`).run(msg, jobId);
    emit('failed', msg, 1, { done: true, error: msg });
  }
}

/** Run static ingestion + LLM analysis over a checked-out directory and persist everything. */
export async function analyzeDirectory(
  db: DB,
  llm: LLMProvider,
  embeddings: EmbeddingProvider | null,
  repoId: string,
  dir: string,
  progress: (stage: string, message: string, fraction: number) => void,
  warn: (msg: string) => void = () => undefined,
): Promise<{ architecture: Architecture }> {
  const repo = db.prepare('SELECT name FROM repos WHERE id=?').get(repoId) as { name: string };
  progress('scan', 'Scanning files', 0.0);
  const files = scanRepo(dir, { maxFileBytes: config.ingest.maxFileBytes, maxFiles: config.ingest.maxRepoFiles });
  if (!files.length) throw new Error('No readable source files found in the repository');

  progress('parse', `Parsing ${files.length} files`, 0.04);
  const facts = new Map<string, FileFacts>();
  for (const f of files) facts.set(f.path, parseFile(f.path, f.lang, f.content));
  const manifestFiles = new Map<string, string>();
  const allDeps = files.filter((f) => MANIFEST_NAMES.test(f.path)).flatMap((f) => {
    manifestFiles.set(f.path, f.content);
    return parseManifest(f.path, f.content);
  });
  const graph = buildImportGraph(files, facts, manifestFiles);
  const groups = groupModules(files);
  const fileToModule = moduleOf(groups);
  const readmeFile = files.find((f) => /^readme(\.\w+)?$/i.test(f.path)) ?? files.find((f) => /(^|\/)readme(\.\w+)?$/i.test(f.path));

  const ctx: RepoContext = {
    repoName: repo.name,
    files,
    fileByPath: new Map(files.map((f) => [f.path, f])),
    facts,
    deps: allDeps,
    graph,
    groups,
    fileToModule,
    moduleEdges: moduleEdges(graph.edges, fileToModule),
    centrality: centrality(graph.edges),
    readme: readmeFile?.content ?? null,
    summaries: new Map(),
    llm,
    warn,
    progress: () => undefined,
  };

  // Previous summaries are reused when the file content hash is unchanged.
  const cached = new Map<string, { hash: string; summary: string }>();
  for (const r of db.prepare('SELECT path, summary, summary_hash FROM files WHERE repo_id=? AND summary_hash IS NOT NULL').all(repoId) as any[]) {
    cached.set(r.path, { hash: r.summary_hash, summary: r.summary });
  }

  progress('index', 'Building search index', 0.08);
  clearAnalysis(db, repoId);
  const insFile = db.prepare(
    `INSERT INTO files (repo_id, path, lang, size, hash, lines, meta) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, path) DO UPDATE SET lang=excluded.lang, size=excluded.size, hash=excluded.hash, lines=excluded.lines, meta=excluded.meta`,
  );
  const insEdge = db.prepare('INSERT OR IGNORE INTO file_edges (repo_id, src, dst, kind, line) VALUES (?, ?, ?, ?, ?)');
  const insSym = db.prepare('INSERT INTO symbols (repo_id, path, name, kind, line, exported) VALUES (?, ?, ?, ?, ?, ?)');
  const insChunk = db.prepare('INSERT INTO chunks (repo_id, path, start_line, end_line, content) VALUES (?, ?, ?, ?, ?)');
  const chunkIds: { id: number; text: string }[] = [];
  db.transaction(() => {
    const present = new Set(files.map((f) => f.path));
    for (const r of db.prepare('SELECT path FROM files WHERE repo_id=?').all(repoId) as { path: string }[]) {
      if (!present.has(r.path)) db.prepare('DELETE FROM files WHERE repo_id=? AND path=?').run(repoId, r.path);
    }
    for (const f of files) {
      const fx = facts.get(f.path)!;
      const meta = { routes: fx.routes, security: fx.security, infra: fx.infra, env: fx.envVars, isEntry: fx.isEntry, isTest: fx.isTest, module: fileToModule.get(f.path) };
      insFile.run(repoId, f.path, f.lang, f.size, f.hash, f.lines, JSON.stringify(meta));
      for (const s of fx.symbols) insSym.run(repoId, f.path, s.name, s.kind, s.line, s.exported ? 1 : 0);
      for (const c of chunkFile(f.path, f.content)) {
        const info = insChunk.run(repoId, c.path, c.startLine, c.endLine, c.content);
        chunkIds.push({ id: Number(info.lastInsertRowid), text: `${c.path}\n${c.content}` });
      }
    }
    for (const e of graph.edges) insEdge.run(repoId, e.from, e.to, e.kind, e.line);
    for (const [f, pkgs] of graph.external) for (const p of pkgs) insEdge.run(repoId, f, `pkg:${p}`, 'package', null);
  })();

  if (embeddings) {
    progress('embed', `Embedding ${chunkIds.length} chunks`, 0.12);
    try {
      const upd = db.prepare('UPDATE chunks SET embedding=? WHERE id=?');
      for (let i = 0; i < chunkIds.length; i += 256) {
        const slice = chunkIds.slice(i, i + 256);
        const vecs = await embeddings.embed(slice.map((c) => c.text));
        db.transaction(() => slice.forEach((c, j) => upd.run(Buffer.from(vecs[j].buffer), c.id)))();
        progress('embed', `Embedded ${Math.min(i + 256, chunkIds.length)}/${chunkIds.length} chunks`, 0.12 + 0.1 * ((i + 256) / chunkIds.length));
      }
    } catch (err) {
      warn(`Embeddings failed (${(err as Error).message}); keyword search only`);
    }
  }

  progress('summarize', 'Summarizing key files', 0.25);
  ctx.progress = (m, p) => progress('summarize', m, 0.25 + 0.35 * p);
  const fromModel = await summarizeFiles(ctx, { max: config.ingest.maxLlmFiles, concurrency: config.llm.concurrency, cached });
  const updSummary = db.prepare('UPDATE files SET summary=?, summary_hash=? WHERE repo_id=? AND path=?');
  db.transaction(() => {
    for (const f of files) {
      const s = ctx.summaries.get(f.path) ?? null;
      updSummary.run(s, fromModel.has(f.path) ? f.hash : null, repoId, f.path);
    }
  })();

  progress('architecture', 'Synthesizing architecture', 0.62);
  const arch = await analyzeArchitecture(ctx);
  const fileComp = assignFilesToComponents(ctx, arch);

  progress('insights', 'Writing onboarding, security and API insights', 0.75);
  ctx.progress = (m, p) => progress('insights', m, 0.75 + 0.22 * p);
  const { insights, questions } = await analyzeInsights(ctx, arch);

  progress('store', 'Saving knowledge base', 0.98);
  saveAnalysis(db, repoId, arch, insights, questions);
  const updMeta = db.prepare(`UPDATE files SET meta=json_set(coalesce(meta,'{}'), '$.component', ?) WHERE repo_id=? AND path=?`);
  db.transaction(() => {
    for (const [p, c] of fileComp) updMeta.run(c, repoId, p);
  })();
  return { architecture: arch };
}

export function saveAnalysis(
  db: DB,
  repoId: string,
  arch: Architecture | null,
  insights: { category: string; kind: string; title: string; bodyMd: string; severity?: string; refs: unknown[] }[],
  questions: { category: string; question: string }[],
) {
  db.transaction(() => {
    for (const t of ['components', 'connections', 'insights', 'suggested_questions']) db.prepare(`DELETE FROM ${t} WHERE repo_id=?`).run(repoId);
    if (arch) {
      db.prepare('UPDATE repos SET overview=? WHERE id=?').run(arch.overview, repoId);
      const ic = db.prepare('INSERT INTO components (repo_id, id, name, type, description, responsibilities, paths) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const c of arch.components) ic.run(repoId, c.id, c.name, c.type, c.description, JSON.stringify(c.responsibilities), JSON.stringify(c.paths));
      const ie = db.prepare('INSERT INTO connections (repo_id, id, src, dst, kind, label, description, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const e of arch.connections) ie.run(repoId, e.id, e.from, e.to, e.kind, e.label, e.description, JSON.stringify(e.evidence));
    }
    const ii = db.prepare('INSERT INTO insights (repo_id, category, kind, title, body_md, severity, refs, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insights.forEach((i, n) => ii.run(repoId, i.category, i.kind, i.title, i.bodyMd, i.severity ?? null, JSON.stringify(i.refs), n));
    const iq = db.prepare('INSERT INTO suggested_questions (repo_id, category, question) VALUES (?, ?, ?)');
    for (const q of questions) iq.run(repoId, q.category, q.question);
  })();
}

export function deleteRepo(db: DB, repoId: string) {
  db.prepare('DELETE FROM repos WHERE id=?').run(repoId);
  fs.rmSync(repoDir(repoId), { recursive: true, force: true });
}
