import { log, errorDetails, withJobLogs } from '../logging/index.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Architecture, JobEvent, RepoSummary } from '@cq/shared';
import { analysisProgress } from '@cq/shared';
import { config } from '../config.js';
import type { DB } from '../db/index.js';
import { clearAnalysis } from '../db/index.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/index.js';
import { analyzeArchitecture, assignFilesToComponents, heuristicArchitecture } from '../analyze/architecture.js';
import type { RepoContext } from '../analyze/context.js';
import { analyzeInsights } from '../analyze/insights.js';
import { summarizeFiles } from '../analyze/summarize.js';
import { chunkFile } from './chunk.js';
import { cloneRepo, parseRepoUrl } from './clone.js';
import { buildImportGraph, centrality, groupModules, moduleEdges, moduleOf } from './graph.js';
import { MANIFEST_NAMES, parseFile, parseManifest } from './parse.js';
import type { FileFacts } from './parse.js';
import { buildRefs } from './refs.js';
import type { HistoryInfo } from '../history/git.js';
import { indexHistory, repoHistorySummary, storeFileHistorySummaries } from '../history/index.js';
import { repoDir } from '../paths.js';
import { scanRepo } from './scan.js';

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

export { repoDir };

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
  db.prepare(`UPDATE repos SET status='ready', error='Background architecture synthesis interrupted by server restart' WHERE status='enriching'`).run();
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
  let lastStage = '';
  let stageStarted = Date.now();
  return (stage: string, message: string, progress: number, extra: Partial<JobEvent> = {}) => {
    const ev: JobEvent = { jobId, stage, message, progress: Math.max(0, Math.min(1, progress)), ...extra };
    const now = Date.now();
    if (stage !== lastStage) {
      // A stage only ends in failure when the next event is the job's 'failed' event, so the outcome of
      // `lastStage` is decided by the incoming `stage`.
      if (lastStage) log('info', 'analysis.stage.finished', { stage: lastStage, durationMs: now - stageStarted, outcome: stage === 'failed' ? 'failed' : 'completed' });
      log('info', 'analysis.stage.started', { stage, progress: ev.progress });
      stageStarted = now;
    }
    if (stage !== lastStage || now - last > 250 || extra.done || extra.error) {
      lastStage = stage;
      last = now;
      db.prepare(`UPDATE jobs SET stage=?, message=?, progress=?, updated_at=datetime('now') WHERE id=?`).run(stage, message, ev.progress, jobId);
    }
    jobEvents.emit(jobId, ev);
  };
}

export async function runJob(db: DB, llm: LLMProvider, embeddings: EmbeddingProvider | null, jobId: string, repoId: string) {
  return withJobLogs(jobId, repoId, () => executeJob(db, llm, embeddings, jobId, repoId));
}

