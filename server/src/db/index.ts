import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  commit_sha TEXT,
  status TEXT NOT NULL,
  error TEXT,
  has_source INTEGER NOT NULL DEFAULT 1,
  overview TEXT,
  current_job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  lang TEXT,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  summary_hash TEXT,
  meta TEXT,
  PRIMARY KEY (repo_id, path)
);

CREATE TABLE IF NOT EXISTS file_edges (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER,
  PRIMARY KEY (repo_id, src, dst, kind)
);

CREATE TABLE IF NOT EXISTS symbols (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS symbols_repo_name ON symbols(repo_id, name);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_repo_path ON chunks(repo_id, path);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content, path, repo_id UNINDEXED, content='chunks', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, path, repo_id) VALUES (new.id, new.content, new.path, new.repo_id);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, path, repo_id) VALUES ('delete', old.id, old.content, old.path, old.repo_id);
END;

CREATE TABLE IF NOT EXISTS components (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  responsibilities TEXT NOT NULL DEFAULT '[]',
  paths TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (repo_id, id)
);

CREATE TABLE IF NOT EXISTS connections (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (repo_id, id)
);

CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  severity TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS insights_repo_cat ON insights(repo_id, category);

CREATE TABLE IF NOT EXISTS suggested_questions (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  question TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  citations TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refs (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  kind TEXT NOT NULL,
  from_symbol TEXT,
  target_path TEXT,
  target_line INTEGER,
  confidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refs_target ON refs(repo_id, target_path, name);
CREATE INDEX IF NOT EXISTS refs_name ON refs(repo_id, name);
CREATE INDEX IF NOT EXISTS refs_path ON refs(repo_id, path, line);

CREATE TABLE IF NOT EXISTS explanations (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, key)
);

CREATE TABLE IF NOT EXISTS flows (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, id)
);

CREATE TABLE IF NOT EXISTS diagram_answers (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, question)
);

CREATE TABLE IF NOT EXISTS commits (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  seq INTEGER NOT NULL,
  author TEXT NOT NULL,
  email_hash TEXT,
  date TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT,
  PRIMARY KEY (repo_id, sha)
);
CREATE INDEX IF NOT EXISTS commits_seq ON commits(repo_id, seq);

CREATE TABLE IF NOT EXISTS file_commits (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha TEXT NOT NULL,
  status TEXT NOT NULL,
  old_path TEXT,
  added INTEGER,
  deleted INTEGER
);
CREATE INDEX IF NOT EXISTS file_commits_path ON file_commits(repo_id, path);
CREATE INDEX IF NOT EXISTS file_commits_sha ON file_commits(repo_id, sha);

CREATE TABLE IF NOT EXISTS symbol_history (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (repo_id, key)
);

CREATE TABLE IF NOT EXISTS auth_codes (
  hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive column migrations for databases created by earlier versions. */
function migrate(db: DB) {
  const add = (table: string, col: string, decl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };
  add('repos', 'history_depth', 'INTEGER');
  add('repos', 'history_shallow', 'INTEGER');
  add('repos', 'history_root', 'TEXT');
  add('symbols', 'end_line', 'INTEGER');
  add('symbols', 'parent', 'TEXT');
  add('symbols', 'signature', 'TEXT');
  // Extra architecture fields (layer, group, protocol, confidence, ...) are stored as JSON.
  add('components', 'extra', "TEXT NOT NULL DEFAULT '{}'");
  add('connections', 'extra', "TEXT NOT NULL DEFAULT '{}'");
}

export function json<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Remove all derived analysis for a repo (keeps the repo row, jobs and conversations). */
export function clearAnalysis(db: DB, repoId: string) {
  const tx = db.transaction(() => {
    for (const t of ['file_edges', 'symbols', 'refs', 'chunks', 'components', 'connections', 'insights', 'suggested_questions', 'flows', 'diagram_answers', 'commits', 'file_commits', 'symbol_history']) {
      db.prepare(`DELETE FROM ${t} WHERE repo_id = ?`).run(repoId);
    }
  });
  tx();
}
