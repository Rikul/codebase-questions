import type { AgentOptions, AgentResult } from './agent.js';
import { AgentSession } from './agent.js';
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

  /** Runs the call site's scripted investigation: real tool calls, deterministic composition. */
  async runAgent<T>(opts: AgentOptions<T>): Promise<AgentResult<T>> {
    const session = new AgentSession(opts);
    if (!opts.scripted) throw new Error('Mock provider needs a scripted run');
    let text = '';
    const emit = (t: string) => {
      for (const part of t.match(/[\s\S]{1,60}/g) ?? []) {
        text += part;
        opts.onEvent?.({ type: 'text', text: part });
      }
    };
    const out = await opts.scripted(session.caller(), emit);
    if (out.text && !text) emit(out.text);
    let final = out.final;
    if (opts.final && final !== undefined) final = opts.final.schema.parse(final);
    return { text: text || out.text || '', final, steps: session.calls.length, toolCalls: session.calls };
  }
}
