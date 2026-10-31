import crypto from 'node:crypto';
import type { Architecture, ProjectExport } from '@cq/shared';
import { EXPORT_FORMAT, ExportSchema } from '@cq/shared';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import { getArchitecture } from '../routes/queries.js';
import { saveAnalysis } from '../ingest/pipeline.js';
import { storeFileHistorySummaries } from '../history/index.js';

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
  out.explanations = (db.prepare('SELECT key, file_hash, content, created_at FROM explanations WHERE repo_id=?').all(repoId) as any[]).map((r) => ({ key: r.key, fileHash: r.file_hash, content: r.content, createdAt: r.created_at }));
  out.reviews = (db.prepare('SELECT key, version, content, created_at FROM reviews WHERE repo_id=?').all(repoId) as any[]).map((r) => ({ key: r.key, version: r.version, content: r.content, createdAt: r.created_at }));
  out.symbols = (db.prepare('SELECT path, name, kind, line, end_line, exported, parent, signature FROM symbols WHERE repo_id=?').all(repoId) as any[]).map((s) => ({
    path: s.path, name: s.name, kind: s.kind, line: s.line, endLine: s.end_line ?? s.line, exported: Boolean(s.exported), parent: s.parent, signature: s.signature,
  }));
  const commits = db.prepare('SELECT sha, seq, author, date, subject, body FROM commits WHERE repo_id=? ORDER BY seq LIMIT 2000').all(repoId) as any[];
  if (commits.length) {
    const shas = new Set(commits.map((c) => c.sha));
    out.history = {
      commits,
      fileCommits: (db.prepare('SELECT path, sha, status, old_path, added, deleted FROM file_commits WHERE repo_id=?').all(repoId) as any[])
        .filter((f) => shas.has(f.sha))
        .map((f) => ({ path: f.path, sha: f.sha, status: f.status, oldPath: f.old_path, added: f.added, deleted: f.deleted })),
      shallow: Boolean(repo.history_shallow),
      root: repo.history_root,
      boundaries: json<string[]>(repo.history_boundaries, repo.history_shallow && repo.history_root ? [repo.history_root] : []),
      total: Math.max(repo.history_total ?? 0, (db.prepare('SELECT count(*) AS n FROM commits WHERE repo_id=?').get(repoId) as any).n),
    };
  }
  if (includeSource) {
    out.refs = (db.prepare('SELECT * FROM refs WHERE repo_id=?').all(repoId) as any[]).map((r) => ({
      name: r.name, path: r.path, line: r.line, kind: r.kind, fromSymbol: r.from_symbol, targetPath: r.target_path, targetLine: r.target_line, confidence: r.confidence,
    }));
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
    const insX = db.prepare('INSERT OR REPLACE INTO explanations (repo_id, key, file_hash, content, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const x of p.explanations ?? []) insX.run(repoId, x.key, x.fileHash, x.content, x.createdAt);
    const insRv = db.prepare('INSERT OR REPLACE INTO reviews (repo_id, key, version, content, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const x of p.reviews ?? []) insRv.run(repoId, x.key, x.version, x.content, x.createdAt);
    const insS = db.prepare('INSERT INTO symbols (repo_id, path, name, kind, line, exported, end_line, parent, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of p.symbols ?? []) insS.run(repoId, s.path, s.name, s.kind, s.line, s.exported ? 1 : 0, s.endLine, s.parent, s.signature);
    if (p.history) {
      const insC = db.prepare('INSERT OR REPLACE INTO commits (repo_id, sha, seq, author, date, subject, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const c of p.history.commits) insC.run(repoId, c.sha, c.seq, c.author, c.date, c.subject, c.body);
      const insFc = db.prepare('INSERT INTO file_commits (repo_id, path, sha, status, old_path, added, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const f of p.history.fileCommits) insFc.run(repoId, f.path, f.sha, f.status, f.oldPath, f.added, f.deleted);
      db.prepare('UPDATE repos SET history_shallow=?, history_root=?, history_boundaries=?, history_total=?, history_capped=? WHERE id=?').run(
        p.history.shallow ? 1 : 0,
        p.history.root,
        JSON.stringify(p.history.boundaries ?? (p.history.shallow && p.history.root ? [p.history.root] : [])),
        p.history.total ?? p.history.commits.length,
        (p.history.total ?? 0) > p.history.commits.length ? 1 : 0,
        repoId,
      );
    }
    const insR = db.prepare('INSERT INTO refs (repo_id, name, path, line, kind, from_symbol, target_path, target_line, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of p.refs ?? []) insR.run(repoId, r.name, r.path, r.line, r.kind, r.fromSymbol, r.targetPath, r.targetLine, r.confidence);
    if (p.chunks?.length) db.prepare('UPDATE repos SET has_source=1 WHERE id=?').run(repoId);
    if (p.history) storeFileHistorySummaries(db, repoId);
  })();
  return repoId;
}
