import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CompleteOptions, JSONOptions, LLMProvider } from './provider.js';
import { withRetry } from './provider.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  constructor(
    apiKey: string,
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    private fastModel: string = model,
    baseURL?: string,
  ) {
    this.client = new Anthropic({ apiKey, baseURL, maxRetries: 2 });
  }

  private pick(fast?: boolean) {
    return fast ? this.fastModel : this.model;
  }

  async complete(opts: CompleteOptions): Promise<string> {
    const res = await withRetry(() =>
      this.client.messages.create({
        model: this.pick(opts.fast),
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.system,
        messages: opts.messages,
      }),
    );
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }

  async completeJSON<T>(opts: JSONOptions<T>): Promise<T> {
    const schema = zodToJsonSchema(opts.schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
    delete schema.$schema;
    const res = await withRetry(() =>
      this.client.messages.create({
        model: this.pick(opts.fast),
        max_tokens: opts.maxTokens ?? 8192,
        system: opts.system,
        messages: opts.messages,
        tools: [
          {
            name: opts.name,
            description: opts.description ?? `Return the ${opts.name} result.`,
            input_schema: schema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: opts.name },
      }),
    );
    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('Model did not return structured output');
    return opts.schema.parse(block.input);
  }

  async *stream(opts: CompleteOptions): AsyncIterable<string> {
    const stream = this.client.messages.stream({
      model: this.pick(opts.fast),
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages: opts.messages,
    });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield ev.delta.text;
    }
  }
}
