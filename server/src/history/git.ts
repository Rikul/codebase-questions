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
