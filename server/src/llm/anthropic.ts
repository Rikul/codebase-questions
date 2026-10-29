import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentOptions, AgentResult } from './agent.js';
import { AgentSession, submitName, toolJsonSchema } from './agent.js';
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

  async runAgent<T>(opts: AgentOptions<T>): Promise<AgentResult<T>> {
    const session = new AgentSession(opts);
    const maxSteps = opts.maxSteps ?? 14;
    const tools: Anthropic.Tool[] = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toolJsonSchema(t.schema) as Anthropic.Tool.InputSchema,
    }));
    const fin = opts.final;
    if (fin) {
      tools.push({
        name: submitName(fin),
        description: fin.description ?? 'Submit your final, complete answer. Call this exactly once when you are done investigating.',
        input_schema: toolJsonSchema(fin.schema) as Anthropic.Tool.InputSchema,
      });
    }
    const messages: Anthropic.MessageParam[] = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    let lastText = '';
    let nudged = false;
    for (let step = 0; step < maxSteps + 2; step++) {
      const forceFinal = Boolean(fin) && (step >= maxSteps - 1 || session.budgetExceeded);
      const noTools = !fin && (step >= maxSteps - 1 || session.budgetExceeded);
      let turnText = '';
      const stream = this.client.messages.stream({
        model: this.pick(opts.fast),
        max_tokens: opts.maxTokens ?? 8192,
        system: opts.system,
        messages,
        tools,
        tool_choice: forceFinal ? { type: 'tool', name: submitName(fin!) } : noTools ? { type: 'none' } : { type: 'auto' },
      });
      stream.on('text', (t) => {
        turnText += t;
        opts.onEvent?.({ type: 'text', text: t });
      });
      const msg = await stream.finalMessage();
      messages.push({ role: 'assistant', content: msg.content });
      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!uses.length) {
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
        uses.map(async (u) => {
          const r = await session.execute(u.name, u.input);
          return { type: 'tool_result' as const, tool_use_id: u.id, content: r.content, is_error: r.isError || undefined };
        }),
      );
      messages.push({ role: 'user', content: results });
      if (session.final !== undefined) break;
    }
    return { text: lastText, final: session.final, steps: messages.length, toolCalls: session.calls };
  }
}
