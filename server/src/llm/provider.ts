import type { z } from 'zod';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
  /** Use the cheaper/faster model if one is configured. */
  fast?: boolean;
  temperature?: number;
  /** Deterministic offline result, used by the mock provider (no API key) and as a fallback. */
  mock?: () => string;
}

export interface JSONOptions<T> extends CompleteOptions {
  schema: z.ZodType<T>;
  /** Name for the structured output (used as tool / schema name). */
  name: string;
  description?: string;
  /** Heuristic result used by the mock provider, and as a fallback if the model fails. */
  heuristic?: () => T;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  complete(opts: CompleteOptions): Promise<string>;
  completeJSON<T>(opts: JSONOptions<T>): Promise<T>;
  stream(opts: CompleteOptions): AsyncIterable<string>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number | null;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Retry an async op with exponential backoff on rate-limit / transient errors. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 429 || status === 408 || status === 409 || (status >= 500 && status < 600) || err?.code === 'ECONNRESET';
      if (!retryable || i === attempts - 1) throw err;
      const delay = Math.min(30_000, 1000 * 2 ** i) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Extract a JSON object from model text (handles ```json fences and leading prose). */
export function extractJSON(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.search(/[{[]/);
  if (start < 0) throw new Error('No JSON found in model output');
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1));
}
