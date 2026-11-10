import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Process env for git: inherit proxy/CA settings, drop interactive helpers and pagers. */
export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(GIT_ASKPASS|SSH_ASKPASS|GIT_SSH_COMMAND|GIT_EDITOR|GIT_PAGER|GIT_DIR|GIT_WORK_TREE)$/.test(k)) env[k] = v;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_PAGER: 'cat', LC_ALL: 'C' };
}

export function hasGit(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** Run a read-only git command in a checkout (no shell; fixed argument list). */
export async function git(dir: string, args: string[], opts: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, '-c', 'core.quotepath=off', '-c', 'diff.noprefix=false', ...args], {
    // Never look for a repository above the checkout (an upload has no .git, and DATA_DIR may sit inside another repo).
    env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(dir)) },
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
  });
  return stdout;
}

/** Reject anything that could be parsed as an option or escape the repository. */
export function safeGitPath(p: string): string {
  const clean = String(p ?? '').replace(/^\.?\//, '');
  if (!clean || clean.startsWith('-') || clean.split('/').includes('..') || path.isAbsolute(clean)) throw new Error(`Invalid path: ${p}`);
  return clean;
}

export function safeSha(sha: string): string {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error(`Invalid commit id: ${sha}`);
  return sha.toLowerCase();
}

export interface HistoryInfo {
  shallow: boolean;
  /** Oldest available commit (first shallow boundary, or the root commit). Kept for compatibility. */
  rootSha: string | null;
  /** Shallow boundaries: commits whose parents were not fetched (empty for a full clone, whose roots are real). */
  boundaries: string[];
  depth: number;
}

export function dirSizeMb(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  }
  return total / 1024 / 1024;
}

/**
 * After cloning: strip credentials, drop reflogs, and record how much history we have.
 * Throws if the credentialed remote cannot be removed; the caller must then delete the checkout.
 */
export async function finalizeHistory(dir: string, cleanUrl: string, depth: number, secret?: string): Promise<HistoryInfo> {
  await git(dir, ['remote', 'set-url', 'origin', cleanUrl]);
  // Reflogs and FETCH_HEAD can mention the fetch URL; they are not needed.
  fs.rmSync(path.join(dir, '.git', 'logs'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, '.git', 'FETCH_HEAD'), { force: true });
  const remote = (await git(dir, ['config', '--get', 'remote.origin.url'])).trim();
  if (remote !== cleanUrl || /\/\/[^/]*@/.test(remote)) throw new Error('Could not scrub credentials from the cloned repository');
  if (secret) {
    for (const f of ['config', 'packed-refs', 'ORIG_HEAD']) {
      const file = path.join(dir, '.git', f);
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(secret)) throw new Error('Could not scrub credentials from the cloned repository');
    }
  }
  return readHistoryInfo(dir, depth);
}

/** Shallow boundaries or the root commit of a checkout's history. */
async function readHistoryInfo(dir: string, depth: number): Promise<HistoryInfo> {
  const shallow = (await git(dir, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
  let boundaries: string[] = [];
  let rootSha: string | null;
  if (shallow) {
    const shallowFile = path.join(dir, '.git', 'shallow');
    boundaries = fs.existsSync(shallowFile) ? fs.readFileSync(shallowFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : [];
    rootSha = boundaries[0] ?? null;
  } else {
    rootSha = (await git(dir, ['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n').filter(Boolean)[0] ?? null;
  }
  return { shallow, rootSha, boundaries, depth };
}

/**
 * Check the git history that came with an upload (HEAD, refs and objects; see upload.ts) before
 * it is used: HEAD must be a commit and everything reachable from it must be present. If git
 * rejects it, it is deleted; if git cannot run, it is kept. Either way a warning is returned and
 * analysis continues without history.
 */
export async function verifyUploadedHistory(dir: string, limits: { depth: number; maxMb: number }): Promise<{ history: HistoryInfo | null; warning?: string }> {
  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) return { history: null };
  // HISTORY_DEPTH=-1 and MAX_HISTORY_MB apply on every analysis. The history is skipped, not
  // deleted: unlike a clone's, it cannot be fetched again if the limits are raised later. A
  // positive HISTORY_DEPTH is how much a clone fetches; an upload keeps the history it brought
  // (recorded as depth 0, its own shallow boundaries included), and indexing is capped separately
  // by HISTORY_INDEX_COMMITS.
  if (limits.depth < 0) return { history: null };
  const mb = dirSizeMb(gitDir);
  if (mb > limits.maxMb) return { history: null, warning: `The uploaded git history is ${mb.toFixed(0)} MB (over MAX_HISTORY_MB=${limits.maxMb}); continuing without history.` };
  try {
    await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    // Walks every reachable commit, tree and blob: fails on a missing or corrupt object.
    await git(dir, ['rev-list', '--objects', '--count', 'HEAD'], { timeoutMs: 300_000 });
    return { history: await readHistoryInfo(dir, 0) };
  } catch (err) {
    // Only git's own verdict means the history is broken; a timeout or a failure to start git
    // leaves it in place for the next analysis.
    if (!gitRejected(err)) return { history: null, warning: 'Could not check the uploaded git history (git timed out or did not run); continuing without history this time.' };
    fs.rmSync(gitDir, { recursive: true, force: true });
    return { history: null, warning: 'The uploaded git history is incomplete or unreadable; continuing without history.' };
  }
}

/** True when git ran to completion and exited with an error (not killed by a timeout, not a spawn failure). */
export function gitRejected(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: boolean; signal?: unknown } | null;
  return typeof e?.code === 'number' && !e.killed && !e.signal;
}
