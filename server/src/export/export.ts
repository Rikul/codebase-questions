import crypto from 'node:crypto';
import type { Architecture, ProjectExport } from '@cq/shared';
import { EXPORT_FORMAT, ExportSchema } from '@cq/shared';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import { getArchitecture } from '../routes/queries.js';
import { saveAnalysis } from '../ingest/pipeline.js';

export function exportProject(db: DB, repoId: string, includeSource: boolean): ProjectExport {
  const repo = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId) as any;
  if (!repo) throw new Error('Repository not found');
  const files = (db.prepare('SELECT path, lang, size, hash, summary FROM files WHERE repo_id=? ORDER BY path').all(repoId) as any[]).map((f) => ({
    path: f.path,
    lang: f.lang,
    size: f.size,
    hash: f.hash,
    summary: f.summary,
  }));
  const fileEdges = (db.prepare(`SELECT src, dst, kind FROM file_edges WHERE repo_id=?`).all(repoId) as any[]).map((e) => ({ from: e.src, to: e.dst, kind: e.kind }));
  const arch = getArchitecture(db, repoId);
  const insights = (db.prepare('SELECT * FROM insights WHERE repo_id=? ORDER BY position').all(repoId) as any[]).map((i) => ({
    category: i.category,
    kind: i.kind,
    title: i.title,
    bodyMd: i.body_md,
    ...(i.severity ? { severity: i.severity } : {}),
    refs: json(i.refs, []),
  }));
  const suggestedQuestions = db.prepare('SELECT category, question FROM suggested_questions WHERE repo_id=?').all(repoId) as any[];
  const conversations = (db.prepare('SELECT * FROM conversations WHERE repo_id=? ORDER BY id').all(repoId) as any[]).map((c) => ({
    title: c.title,
    createdAt: c.created_at,
    messages: (db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id').all(c.id) as any[]).map((m) => ({
      role: m.role,
      content: m.content,
      category: m.category,
      citations: json(m.citations, []),
      createdAt: m.created_at,
    })),
  }));
  const out: ProjectExport = {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    repo: { name: repo.name, url: repo.url, commit: repo.commit_sha },
    files,
    fileEdges,
    architecture: arch.components.length ? arch : null,
    insights,
    suggestedQuestions,
    conversations,
  };
  if (includeSource) {
    out.chunks = (db.prepare('SELECT path, start_line, end_line, content FROM chunks WHERE repo_id=? ORDER BY id').all(repoId) as any[]).map((c) => ({
      path: c.path,
      startLine: c.start_line,
      endLine: c.end_line,
      content: c.content,
    }));
  }
  return out;
}

export function importProject(db: DB, data: unknown): string {
  const parsed = ExportSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid export file: ${issue.path.join('.')}: ${issue.message}`);
  }
  const p = parsed.data;
  const repoId = `${p.repo.name.replace(/[^\w.-]+/g, '-').toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;
  db.transaction(() => {
    db.prepare(`INSERT INTO repos (id, name, url, commit_sha, status, has_source) VALUES (?, ?, ?, ?, 'imported', 0)`).run(repoId, p.repo.name, p.repo.url, p.repo.commit);
    const lines = new Map<string, number>();
    for (const c of p.chunks ?? []) lines.set(c.path, Math.max(lines.get(c.path) ?? 0, c.endLine));
    const insF = db.prepare('INSERT OR IGNORE INTO files (repo_id, path, lang, size, hash, lines, summary) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of p.files) insF.run(repoId, f.path, f.lang, f.size, f.hash, lines.get(f.path) ?? 0, f.summary);
    const insE = db.prepare('INSERT OR IGNORE INTO file_edges (repo_id, src, dst, kind) VALUES (?, ?, ?, ?)');
    for (const e of p.fileEdges) insE.run(repoId, e.from, e.to, e.kind);
    const insC = db.prepare('INSERT INTO chunks (repo_id, path, start_line, end_line, content) VALUES (?, ?, ?, ?, ?)');
    if (p.chunks?.length) for (const c of p.chunks) insC.run(repoId, c.path, c.startLine, c.endLine, c.content);
    else for (const f of p.files) if (f.summary) insC.run(repoId, f.path, 1, 1, `${f.path}\n${f.summary}`); // summaries stay searchable
    for (const c of p.conversations) {
      const cid = Number(db.prepare('INSERT INTO conversations (repo_id, title, created_at) VALUES (?, ?, ?)').run(repoId, c.title, c.createdAt).lastInsertRowid);
      const insM = db.prepare('INSERT INTO messages (conversation_id, role, content, category, citations, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const m of c.messages) insM.run(cid, m.role, m.content, m.category, JSON.stringify(m.citations), m.createdAt);
    }
    saveAnalysis(db, repoId, p.architecture as Architecture | null, p.insights, p.suggestedQuestions);
    if (p.chunks?.length) db.prepare('UPDATE repos SET has_source=1 WHERE id=?').run(repoId);
  })();
  return repoId;
}
