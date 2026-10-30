import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentOptions, AgentResult } from './agent.js';
import { AgentSession, submitName, toolJsonSchema } from './agent.js';
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
            max_completion_tokens: opts.maxTokens ?? 16_384,
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
        max_completion_tokens: opts.maxTokens ?? 16_384,
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

  async runAgent<T>(opts: AgentOptions<T>): Promise<AgentResult<T>> {
    const session = new AgentSession(opts);
    const maxSteps = opts.maxSteps ?? 14;
    const tools: OpenAI.Chat.ChatCompletionTool[] = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: toolJsonSchema(t.schema, 'openApi3') },
    }));
    const fin = opts.final;
    if (fin) {
      tools.push({
        type: 'function',
        function: {
          name: submitName(fin),
          description: fin.description ?? 'Submit your final, complete answer. Call this exactly once when you are done investigating.',
          parameters: toolJsonSchema(fin.schema, 'openApi3'),
        },
      });
    }
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = toMessages(opts);
    let lastText = '';
    let nudged = false;
    for (let step = 0; step < maxSteps + 2; step++) {
      const forceFinal = Boolean(fin) && (step >= maxSteps - 1 || session.budgetExceeded);
      const noTools = !fin && (step >= maxSteps - 1 || session.budgetExceeded);
      const stream = await withRetry(() =>
        this.client.chat.completions.create({
          model: this.pick(opts.fast),
          messages,
          tools,
          tool_choice: forceFinal ? { type: 'function', function: { name: submitName(fin!) } } : noTools ? 'none' : 'auto',
          max_completion_tokens: opts.maxTokens ?? 16_384,
          stream: true,
        }),
      );
      let turnText = '';
      const acc: { id: string; name: string; args: string }[] = [];
      for await (const chunk of stream) {
        const d = chunk.choices[0]?.delta;
        if (!d) continue;
        if (d.content) {
          turnText += d.content;
          opts.onEvent?.({ type: 'text', text: d.content });
        }
        for (const tc of d.tool_calls ?? []) {
          const a = (acc[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id) a.id = tc.id;
          if (tc.function?.name) a.name += tc.function.name;
          if (tc.function?.arguments) a.args += tc.function.arguments;
        }
      }
      const calls = acc.filter(Boolean);
      messages.push({
        role: 'assistant',
        content: turnText || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } })) } : {}),
      });
      if (!calls.length) {
        lastText = turnText;
        if (fin && !session.final && !nudged) {
          nudged = true;
          messages.push({ role: 'user', content: `Now call ${submitName(fin)} with your final answer.` });
          continue;
        }
        break;
      }
      if (turnText) opts.onEvent?.({ type: 'reset', text: turnText });
      const results = await Promise.all(
        calls.map(async (c) => {
          let input: unknown = {};
          try {
            input = JSON.parse(c.args || '{}');
          } catch {
            return { id: c.id, content: 'Error: arguments were not valid JSON' };
          }
          const r = await session.execute(c.name, input);
          return { id: c.id, content: r.content };
        }),
      );
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      if (session.final !== undefined) break;
    }
    return { text: lastText, final: session.final, steps: messages.length, toolCalls: session.calls };
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
