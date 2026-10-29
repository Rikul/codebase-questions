import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import type { DB } from './db/index.js';

/** Unambiguous alphabet: no 0/O, 1/I/L. 32 symbols → 16 chars = 80 bits of entropy. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const COOKIE_NAME = 'cq_session';
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function generateCode(): string {
  let raw = '';
  for (let i = 0; i < 16; i++) raw += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return raw.match(/.{4}/g)!.join('-');
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Invalidate any unused codes and mint a fresh one. Returns the plaintext code (never stored). */
export function mintCode(db: DB): string {
  const code = generateCode();
  db.transaction(() => {
    db.prepare('DELETE FROM auth_codes WHERE used_at IS NULL').run();
    db.prepare('INSERT INTO auth_codes (hash) VALUES (?)').run(sha256(normalizeCode(code)));
  })();
  return code;
}

export function printCode(code: string, reason = 'Access code') {
  const rows = [`${reason} (one-time): ${code}`, 'Enter it in the browser to sign in.'];
  const w = Math.max(...rows.map((r) => r.length)) + 4;
  console.log(['', `+${'-'.repeat(w)}+`, ...rows.map((r) => `|  ${r.padEnd(w - 4)}  |`), `+${'-'.repeat(w)}+`, ''].join('\n'));
}

function loadSecret(): Buffer {
  const file = path.join(config.dataDir, 'session.secret');
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  } catch {
    const s = crypto.randomBytes(32);
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, s.toString('hex'), { mode: 0o600 });
    return s;
  }
}

export class Auth {
  private secret: Buffer;
  private failures = new Map<string, { n: number; first: number }>();

  constructor(private db: DB, secret?: Buffer) {
    this.secret = secret ?? loadSecret();
  }

  private sign(id: string) {
    return crypto.createHmac('sha256', this.secret).update(id).digest('base64url');
  }

  isLockedOut(ip: string): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.first > WINDOW_MS) {
      this.failures.delete(ip);
      return false;
    }
    return f.n >= MAX_FAILURES;
  }

  private fail(ip: string) {
    const f = this.failures.get(ip);
    if (!f || Date.now() - f.first > WINDOW_MS) this.failures.set(ip, { n: 1, first: Date.now() });
    else f.n++;
  }

  /** Redeem a one-time code. Returns a signed session token, or null. */
  redeem(code: string, ip: string): { token: string } | { error: string; status: number } {
    if (this.isLockedOut(ip)) return { error: 'Too many attempts. Try again in 15 minutes.', status: 429 };
    const norm = normalizeCode(code);
    if (norm.length !== 16) {
      this.fail(ip);
      return { error: 'Invalid code', status: 401 };
    }
    const hash = sha256(norm);
    const rows = this.db.prepare('SELECT hash FROM auth_codes WHERE used_at IS NULL').all() as { hash: string }[];
    const hit = rows.find((r) => crypto.timingSafeEqual(Buffer.from(r.hash, 'hex'), Buffer.from(hash, 'hex')));
    if (!hit) {
      this.fail(ip);
      return { error: 'Invalid or already used code', status: 401 };
    }
    const res = this.db.prepare(`UPDATE auth_codes SET used_at=datetime('now') WHERE hash=? AND used_at IS NULL`).run(hit.hash);
    if (res.changes !== 1) return { error: 'Invalid or already used code', status: 401 };
    this.failures.delete(ip);
    const id = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + config.auth.sessionDays * 86_400_000).toISOString();
    this.db.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)').run(sha256(id), expires);
    return { token: `${id}.${this.sign(id)}` };
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const [id, sig] = token.split('.');
    if (!id || !sig) return false;
    const expected = this.sign(id);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE id=?').get(sha256(id)) as { expires_at: string } | undefined;
    return Boolean(row && new Date(row.expires_at).getTime() > Date.now());
  }

  revoke(token: string | undefined) {
    const id = token?.split('.')[0];
    if (id) this.db.prepare('DELETE FROM sessions WHERE id=?').run(sha256(id));
  }

  cookieOptions() {
    return { httpOnly: true, sameSite: 'strict' as const, secure: config.auth.secureCookie, maxAge: config.auth.sessionDays * 86_400_000, path: '/' };
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (config.auth.disabled) return next();
      if (this.verify(req.cookies?.[COOKIE_NAME])) return next();
      res.status(401).json({ error: 'Authentication required' });
    };
  }
}
