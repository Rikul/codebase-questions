import type { CompleteOptions, JSONOptions, LLMProvider } from './provider.js';

/**
 * Offline provider. It never calls a network API; every call site supplies a heuristic
 * result built from static analysis, so the app is fully usable (if less insightful)
 * without an API key, and tests are deterministic.
 */
export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly model = 'heuristic';

  async complete(opts: CompleteOptions): Promise<string> {
    return opts.mock ? opts.mock() : 'No LLM is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for generated answers.';
  }

  async completeJSON<T>(opts: JSONOptions<T>): Promise<T> {
    if (!opts.heuristic) throw new Error(`Mock provider has no heuristic for ${opts.name}`);
    return opts.schema.parse(opts.heuristic());
  }

  async *stream(opts: CompleteOptions): AsyncIterable<string> {
    const text = await this.complete(opts);
    for (const part of text.match(/[\s\S]{1,40}/g) ?? []) yield part;
  }
}
