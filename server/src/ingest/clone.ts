import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const run = promisify(execFile);

export interface ParsedRepoUrl {
  /** URL as the user should see it (no credentials). */
  url: string;
  name: string;
  branch?: string;
  host: string;
}

/**
 * Accepts https Git URLs, `github.com/owner/repo`, or `owner/repo` shorthand.
 * An optional `#branch` suffix selects a branch or tag.
 */
export function parseRepoUrl(input: string): ParsedRepoUrl {
  let raw = input.trim();
  let branch: string | undefined;
  const hash = raw.indexOf('#');
  if (hash >= 0) {
    branch = raw.slice(hash + 1).trim() || undefined;
    raw = raw.slice(0, hash);
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) raw = `https://github.com/${raw}`;
  if (/^(github\.com|gitlab\.com|bitbucket\.org)\//.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Enter an https Git URL such as https://github.com/owner/repo');
  }
  if (u.protocol !== 'https:') throw new Error('Only https:// Git URLs are supported');
  if (u.username || u.password) throw new Error('Do not put credentials in the URL; set GITHUB_TOKEN on the server instead');
  // GitHub web URLs like /owner/repo/tree/branch
  const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (u.hostname === 'github.com' && parts.length >= 4 && parts[2] === 'tree') {
    branch ??= parts.slice(3).join('/');
    parts.length = 2;
  }
  if (parts.length < 2) throw new Error('URL must point to a repository (owner/repo)');
  if (branch && (!/^[\w./-]+$/.test(branch) || branch.startsWith('-'))) throw new Error('Invalid branch name');
  const name = parts.slice(0, 2).join('/');
  const clean = `https://${u.host}/${parts.join('/')}`;
  return { url: clean, name, branch, host: u.hostname };
}

function authedUrl(p: ParsedRepoUrl): string {
  const token = config.ingest.githubToken;
  if (!token || p.host !== 'github.com') return p.url;
  const u = new URL(p.url);
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}

function dirSizeMb(dir: string): number {
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

export async function cloneRepo(p: ParsedRepoUrl, dest: string): Promise<{ commit: string }> {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Inherit proxy/CA settings but drop interactive credential helpers: auth comes only from GITHUB_TOKEN.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(GIT_ASKPASS|SSH_ASKPASS|GIT_SSH_COMMAND|GIT_EDITOR|GIT_PAGER)$/.test(k)) env[k] = v;
  }
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });
  // execFile (no shell) with a fixed argument list; `--` stops option parsing before the URL.
  const args = ['-c', 'core.symlinks=false', 'clone', '--depth', '1', '--single-branch', '--no-tags'];
  if (p.branch) args.push('--branch', p.branch);
  args.push('--', authedUrl(p), dest);
  try {
    await run('git', args, { env, timeout: config.ingest.cloneTimeoutMs, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    // Never leak a token in error messages.
    const e = err as Error & { stderr?: string };
    const msg = String(e.stderr || e.message).replaceAll(config.ingest.githubToken ?? '\u0000', '***');
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(`git clone failed: ${msg.trim().split('\n').slice(-3).join(' ')}`);
  }
  const { stdout } = await run('git', ['-C', dest, 'rev-parse', 'HEAD'], { env });
  const commit = stdout.trim();
  // Drop .git: it holds the credentialed remote and is not needed for analysis.
  fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
  const size = dirSizeMb(dest);
  if (size > config.ingest.maxRepoMb) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(`Repository is ${size.toFixed(0)} MB which exceeds MAX_REPO_MB=${config.ingest.maxRepoMb}`);
  }
  return { commit };
}
