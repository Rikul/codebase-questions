import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { OpenAIProvider } from '../src/llm/openai.js';

// A local stand-in for the vendor APIs, so request/response handling is tested without network or keys.
const seen: any[] = [];
let base = '';
let server: ReturnType<ReturnType<typeof express>['listen']>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/v1/messages', (req, res) => {
    seen.push({ vendor: 'anthropic', body: req.body });
    if (req.body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: req.body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello ' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'world' } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
      send('message_stop', {});
      return void res.end();
    }
    const content = req.body.tools
      ? [{ type: 'tool_use', id: 't', name: req.body.tools[0].name, input: { answer: 42 } }]
      : [{ type: 'text', text: 'plain' }];
    res.json({ id: 'm', type: 'message', role: 'assistant', model: req.body.model, content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  });
  app.post('/v1/chat/completions', (req, res) => {
    seen.push({ vendor: 'openai', body: req.body });
    const content = req.body.response_format ? '```json\n{"answer": 7}\n```' : 'plain';
    res.json({ id: 'c', object: 'chat.completion', created: 0, model: req.body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
  });
  await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

const Schema = z.object({ answer: z.number() });

describe('AnthropicProvider', () => {
  const p = () => new AnthropicProvider('test-key', 'claude-test', 'claude-fast', base);
  it('returns structured output via forced tool use', async () => {
    const out = await p().completeJSON({ name: 'result', system: 's', messages: [{ role: 'user', content: 'q' }], schema: Schema });
    expect(out).toEqual({ answer: 42 });
    const body = seen.at(-1).body;
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'result' });
    expect(body.tools[0].input_schema.properties.answer.type).toBe('number');
    expect(body.model).toBe('claude-test');
  });
  it('uses the fast model when asked, and streams text', async () => {
    await p().complete({ system: 's', messages: [{ role: 'user', content: 'q' }], fast: true });
    expect(seen.at(-1).body.model).toBe('claude-fast');
    let text = '';
    for await (const t of p().stream({ system: 's', messages: [{ role: 'user', content: 'q' }] })) text += t;
    expect(text).toBe('Hello world');
  });
});

describe('OpenAIProvider', () => {
  it('requests json_schema output and parses fenced JSON', async () => {
    const p = new OpenAIProvider('test-key', 'gpt-test', 'gpt-test', `${base}/v1`);
    const out = await p.completeJSON({ name: 'result', system: 's', messages: [{ role: 'user', content: 'q' }], schema: Schema });
    expect(out).toEqual({ answer: 7 });
    const body = seen.at(-1).body;
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[0]).toEqual({ role: 'system', content: 's' });
  });
});
