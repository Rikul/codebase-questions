import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { dirSizeMb, finalizeHistory, gitEnv } from '../history/git.js';
import type { HistoryInfo } from '../history/git.js';

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

/** Working-tree size (excludes .git, which is limited separately by MAX_HISTORY_MB). */
function treeSizeMb(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== '.git') stack.push(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  }
  return total / 1024 / 1024;
}

export async function cloneRepo(p: ParsedRepoUrl, dest: string): Promise<{ commit: string; history: HistoryInfo | null; warnings: string[] }> {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Auth comes only from GITHUB_TOKEN; interactive credential helpers are dropped (see gitEnv).
  const env = gitEnv();
  const depth = config.ingest.historyDepth;
  // execFile (no shell) with a fixed argument list; `--` stops option parsing before the URL.
  const args = ['-c', 'core.symlinks=false', 'clone', '--single-branch', '--no-tags'];
  if (depth !== 0) args.push('--depth', String(depth > 0 ? depth : 1));
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
  return prepareCheckout(dest, p.url, depth, config.ingest.githubToken);
}

export type CheckoutResult = { commit: string; history: HistoryInfo | null; warnings: string[] };

/**
 * Bring an existing checkout up to date by fetching the branch and resetting to it, instead of
 * cloning again. Returns null when there is no usable checkout (never cloned, history disabled so
 * .git was removed, or a different repository); throws if git fails. The fetch URL (which may hold
 * a token) is passed on the command line only, never stored; prepareCheckout then scrubs and checks
 * the checkout exactly as after a clone.
 */
export async function updateCheckout(dest: string, cleanUrl: string, fetchUrl: string, branch: string | undefined, depth: number, secret?: string): Promise<CheckoutResult | null> {
  if (depth < 0 || !fs.existsSync(path.join(dest, '.git'))) return null;
  const env = gitEnv();
  // Fixed argument lists, no shell, no hooks, no symlinks, no background gc.
  const g = (args: string[]) =>
    run('git', ['-C', dest, '-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', ...args], { env, timeout: config.ingest.cloneTimeoutMs, maxBuffer: 10 * 1024 * 1024 });
  const remote = (await g(['config', '--get', 'remote.origin.url']).catch(() => ({ stdout: '' }))).stdout.trim();
  if (remote !== cleanUrl) return null;
  try {
    const fetch = ['fetch', '--quiet', '--no-tags'];
    if (depth > 0) fetch.push('--depth', String(depth));
    else if ((await g(['rev-parse', '--is-shallow-repository'])).stdout.trim() === 'true') fetch.push('--unshallow');
    fetch.push('--', fetchUrl, branch ?? 'HEAD');
    await g(fetch);
    await g(['reset', '--quiet', '--hard', 'FETCH_HEAD']);
    // The checkout is never edited, but make sure it matches the fetched commit exactly.
    await g(['clean', '-ffdxq']);
    // Drop objects a shallow fetch no longer needs, so .git does not grow with every update.
    await g(['gc', '--quiet', '--prune=now']).catch(() => undefined);
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const msg = String(e.stderr || e.message).replaceAll(secret || '\u0000', '***');
    throw new Error(`git fetch failed: ${msg.trim().split('\n').slice(-3).join(' ')}`);
  }
  return prepareCheckout(dest, cleanUrl, depth, secret);
}

/** Update the existing checkout if there is one, otherwise (or if updating fails) clone from scratch. */
export async function syncRepo(p: ParsedRepoUrl, dest: string): Promise<CheckoutResult & { updated: boolean }> {
  const warnings: string[] = [];
  try {
    const r = await updateCheckout(dest, p.url, authedUrl(p), p.branch, config.ingest.historyDepth, config.ingest.githubToken);
    if (r) return { ...r, updated: true };
  } catch (err) {
    warnings.push(`Could not update the existing checkout (${(err as Error).message}); cloned it again instead.`);
  }
  const r = await cloneRepo(p, dest);
  return { ...r, warnings: [...warnings, ...r.warnings], updated: false };
}

/**
 * Post-clone setup: scrub credentials and record history (or drop .git), then enforce size limits.
 * On any failure the checkout is deleted, so a token can never be left on disk.
 */
export async function prepareCheckout(dest: string, cleanUrl: string, depth: number, secret?: string): Promise<{ commit: string; history: HistoryInfo | null; warnings: string[] }> {
  const env = gitEnv();
  const warnings: string[] = [];
  let commit: string;
  let history: HistoryInfo | null = null;
  try {
    commit = (await run('git', ['-C', dest, 'rev-parse', 'HEAD'], { env })).stdout.trim();
    if (depth < 0) {
      // History disabled: drop .git entirely (it holds the credentialed remote).
      fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
    } else {
      // Throws if credentials cannot be scrubbed; the checkout is then removed below.
      history = await finalizeHistory(dest, cleanUrl, depth, secret);
      const gitMb = dirSizeMb(path.join(dest, '.git'));
      if (gitMb > config.ingest.maxHistoryMb) {
        fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
        history = null;
        warnings.push(`Git history is ${gitMb.toFixed(0)} MB (over MAX_HISTORY_MB=${config.ingest.maxHistoryMb}); continuing without history. Lower HISTORY_DEPTH to keep some.`);
      }
    }
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    const msg = String((err as Error).message).replaceAll(secret || '\u0000', '***');
    throw new Error(`Post-clone setup failed: ${msg}`);
  }
  const size = treeSizeMb(dest);
  if (size > config.ingest.maxRepoMb) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(`Repository is ${size.toFixed(0)} MB which exceeds MAX_REPO_MB=${config.ingest.maxRepoMb}`);
  }
  return { commit, history, warnings };
}
