import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareCheckout, updateCheckout } from '../src/ingest/clone.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-clone-'));
const CLEAN = 'https://github.com/acme/x';
const g = (cwd: string, args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' },
    encoding: 'utf8',
  }).trim();

let n = 0;
function origin() {
  const dir = path.join(tmp, `origin-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  g(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'old.js'), 'export const old = 1;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

async function checkout(src: string, depth = 0) {
  const dir = path.join(tmp, `checkout-${n}-${depth}`);
  g(tmp, ['clone', '-q', '--no-local', ...(depth ? ['--depth', String(depth)] : []), `file://${src}`, dir]);
  await prepareCheckout(dir, CLEAN, depth);
  return dir;
}

function advance(src: string) {
  fs.writeFileSync(path.join(src, 'a.js'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(src, 'b.js'), 'export const b = 1;\n');
  fs.rmSync(path.join(src, 'old.js'));
  g(src, ['add', '-A']);
  g(src, ['commit', '-q', '-m', 'second']);
  return g(src, ['rev-parse', 'HEAD']);
}

describe('updating an existing checkout', () => {
  it('fetches new commits instead of cloning, and keeps the scrubbed remote', async () => {
    const src = origin();
    const dir = await checkout(src);
    const head = advance(src);
    const res = await updateCheckout(dir, CLEAN, `file://${src}`, undefined, 0);
    expect(res?.commit).toBe(head);
    expect(fs.readFileSync(path.join(dir, 'a.js'), 'utf8')).toContain('a = 2');
    expect(fs.existsSync(path.join(dir, 'b.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'old.js'))).toBe(false);
    expect(g(dir, ['config', '--get', 'remote.origin.url'])).toBe(CLEAN);
    // The fetch URL is not left behind.
    expect(fs.existsSync(path.join(dir, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(res?.history?.shallow).toBe(false);
  });

  it('keeps a shallow checkout shallow at the configured depth', async () => {
    const src = origin();
    const dir = await checkout(src, 1);
    const head = advance(src);
    const res = await updateCheckout(dir, CLEAN, `file://${src}`, undefined, 1);
    expect(res?.commit).toBe(head);
    expect(res?.history?.shallow).toBe(true);
    expect(g(dir, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it('declines when there is no checkout or it belongs to another repository', async () => {
    const src = origin();
    expect(await updateCheckout(path.join(tmp, 'missing'), CLEAN, `file://${src}`, undefined, 0)).toBeNull();
    const dir = await checkout(src);
    expect(await updateCheckout(dir, 'https://github.com/acme/other', `file://${src}`, undefined, 0)).toBeNull();
    // History disabled: never fetch (the checkout has no .git to reuse).
    expect(await updateCheckout(dir, CLEAN, `file://${src}`, undefined, -1)).toBeNull();
  });

  it('reports fetch failures without leaking the token', async () => {
    const src = origin();
    const dir = await checkout(src);
    await expect(updateCheckout(dir, CLEAN, `file://${tmp}/nope-SECRET123`, undefined, 0, 'SECRET123')).rejects.toThrow(/git fetch failed/);
    await expect(updateCheckout(dir, CLEAN, `file://${tmp}/nope-SECRET123`, undefined, 0, 'SECRET123')).rejects.not.toThrow(/SECRET123/);
  });
});
