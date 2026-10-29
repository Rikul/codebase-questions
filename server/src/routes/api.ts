import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { AskEvent, AskRequest, Category, JobEvent } from '@cq/shared';
import { CategorySchema } from '@cq/shared';
import { z } from 'zod';
import type { Auth } from '../auth.js';
import { COOKIE_NAME, mintCode } from '../auth.js';
import { config } from '../config.js';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import { exportProject, importProject } from '../export/export.js';
import { createRepo, deleteRepo, enqueue, jobEvents, rowToRepo } from '../ingest/pipeline.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/index.js';
import { answerQuestion } from '../qa/answer.js';
import { invalidateVectors } from '../qa/retrieve.js';
import { fileContent, fileTree, getArchitecture, snippet } from './queries.js';

const AskSchema = z.object({
  question: z.string().min(1).max(4000),
  category: CategorySchema.optional(),
  conversationId: z.number().int().optional(),
  focus: z.object({ componentId: z.string().optional(), connectionId: z.string().optional(), path: z.string().optional() }).optional(),
});

function sse(res: Response) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  return (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function apiRouter(db: DB, llm: LLMProvider, embeddings: EmbeddingProvider | null, auth: Auth) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

  // ---------- public ----------
  r.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  r.get('/auth/status', (req, res) => {
    res.json({ authenticated: config.auth.disabled || auth.verify(req.cookies?.[COOKIE_NAME]), authDisabled: config.auth.disabled });
  });
  r.post('/auth/redeem', (req, res) => {
    const code = String(req.body?.code ?? '');
    const out = auth.redeem(code, req.ip ?? 'unknown');
    if ('error' in out) return void res.status(out.status).json({ error: out.error });
    res.cookie(COOKIE_NAME, out.token, auth.cookieOptions());
    res.json({ ok: true });
  });
  r.post('/auth/logout', (req, res) => {
    auth.revoke(req.cookies?.[COOKIE_NAME]);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  // ---------- everything below requires a session ----------
  r.use(auth.middleware());

  r.post('/auth/rotate', (_req, res) => {
    // Lets a signed-in user mint a code for another device/browser.
    res.json({ code: mintCode(db) });
  });

  r.get('/config', (_req, res) => {
    res.json({ provider: llm.name, model: llm.model, embeddings: embeddings?.name ?? null });
  });

  const repoSelect = `SELECT r.*, (SELECT count(*) FROM files f WHERE f.repo_id = r.id) AS file_count FROM repos r`;
  r.get('/repos', (_req, res) => {
    res.json((db.prepare(`${repoSelect} ORDER BY r.created_at DESC`).all() as any[]).map(rowToRepo));
  });

  r.post('/repos', (req, res) => {
    try {
      const { repoId, jobId } = createRepo(db, String(req.body?.url ?? ''));
      res.status(201).json({ repoId, jobId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.post('/repos/import', upload.single('file'), (req, res) => {
    try {
      const raw = req.file ? req.file.buffer.toString('utf8') : JSON.stringify(req.body);
      const repoId = importProject(db, JSON.parse(raw));
      res.status(201).json({ repoId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  const getRepo = (req: Request, res: Response) => {
    const row = db.prepare(`${repoSelect} WHERE r.id=?`).get(req.params.id);
    if (!row) res.status(404).json({ error: 'Repository not found' });
    return row as any;
  };

  r.get('/repos/:id', (req, res) => {
    const row = getRepo(req, res);
    if (row) res.json(rowToRepo(row));
  });

  r.delete('/repos/:id', (req, res) => {
    if (!getRepo(req, res)) return;
    deleteRepo(db, req.params.id);
    invalidateVectors(req.params.id);
    res.json({ ok: true });
  });

  r.post('/repos/:id/reanalyze', (req, res) => {
    const row = getRepo(req, res);
    if (!row) return;
    if (row.status === 'running' || row.status === 'queued') return void res.status(409).json({ error: 'Analysis already in progress' });
    invalidateVectors(row.id);
    res.json({ jobId: enqueue(db, row.id) });
  });

  r.get('/jobs/:id/events', (req, res) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id) as any;
    if (!job) return void res.status(404).json({ error: 'Job not found' });
    const send = sse(res);
    send({ jobId: job.id, stage: job.stage, message: job.message, progress: job.progress, done: job.status === 'done' || job.status === 'failed', error: job.error ?? undefined } satisfies JobEvent);
    if (job.status === 'done' || job.status === 'failed') return void res.end();
    const on = (ev: JobEvent) => {
      send(ev);
      if (ev.done) cleanup();
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    const cleanup = () => {
      clearInterval(ping);
      jobEvents.off(job.id, on);
      res.end();
    };
    jobEvents.on(job.id, on);
    req.on('close', cleanup);
  });

  r.get('/repos/:id/architecture', (req, res) => {
    if (getRepo(req, res)) res.json(getArchitecture(db, req.params.id));
  });

  r.get('/repos/:id/components/:cid', (req, res) => {
    if (!getRepo(req, res)) return;
    const arch = getArchitecture(db, req.params.id);
    const c = arch.components.find((x) => x.id === req.params.cid);
    if (!c) return void res.status(404).json({ error: 'Component not found' });
    const files = (db.prepare(`SELECT path, lang, lines, summary FROM files WHERE repo_id=? AND json_extract(meta, '$.component') = ? ORDER BY path`).all(req.params.id, c.id) as any[]).slice(0, 300);
    const incoming = arch.connections.filter((e) => e.to === c.id);
    const outgoing = arch.connections.filter((e) => e.from === c.id);
    res.json({ component: c, files, incoming, outgoing });
  });

  r.get('/repos/:id/connections/:eid', (req, res) => {
    if (!getRepo(req, res)) return;
    const arch = getArchitecture(db, req.params.id);
    const e = arch.connections.find((x) => x.id === req.params.eid);
    if (!e) return void res.status(404).json({ error: 'Connection not found' });
    const snippets = e.evidence.slice(0, 6).map((ev) => ({ ...snippet(db, req.params.id, ev.path, ev.startLine, ev.endLine), note: ev.note ?? null })).filter((s) => s.code != null);
    res.json({ connection: e, from: arch.components.find((c) => c.id === e.from), to: arch.components.find((c) => c.id === e.to), snippets });
  });

  /** File-level import graph, optionally scoped to one component. */
  r.get('/repos/:id/graph', (req, res) => {
    if (!getRepo(req, res)) return;
    const scope = typeof req.query.scope === 'string' ? req.query.scope : null;
    const files = db.prepare(`SELECT path, lang, lines, summary, json_extract(meta, '$.component') AS component FROM files WHERE repo_id=?`).all(req.params.id) as any[];
    const inScope = new Set(files.filter((f) => !scope || f.component === scope).map((f) => f.path));
    const edges = (db.prepare(`SELECT src, dst, kind, line FROM file_edges WHERE repo_id=? AND kind='import'`).all(req.params.id) as any[]).filter((e) => inScope.has(e.src) || inScope.has(e.dst));
    const touched = new Set([...inScope, ...edges.flatMap((e) => [e.src, e.dst])]);
    const nodes = files.filter((f) => touched.has(f.path) && (inScope.has(f.path) || f.component !== scope)).slice(0, 400);
    const ids = new Set(nodes.map((n) => n.path));
    res.json({
      nodes: nodes.map((n) => ({ path: n.path, lang: n.lang, lines: n.lines, summary: n.summary, component: n.component, external: !inScope.has(n.path) })),
      edges: edges.filter((e) => ids.has(e.src) && ids.has(e.dst)).map((e) => ({ from: e.src, to: e.dst, line: e.line })),
    });
  });

  r.get('/repos/:id/insights', (req, res) => {
    if (!getRepo(req, res)) return;
    const cat = CategorySchema.safeParse(req.query.category);
    const rows = (cat.success
      ? db.prepare('SELECT * FROM insights WHERE repo_id=? AND category=? ORDER BY position').all(req.params.id, cat.data)
      : db.prepare('SELECT * FROM insights WHERE repo_id=? ORDER BY position').all(req.params.id)) as any[];
    const questions = (cat.success
      ? db.prepare('SELECT category, question FROM suggested_questions WHERE repo_id=? AND category=?').all(req.params.id, cat.data)
      : db.prepare('SELECT category, question FROM suggested_questions WHERE repo_id=?').all(req.params.id)) as any[];
    res.json({
      insights: rows.map((i) => ({ id: i.id, category: i.category, kind: i.kind, title: i.title, bodyMd: i.body_md, severity: i.severity ?? undefined, refs: json(i.refs, []) })),
      questions,
    });
  });

  r.get('/repos/:id/files', (req, res) => {
    if (!getRepo(req, res)) return;
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p) return void res.json(fileTree(db, req.params.id));
    const content = fileContent(db, req.params.id, p);
    if (content == null) return void res.status(404).json({ error: 'File not found' });
    const meta = db.prepare('SELECT lang, summary, meta FROM files WHERE repo_id=? AND path=?').get(req.params.id, p) as any;
    const symbols = db.prepare('SELECT name, kind, line, exported FROM symbols WHERE repo_id=? AND path=? ORDER BY line').all(req.params.id, p);
    const importsOut = db.prepare(`SELECT dst AS path, line FROM file_edges WHERE repo_id=? AND src=?`).all(req.params.id, p);
    const importedBy = db.prepare(`SELECT src AS path, line FROM file_edges WHERE repo_id=? AND dst=?`).all(req.params.id, p);
    res.json({ path: p, lang: meta.lang, summary: meta.summary, meta: json(meta.meta, {}), content, symbols, imports: importsOut, importedBy });
  });

  r.get('/repos/:id/conversations', (req, res) => {
    if (!getRepo(req, res)) return;
    res.json(db.prepare('SELECT id, title, created_at AS createdAt FROM conversations WHERE repo_id=? ORDER BY id DESC').all(req.params.id));
  });
  r.get('/repos/:id/conversations/:cid', (req, res) => {
    if (!getRepo(req, res)) return;
    const conv = db.prepare('SELECT 1 FROM conversations WHERE id=? AND repo_id=?').get(req.params.cid, req.params.id);
    if (!conv) return void res.status(404).json({ error: 'Conversation not found' });
    const msgs = (db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(req.params.cid) as any[]).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      category: m.category,
      citations: json(m.citations, []),
      createdAt: m.created_at,
    }));
    res.json(msgs);
  });
  r.delete('/repos/:id/conversations/:cid', (req, res) => {
    if (!getRepo(req, res)) return;
    db.prepare('DELETE FROM conversations WHERE id=? AND repo_id=?').run(req.params.cid, req.params.id);
    res.json({ ok: true });
  });

  r.post('/repos/:id/ask', async (req, res) => {
    const row = getRepo(req, res);
    if (!row) return;
    const parsed = AskSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0].message });
    const send = sse(res);
    let closed = false;
    res.on('close', () => (closed = true));
    try {
      for await (const ev of answerQuestion(db, llm, embeddings, row.id, parsed.data as AskRequest)) {
        if (closed) break;
        send(ev satisfies AskEvent);
      }
    } catch (err) {
      send({ type: 'error', message: (err as Error).message } satisfies AskEvent);
    }
    res.end();
  });

  r.get('/repos/:id/export', (req, res) => {
    const row = getRepo(req, res);
    if (!row) return;
    const data = exportProject(db, row.id, req.query.includeSource === 'true');
    const date = new Date().toISOString().slice(0, 10);
    const name = `${row.name.replace(/[^\w.-]+/g, '-')}-${date}.codebase.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(JSON.stringify(data, null, 2));
  });

  return r;
}

export type { Category };
