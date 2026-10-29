import path from 'node:path';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export type ProviderName = 'anthropic' | 'openai' | 'mock';

function pickProvider(): ProviderName {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai' || explicit === 'mock') return explicit;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'mock';
}

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'));

export const config = {
  port: num('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  dbPath: path.join(dataDir, 'codebase.db'),
  reposDir: path.join(dataDir, 'repos'),
  llm: {
    provider: pickProvider(),
    model: process.env.LLM_MODEL || undefined,
    /** Cheaper model for bulk per-file summaries. Defaults to the main model. */
    fastModel: process.env.LLM_FAST_MODEL || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
    concurrency: num('LLM_CONCURRENCY', 4),
  },
  embeddings: {
    /** 'openai' | 'none'. Defaults to openai when an OpenAI key is present. */
    provider: (process.env.EMBEDDING_PROVIDER ?? (process.env.OPENAI_API_KEY ? 'openai' : 'none')).toLowerCase(),
    model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  },
  ingest: {
    githubToken: process.env.GITHUB_TOKEN || process.env.GIT_TOKEN || undefined,
    maxLlmFiles: num('MAX_LLM_FILES', 150),
    maxFileBytes: num('MAX_FILE_BYTES', 400_000),
    maxRepoFiles: num('MAX_REPO_FILES', 20_000),
    maxRepoMb: num('MAX_REPO_MB', 500),
    cloneTimeoutMs: num('CLONE_TIMEOUT_MS', 5 * 60_000),
  },
  auth: {
    /** Set AUTH_DISABLED=true only for local development behind a trusted network. */
    disabled: process.env.AUTH_DISABLED === 'true',
    sessionDays: num('SESSION_DAYS', 30),
    secureCookie: process.env.COOKIE_SECURE === 'true',
  },
};