async function executeJob(db: DB, llm: LLMProvider, embeddings: EmbeddingProvider | null, jobId: string, repoId: string) {
  const started = Date.now();
  log('info', 'analysis.job.started', { provider: llm.name, model: llm.model });
  const emit = emitter(db, jobId);
  const repo = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId) as any;
  if (!repo) return;
  db.prepare(`UPDATE jobs SET status='running' WHERE id=?`).run(jobId);
  db.prepare(`UPDATE repos SET status='running', updated_at=datetime('now') WHERE id=?`).run(repoId);
  const warnings: string[] = [];
  try {
    const dir = repoDir(repoId);
    emit('clone', `Cloning ${repo.url}`, analysisProgress('clone'));
    const { commit, history, warnings: cloneWarnings } = await cloneRepo(parseRepoUrl(repo.url), dir);
    warnings.push(...cloneWarnings);
    if (cloneWarnings.length) log('warn', 'analysis.clone.warnings', { count: cloneWarnings.length });
    db.prepare('UPDATE repos SET commit_sha=?, has_source=1 WHERE id=?').run(commit, repoId);
    await analyzeDirectory(db, llm, embeddings, repoId, dir, (stage, msg, p) => emit(stage, msg, p), (w) => {
      warnings.push(w);
      // Detailed LLM failures are logged at their source; avoid logging raw response data here.
      log('warn', 'analysis.warning', { stage: 'analysis', warningType: /^(insights_(?:architecture|onboarding|security|api)|architecture|agent run failed|Embeddings failed|History indexing failed|Architecture synthesis failed)/.exec(w)?.[0] ?? 'analysis warning' });
    }, history, () => {
      db.prepare("UPDATE repos SET status='enriching', updated_at=datetime('now') WHERE id=?").run(repoId);
      emit('architecture', 'Results available; synthesizing architecture in the background', analysisProgress('architecture'));
    });
    db.prepare(`UPDATE repos SET status='ready', error=?, updated_at=datetime('now') WHERE id=?`).run(warnings.length ? warnings.slice(0, 5).join('\n') : null, repoId);
    db.prepare(`UPDATE jobs SET status='done', progress=1 WHERE id=?`).run(jobId);
    log('info', 'analysis.job.completed', { durationMs: Date.now() - started, warningCount: warnings.length });
    emit('done', warnings.length ? `Ready (with ${warnings.length} warning(s))` : 'Ready', 1, { done: true });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log('error', 'analysis.job.failed', { durationMs: Date.now() - started, ...errorDetails(err) });
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
  reportProgress: (stage: string, message: string, fraction: number) => void,
  warn: (msg: string) => void = () => undefined,
  history: HistoryInfo | null = null,
  onResultsReady: () => void = () => undefined,
): Promise<{ architecture: Architecture }> {
  const progress = (stage: string, message: string, fraction = 0) => reportProgress(stage, message, analysisProgress(stage, fraction));
  const repo = db.prepare('SELECT name FROM repos WHERE id=?').get(repoId) as { name: string };
  progress('scan', 'Scanning files', 0.0);
  const files = scanRepo(dir, { maxFileBytes: config.ingest.maxFileBytes, maxFiles: config.ingest.maxRepoFiles });
  if (!files.length) throw new Error('No readable source files found in the repository');

  progress('parse', `Parsing ${files.length} files`, 0);
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

  progress('index', 'Building search index', 0);
  clearAnalysis(db, repoId);
  const insFile = db.prepare(
    `INSERT INTO files (repo_id, path, lang, size, hash, lines, meta) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, path) DO UPDATE SET lang=excluded.lang, size=excluded.size, hash=excluded.hash, lines=excluded.lines, meta=excluded.meta`,
  );
  const insEdge = db.prepare('INSERT OR IGNORE INTO file_edges (repo_id, src, dst, kind, line) VALUES (?, ?, ?, ?, ?)');
  const insSym = db.prepare('INSERT INTO symbols (repo_id, path, name, kind, line, exported, end_line, parent, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insRef = db.prepare('INSERT INTO refs (repo_id, name, path, line, kind, from_symbol, target_path, target_line, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const refs = buildRefs(files, facts, graph);
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
      for (const s of fx.symbols) insSym.run(repoId, f.path, s.name, s.kind, s.line, s.exported ? 1 : 0, s.endLine ?? s.line, s.parent ?? null, s.signature ?? null);
      for (const c of chunkFile(f.path, f.content)) {
        const info = insChunk.run(repoId, c.path, c.startLine, c.endLine, c.content);
        chunkIds.push({ id: Number(info.lastInsertRowid), text: `${c.path}\n${c.content}` });
      }
    }
    for (const e of graph.edges) insEdge.run(repoId, e.from, e.to, e.kind, e.line);
    for (const r of refs) insRef.run(repoId, r.name, r.path, r.line, r.kind, r.fromSymbol, r.targetPath, r.targetLine, r.confidence);
    for (const [f, pkgs] of graph.external) for (const p of pkgs) insEdge.run(repoId, f, `pkg:${p}`, 'package', null);
  })();

  if (embeddings) {
    progress('embed', `Embedding ${chunkIds.length} chunks`, 0.5);
    try {
      const upd = db.prepare('UPDATE chunks SET embedding=? WHERE id=?');
      for (let i = 0; i < chunkIds.length; i += 256) {
        const slice = chunkIds.slice(i, i + 256);
        const vecs = await embeddings.embed(slice.map((c) => c.text));
        db.transaction(() => slice.forEach((c, j) => upd.run(Buffer.from(vecs[j].buffer), c.id)))();
        progress('embed', `Embedded ${Math.min(i + 256, chunkIds.length)}/${chunkIds.length} chunks`, 0.5 + 0.5 * (Math.min(i + 256, chunkIds.length) / chunkIds.length));
      }
    } catch (err) {
      log('warn', 'analysis.embeddings.failed', errorDetails(err));
      warn(`Embeddings failed (${(err as Error).message}); keyword search only`);
    }
  }

  if (history) {
    progress('history', 'Indexing git history', 0);
    try {
      const { commits } = await indexHistory(db, repoId, dir, history, config.ingest.historyIndexCommits);
      storeFileHistorySummaries(db, repoId);
      progress('history', `Indexed ${commits} commits`, 1);
    } catch (err) {
      log('warn', 'analysis.history.failed', errorDetails(err));
      warn(`History indexing failed: ${(err as Error).message}`);
    }
  }
  ctx.history = repoHistorySummary(db, repoId);
  progress('summarize', 'Summarizing key files', 0);
  ctx.progress = (m, p) => progress('summarize', m, p);
  const fromModel = await summarizeFiles(ctx, { max: config.ingest.maxLlmFiles, concurrency: config.llm.concurrency, cached });
  const updSummary = db.prepare('UPDATE files SET summary=?, summary_hash=? WHERE repo_id=? AND path=?');
  db.transaction(() => {
    for (const f of files) {
      const s = ctx.summaries.get(f.path) ?? null;
      updSummary.run(s, fromModel.has(f.path) ? f.hash : null, repoId, f.path);
    }
  })();

  const arch = heuristicArchitecture(ctx);
  const fileComp = assignFilesToComponents(ctx, arch);

  progress('insights', 'Writing architecture, onboarding, security and API insights', 0);
  ctx.progress = (m, p) => progress('insights', m, p);
  const { insights, questions } = await analyzeInsights(ctx, arch);

  progress('store', 'Saving insights and initial diagram', 0);
  saveAnalysis(db, repoId, arch, insights, questions);
  const updMeta = db.prepare(`UPDATE files SET meta=json_set(coalesce(meta,'{}'), '$.component', ?) WHERE repo_id=? AND path=?`);
  db.transaction(() => {
    for (const [p, c] of fileComp) updMeta.run(c, repoId, p);
  })();

  onResultsReady();
  progress('architecture', 'Synthesizing architecture in the background', 0);
  ctx.progress = (m, p) => progress('architecture', m, p);
  try {
    const synthesized = await analyzeArchitecture(ctx);
    // The architecture insight was written from the heuristic diagram; rewrite it from the final one.
    ctx.progress = (m) => progress('architecture', m, 0.9);
    const archInsights = await analyzeInsights(ctx, synthesized, ['architecture']);
    // Persist only architecture-derived results: users may already be reading or changing other results.
    db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM repos WHERE id=?').get(repoId)) return;
      saveArchitecture(db, repoId, synthesized);
      replaceCategoryInsights(db, repoId, 'architecture', archInsights.insights, archInsights.questions);
      const assignments = assignFilesToComponents(ctx, synthesized);
      db.prepare(`UPDATE files SET meta=json_remove(coalesce(meta,'{}'), '$.component') WHERE repo_id=?`).run(repoId);
      for (const [p, c] of assignments) updMeta.run(c, repoId, p);
    })();
    return { architecture: synthesized };
  } catch (err) {
    log('warn', 'analysis.architecture.failed', errorDetails(err));
    warn(`Architecture synthesis failed: ${(err as Error).message}; keeping static architecture`);
    return { architecture: arch };
  }
}

