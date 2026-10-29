import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Auth, CODE_ALPHABET, generateCode, mintCode } from '../src/auth.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/index.js';
import { MockProvider } from '../src/llm/mock.js';

function setup() {
  const db = openDb(':memory:');
  const auth = new Auth(db, crypto.randomBytes(32));
  const app = createApp(db, new MockProvider(), null, auth);
  return { db, app };
}

describe('one-time access code', () => {
  it('generates 16-character codes from an unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const c = generateCode();
      expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect([...c.replace(/-/g, '')].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true);
      expect(c).not.toMatch(/[01OIL]/);
    }
  });

  it('protects the API until a code is redeemed, and codes are single-use', async () => {
    const { db, app } = setup();
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/repos').expect(401);
    const code = mintCode(db);
    const ok = await request(app).post('/api/auth/redeem').send({ code: code.toLowerCase().replace(/-/g, ' ') }).expect(200);
    const cookie = ok.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    await request(app).get('/api/repos').set('Cookie', cookie).expect(200);
    await request(app).post('/api/auth/redeem').send({ code }).expect(401);
    await request(app).get('/api/repos').set('Cookie', 'cq_session=forged.sig').expect(401);
    await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(200);
    await request(app).get('/api/repos').set('Cookie', cookie).expect(401);
  });

  it('locks out after 5 failed attempts', async () => {
    const { db, app } = setup();
    const code = mintCode(db);
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/redeem').send({ code: 'AAAA-AAAA-AAAA-AAAA' }).expect(401);
    await request(app).post('/api/auth/redeem').send({ code }).expect(429);
  });

  it('minting a new code invalidates the previous unused one', async () => {
    const { db, app } = setup();
    const first = mintCode(db);
    const second = mintCode(db);
    await request(app).post('/api/auth/redeem').send({ code: first }).expect(401);
    await request(app).post('/api/auth/redeem').send({ code: second }).expect(200);
  });
});
