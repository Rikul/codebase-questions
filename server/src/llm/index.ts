import { ZodError } from 'zod';
import { config } from '../config.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { MockProvider } from './mock.js';
import { DEFAULT_OPENAI_MODEL, OpenAIEmbeddings, OpenAIProvider } from './openai.js';
import type { EmbeddingProvider, JSONOptions, LLMProvider } from './provider.js';
import type { AgentOptions, AgentResult } from './agent.js';

export type { LLMProvider, EmbeddingProvider } from './provider.js';

export function createProvider(): LLMProvider {
  const { provider, model, fastModel } = config.llm;
  if (provider === 'anthropic') {
    if (!config.llm.anthropicApiKey) throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
    const m = model ?? DEFAULT_ANTHROPIC_MODEL;
    return new AnthropicProvider(config.llm.anthropicApiKey, m, fastModel ?? m, config.llm.anthropicBaseUrl);
  }
  if (provider === 'openai') {
    if (!config.llm.openaiApiKey && !config.llm.openaiBaseUrl) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
    const m = model ?? DEFAULT_OPENAI_MODEL;
    return new OpenAIProvider(config.llm.openaiApiKey ?? 'not-needed', m, fastModel ?? m, config.llm.openaiBaseUrl);
  }
  return new MockProvider();
}

export function createEmbeddings(): EmbeddingProvider | null {
  if (config.embeddings.provider === 'openai' && config.llm.openaiApiKey) {
    return new OpenAIEmbeddings(config.llm.openaiApiKey, config.embeddings.model, config.llm.openaiBaseUrl);
  }
  return null;
}

/** Keep validation failures readable without including model response contents. */
export function modelErrorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues.slice(0, 3).map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'response';
      return `${path}: ${issue.message.replace(/\s+/g, ' ')}`;
    });
    const more = err.issues.length > 3 ? `; +${err.issues.length - 3} more issue(s)` : '';
    return `response validation failed: ${issues.join('; ')}${more}`;
  }
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ');
}

/** Structured call that falls back to the heuristic if the model call fails or returns invalid data. */
export async function jsonWithFallback<T>(
  llm: LLMProvider,
  opts: JSONOptions<T>,
  onWarn?: (msg: string) => void,
): Promise<T> {
  try {
    return await llm.completeJSON(opts);
  } catch (err) {
    if (!opts.heuristic) throw err;
    onWarn?.(`${opts.name}: model call failed (${modelErrorMessage(err)}); using static analysis instead`);
    return opts.schema.parse(opts.heuristic());
  }
}

/** Agent run that falls back to the scripted (static) investigation if the model run fails. */
export async function agentWithFallback<T>(llm: LLMProvider, opts: AgentOptions<T>, onWarn?: (msg: string) => void): Promise<AgentResult<T>> {
  try {
    const r = await llm.runAgent(opts);
    if (opts.final && r.final === undefined) throw new Error('model did not submit a final answer');
    return r;
  } catch (err) {
    if (!opts.scripted || llm.name === 'mock') throw err;
    onWarn?.(`agent run failed (${modelErrorMessage(err)}); using static analysis instead`);
    return new MockProvider().runAgent(opts);
  }
}