/** Swap one category's insights and suggested questions, keeping it ahead of the other categories. */
function replaceCategoryInsights(
  db: DB,
  repoId: string,
  category: string,
  insights: { kind: string; title: string; bodyMd: string; severity?: string; refs: unknown[] }[],
  questions: { question: string }[],
) {
  db.prepare('DELETE FROM insights WHERE repo_id=? AND category=?').run(repoId, category);
  db.prepare('DELETE FROM suggested_questions WHERE repo_id=? AND category=?').run(repoId, category);
  const rest = db.prepare('SELECT id FROM insights WHERE repo_id=? ORDER BY position').all(repoId) as { id: number }[];
  const pos = db.prepare('UPDATE insights SET position=? WHERE id=?');
  rest.forEach((r, n) => pos.run(insights.length + n, r.id));
  const ii = db.prepare('INSERT INTO insights (repo_id, category, kind, title, body_md, severity, refs, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insights.forEach((i, n) => ii.run(repoId, category, i.kind, i.title, i.bodyMd, i.severity ?? null, JSON.stringify(i.refs), n));
  const iq = db.prepare('INSERT INTO suggested_questions (repo_id, category, question) VALUES (?, ?, ?)');
  for (const q of questions) iq.run(repoId, category, q.question);
}

export function saveAnalysis(
  db: DB,
  repoId: string,
  arch: Architecture | null,
  insights: { category: string; kind: string; title: string; bodyMd: string; severity?: string; refs: unknown[] }[],
  questions: { category: string; question: string }[],
) {
  db.transaction(() => {
    for (const t of ['insights', 'suggested_questions']) db.prepare(`DELETE FROM ${t} WHERE repo_id=?`).run(repoId);
    if (arch) saveArchitecture(db, repoId, arch);
    else clearArchitecture(db, repoId);
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

/** Remove the diagram and everything cached against its component/connection ids. */
function clearArchitecture(db: DB, repoId: string) {
  for (const table of ['connections', 'components', 'diagram_answers']) db.prepare(`DELETE FROM ${table} WHERE repo_id=?`).run(repoId);
}

/** Replace the diagram. Also used on its own when background synthesis publishes a new architecture. */
function saveArchitecture(db: DB, repoId: string, arch: Architecture) {
  clearArchitecture(db, repoId);

  db.prepare('UPDATE repos SET overview=? WHERE id=?').run(arch.overview, repoId);
  const ic = db.prepare('INSERT INTO components (repo_id, id, name, type, description, responsibilities, paths, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const c of arch.components) {
    const { id, name, type, description, responsibilities, paths, ...extra } = c;
    ic.run(repoId, id, name, type, description, JSON.stringify(responsibilities ?? []), JSON.stringify(paths ?? []), JSON.stringify(extra));
  }
  const ie = db.prepare('INSERT INTO connections (repo_id, id, src, dst, kind, label, description, evidence, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const e of arch.connections) {
    const { id, from, to, kind, label, description, evidence, ...extra } = e;
    ie.run(repoId, id, from, to, kind, label, description, JSON.stringify(evidence ?? []), JSON.stringify(extra));
  }
}
