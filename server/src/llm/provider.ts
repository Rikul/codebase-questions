import { log, errorDetails } from '../logging/index.js';
import type { z } from 'zod';
import type { AgentOptions, AgentResult } from './agent.js';

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
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
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
  /** Tool-use loop: the model inspects the codebase with tools, then answers (or submits structured output). */
  runAgent<T>(opts: AgentOptions<T>): Promise<AgentResult<T>>;
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
      log('warn', 'llm.request.retry', { attempt: i + 1, maxAttempts: attempts, delayMs: Math.round(delay), ...errorDetails(err) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Extract a JSON object from model text (handles ```json fences and leading prose).
 * Plain JSON is parsed as-is first: its string values often contain markdown code fences,
 * which must not be mistaken for a fence wrapping the JSON.
 */
export function extractJSON(text: string): unknown {
  const body = text.trim();
  try {
    return JSON.parse(body);
  } catch {
    // Fall through: take the outermost object/array, skipping any prose or fence around it.
  }
  const start = body.search(/[{[]/);
  if (start < 0) throw new Error('No JSON found in model output');
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1));
}
