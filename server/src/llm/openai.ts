import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CompleteOptions, EmbeddingProvider, JSONOptions, LLMProvider } from './provider.js';
import { extractJSON, withRetry } from './provider.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.1';

function toMessages(opts: CompleteOptions): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [{ role: 'system', content: opts.system }, ...opts.messages.map((m) => ({ role: m.role, content: m.content }))];
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private jsonSchemaSupported = true;
  constructor(
    apiKey: string,
    readonly model: string = DEFAULT_OPENAI_MODEL,
    private fastModel: string = model,
    baseURL?: string,
  ) {
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 2 });
  }

  private pick(fast?: boolean) {
    return fast ? this.fastModel : this.model;
  }

  async complete(opts: CompleteOptions): Promise<string> {
    const res = await withRetry(() =>
      this.client.chat.completions.create({
        model: this.pick(opts.fast),
        messages: toMessages(opts),
        max_completion_tokens: opts.maxTokens ?? 4096,
      }),
    );
    return res.choices[0]?.message?.content ?? '';
  }

  async completeJSON<T>(opts: JSONOptions<T>): Promise<T> {
    const schema = zodToJsonSchema(opts.schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown>;
    const messages = toMessages(opts);
    if (this.jsonSchemaSupported) {
      try {
        const res = await withRetry(() =>
          this.client.chat.completions.create({
            model: this.pick(opts.fast),
            messages,
            max_completion_tokens: opts.maxTokens ?? 8192,
            response_format: { type: 'json_schema', json_schema: { name: opts.name, schema, strict: false } },
          }),
        );
        return opts.schema.parse(extractJSON(res.choices[0]?.message?.content ?? ''));
      } catch (err: any) {
        // Some OpenAI-compatible servers (e.g. local runtimes) lack json_schema support.
        if (err?.status !== 400) throw err;
        this.jsonSchemaSupported = false;
      }
    }
    messages[0] = {
      role: 'system',
      content: `${opts.system}\n\nRespond ONLY with a JSON object matching this JSON schema:\n${JSON.stringify(schema)}`,
    };
    const res = await withRetry(() =>
      this.client.chat.completions.create({
        model: this.pick(opts.fast),
        messages,
        max_completion_tokens: opts.maxTokens ?? 8192,
        response_format: { type: 'json_object' },
      }),
    );
    return opts.schema.parse(extractJSON(res.choices[0]?.message?.content ?? ''));
  }

  async *stream(opts: CompleteOptions): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.pick(opts.fast),
      messages: toMessages(opts),
      max_completion_tokens: opts.maxTokens ?? 4096,
      stream: true,
    });
    for await (const chunk of stream) {
      const t = chunk.choices[0]?.delta?.content;
      if (t) yield t;
    }
  }
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = null;
  private client: OpenAI;
  constructor(apiKey: string, private model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 2 });
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 96) {
      const batch = texts.slice(i, i + 96).map((t) => t.slice(0, 24_000));
      const res = await withRetry(() => this.client.embeddings.create({ model: this.model, input: batch }));
      for (const d of res.data) out.push(Float32Array.from(d.embedding));
    }
    return out;
  }
}
