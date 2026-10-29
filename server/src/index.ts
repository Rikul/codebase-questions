import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { Auth, mintCode, printCode } from './auth.js';
import { config } from './config.js';
import { openDb } from './db/index.js';
import type { DB } from './db/index.js';
import { initJobs } from './ingest/pipeline.js';
import { createEmbeddings, createProvider } from './llm/index.js';
import type { EmbeddingProvider, LLMProvider } from './llm/index.js';
import { apiRouter } from './routes/api.js';

export function createApp(db: DB, llm: LLMProvider, embeddings: EmbeddingProvider | null, auth: Auth) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');
  app.use(express.json({ limit: '200mb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', apiRouter(db, llm, embeddings, auth));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Serve the built web app in production.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = [process.env.WEB_DIST, path.resolve(here, '../../web/dist'), path.resolve(here, '../web/dist')].find((p) => p && fs.existsSync(path.join(p, 'index.html')));
  if (webDist) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }
  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const db = openDb(config.dbPath);
  const llm = createProvider();
  const embeddings = createEmbeddings();
  const auth = new Auth(db);
  initJobs(db, llm, embeddings);
  const app = createApp(db, llm, embeddings, auth);
  app.listen(config.port, config.host, () => {
    console.log(`codebase-questions listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`LLM: ${llm.name} (${llm.model})${embeddings ? `, embeddings: ${embeddings.name}` : ', keyword search only'}`);
    if (llm.name === 'mock') console.log('No LLM API key found: running in offline mode (static analysis only).');
    if (config.auth.disabled) console.log('WARNING: AUTH_DISABLED=true, the app is open to anyone who can reach it.');
    else printCode(mintCode(db));
  });
}
