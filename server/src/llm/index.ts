import { config } from '../config.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { MockProvider } from './mock.js';
import { DEFAULT_OPENAI_MODEL, OpenAIEmbeddings, OpenAIProvider } from './openai.js';
import type { EmbeddingProvider, JSONOptions, LLMProvider } from './provider.js';

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
    onWarn?.(`${opts.name}: model call failed (${(err as Error).message}); using static analysis instead`);
    return opts.schema.parse(opts.heuristic());
  }
}
