import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ChatTurn } from './provider.js';

/** A read-only capability the model can call while investigating. */
export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodType<any>;
  run(input: any): Promise<unknown>;
  /** Short human-readable label for the UI trace, e.g. "Reading lib/app.js:1-120". */
  label?(input: any): string;
}

export type AgentEvent =
  | { type: 'tool_call'; id: string; name: string; label: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; summary: string; isError: boolean }
  | { type: 'text'; text: string }
  /** The text streamed in this turn was interim narration (the model went on to call tools). */
  | { type: 'reset'; text: string };

/** Lets a scripted (offline) run call tools exactly like a model would. */
export type ToolCaller = (name: string, input: Record<string, unknown>) => Promise<any>;

export interface AgentOptions<T = unknown> {
  system: string;
  messages: ChatTurn[];
  tools: AgentTool[];
  maxSteps?: number;
  maxTokens?: number;
  fast?: boolean;
  /** When set, the run must end by calling `submit_<name>` with data matching the schema. */
  final?: { name: string; description?: string; schema: z.ZodType<T> };
  onEvent?: (e: AgentEvent) => void;
  /** Offline behaviour for the mock provider (and fallback): call tools, then return the result. */
  scripted?: (call: ToolCaller, emitText: (t: string) => void) => Promise<{ text?: string; final?: T }>;
}

export interface AgentResult<T = unknown> {
  text: string;
  final?: T;
  steps: number;
  toolCalls: { name: string; input: unknown }[];
}

const MAX_TOOL_OUTPUT = 24_000;
const TOTAL_BUDGET = 160_000;

export function toolJsonSchema(schema: z.ZodType<any>, target: 'jsonSchema7' | 'openApi3' = 'jsonSchema7'): Record<string, unknown> {
  const s = zodToJsonSchema(schema, { target, $refStrategy: 'none' }) as Record<string, unknown>;
  delete s.$schema;
  if (!s.type) s.type = 'object';
  return s;
}

export const submitName = (final: { name: string }) => `submit_${final.name}`;

/** Shared bookkeeping for provider tool loops: runs tools, enforces budgets, validates the final submission. */
export class AgentSession<T> {
  used = 0;
  calls: { name: string; input: unknown }[] = [];
  final?: T;
  private seq = 0;
  constructor(private opts: AgentOptions<T>) {}

  get budgetExceeded() {
    return this.used > TOTAL_BUDGET;
  }

  /** Execute one tool call (or the final submission). Returns tool_result content for the model. */
  async execute(name: string, rawInput: unknown): Promise<{ content: string; isError: boolean }> {
    const id = `t${++this.seq}`;
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const fin = this.opts.final;
    if (fin && name === submitName(fin)) {
      const parsed = fin.schema.safeParse(input);
      if (!parsed.success) {
        const msg = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        this.opts.onEvent?.({ type: 'tool_result', id, name, summary: `Submission rejected: ${msg}`, isError: true });
        return { content: `Invalid submission, fix and resubmit: ${msg}`, isError: true };
      }
      this.final = parsed.data;
      return { content: 'Accepted.', isError: false };
    }
    const tool = this.opts.tools.find((t) => t.name === name);
    if (!tool) return { content: `Unknown tool ${name}`, isError: true };
    let label = name;
    try {
      label = tool.label?.(input) ?? name;
    } catch {
      /* ignore */
    }
    this.calls.push({ name, input });
    this.opts.onEvent?.({ type: 'tool_call', id, name, label, input });
    if (this.budgetExceeded) {
      const content = 'Tool budget exceeded. Stop investigating and give your final answer now.';
      this.opts.onEvent?.({ type: 'tool_result', id, name, summary: 'budget exceeded', isError: true });
      return { content, isError: true };
    }
    try {
      const parsed = tool.schema.parse(input);
      const out = await tool.run(parsed);
      let content = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
      if (content.length > MAX_TOOL_OUTPUT) content = content.slice(0, MAX_TOOL_OUTPUT) + '\n…[output truncated; narrow your request]';
      this.used += content.length;
      this.opts.onEvent?.({ type: 'tool_result', id, name, summary: summarize(content), isError: false });
      return { content, isError: false };
    } catch (err) {
      const msg = (err as Error).message;
      this.opts.onEvent?.({ type: 'tool_result', id, name, summary: msg.slice(0, 160), isError: true });
      return { content: `Error: ${msg}`, isError: true };
    }
  }

  /** Tool caller for scripted runs; throws on errors so scripts can catch them. */
  caller(): ToolCaller {
    return async (name, input) => {
      const tool = this.opts.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool ${name}`);
      const id = `t${++this.seq}`;
      this.calls.push({ name, input });
      this.opts.onEvent?.({ type: 'tool_call', id, name, label: tool.label?.(input) ?? name, input });
      try {
        const out = await tool.run(tool.schema.parse(input));
        this.opts.onEvent?.({ type: 'tool_result', id, name, summary: summarize(typeof out === 'string' ? out : JSON.stringify(out)), isError: false });
        return out;
      } catch (err) {
        this.opts.onEvent?.({ type: 'tool_result', id, name, summary: (err as Error).message.slice(0, 160), isError: true });
        throw err;
      }
    };
  }
}

function summarize(content: string): string {
  const lines = content.split('\n').length;
  return content.length > 140 ? `${lines} lines, ${content.length.toLocaleString()} chars` : content.replace(/\s+/g, ' ');
}

export const AGENT_GUIDANCE = `You can inspect the repository with tools. Investigate before you answer: read the relevant code, follow references and imports, and verify claims against the source. Prefer a few targeted calls (call several tools at once when they are independent) over many broad ones. Cite code only from lines you actually read, as [path:START-END].`;
