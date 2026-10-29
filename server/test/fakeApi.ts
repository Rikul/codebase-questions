import express from 'express';
import type { AddressInfo } from 'node:net';

export type Block = { text: string } | { tool: string; input: unknown };

/**
 * A stand-in for the Anthropic and OpenAI APIs. Each request pops the next scripted
 * response (a list of text / tool-call blocks), and every request body is recorded.
 */
export async function startFakeApi() {
  const anthropic: Block[][] = [];
  const openai: Block[][] = [];
  const requests: { vendor: string; body: any }[] = [];
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  let n = 0;

  app.post('/v1/messages', (req, res) => {
    requests.push({ vendor: 'anthropic', body: req.body });
    const blocks = anthropic.shift() ?? [{ text: 'done' }];
    const hasTool = blocks.some((b) => 'tool' in b);
    if (!req.body.stream) {
      const content = blocks.map((b) => ('tool' in b ? { type: 'tool_use', id: `tu${++n}`, name: b.tool, input: b.input } : { type: 'text', text: b.text }));
      return void res.json({ id: 'm', type: 'message', role: 'assistant', model: req.body.model, content, stop_reason: hasTool ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    }
    res.setHeader('content-type', 'text/event-stream');
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: req.body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    blocks.forEach((b, index) => {
      if ('tool' in b) {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: `tu${++n}`, name: b.tool, input: {} } });
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      } else {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
      }
      send('content_block_stop', { index });
    });
    send('message_delta', { delta: { stop_reason: hasTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } });
    send('message_stop', {});
    res.end();
  });

  app.post('/v1/chat/completions', (req, res) => {
    requests.push({ vendor: 'openai', body: req.body });
    const blocks = openai.shift() ?? [{ text: 'done' }];
    res.setHeader('content-type', 'text/event-stream');
    const chunk = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: req.body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    let ti = 0;
    for (const b of blocks) {
      if ('tool' in b) {
        const args = JSON.stringify(b.input);
        chunk({ tool_calls: [{ index: ti, id: `call${++n}`, type: 'function', function: { name: b.tool, arguments: '' } }] });
        chunk({ tool_calls: [{ index: ti, function: { arguments: args.slice(0, 5) } }] });
        chunk({ tool_calls: [{ index: ti, function: { arguments: args.slice(5) } }] });
        ti++;
      } else chunk({ content: b.text });
    }
    chunk({}, ti ? 'tool_calls' : 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, anthropic, openai, requests, close: () => server.close() };
}
