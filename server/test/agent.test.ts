import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiagramEvent, ExplainEvent } from '@cq/shared';
import { openDb } from '../src/db/index.js';
import { analyzeDirectory } from '../src/ingest/pipeline.js';
import { MockProvider } from '../src/llm/mock.js';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { OpenAIProvider } from '../src/llm/openai.js';
import { explain } from '../src/agent/explain.js';
import { RepoIndex, repoTools } from '../src/agent/tools.js';
import { answerOnDiagram } from '../src/agent/diagram.js';
import { getArchitecture } from '../src/routes/queries.js';
import { startFakeApi } from './fakeApi.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/sample-app');
const VALID = {
  what: 'Service with user queries [src/services/userService.ts:3-12]',
  howItFits: 'Used by the routes.',
  whenUsed: 'On GET /users requests.',
  contains: [{ name: 'getUser', kind: 'function', line: 3, description: 'loads one user' }],
  callers: [{ path: 'src/routes/users.ts', line: 7, why: 'route calls getUser' }],
  callees: [{ path: 'src/db/client.ts', line: 3, why: 'queries the pool' }, { path: 'nonexistent/file.ts', why: 'bogus' }],
};

describe('agent features', () => {
  const db = openDb(':memory:');
  const mock = new MockProvider();
  let fake: Awaited<ReturnType<typeof startFakeApi>>;
  beforeAll(async () => {
    fake = await startFakeApi();
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('r', 'acme/sample', 'https://x/y', 'ready')`).run();
    await analyzeDirectory(db, mock, null, 'r', FIXTURE, () => undefined);
  });
  afterAll(() => fake?.close());

  it('tools are confined to the repository', async () => {
    const tools = repoTools(new RepoIndex(db, 'r'));
    const read = tools.find((t) => t.name === 'read_file')!;
    await expect(read.run({ path: '../../etc/passwd' })).rejects.toThrow(/\.\./);
    await expect(read.run({ path: '/etc/passwd' })).rejects.toThrow(/No such file/);
    expect(String(await read.run({ path: 'src/db/client.ts' }))).toContain('new Pool');
    const chain = tools.find((t) => t.name === 'importer_chain')!;
    expect(await chain.run({ path: 'src/services/userService.ts' })).toEqual(['src/index.ts → src/routes/users.ts → src/services/userService.ts']);
  });

  it('explains a file offline, then serves it from cache', async () => {
    const events: ExplainEvent[] = [];
    await explain(db, mock, null, 'r', { path: 'src/services/userService.ts' }, (e) => events.push(e));
    expect(events.filter((e) => e.type === 'step').length).toBeGreaterThan(2);
    const res = events.find((e) => e.type === 'result');
    if (res?.type !== 'result') throw new Error('no result');
    expect(res.cached).toBe(false);
    expect(res.explanation.whenUsed).toMatch(/src\/index\.ts/);
    expect(res.explanation.contains.map((c) => c.name)).toEqual(['getUser', 'searchUsers']);
    expect(res.explanation.callers.some((c) => c.path === 'src/routes/users.ts' && c.symbol === 'GET /users/:id')).toBe(true);
    const again: ExplainEvent[] = [];
    await explain(db, mock, null, 'r', { path: 'src/services/userService.ts' }, (e) => again.push(e));
    expect(again.find((e) => e.type === 'result')).toMatchObject({ cached: true });
  });

  it('explains a symbol picked by line, with callers and callees', async () => {
    const events: ExplainEvent[] = [];
    await explain(db, mock, null, 'r', { path: 'src/services/userService.ts', symbol: { line: 10 } }, (e) => events.push(e));
    expect(events.find((e) => e.type === 'target')).toMatchObject({ target: { kind: 'symbol', name: 'searchUsers' } });
    const res = events.find((e) => e.type === 'result') as Extract<ExplainEvent, { type: 'result' }>;
    expect(res.explanation.callers[0]).toMatchObject({ path: 'src/routes/users.ts', line: 11 });
    expect(res.explanation.callees.some((c) => c.path === 'src/db/client.ts')).toBe(true);
  });

  it('runs the Anthropic tool loop: tools, rejected submission, accepted submission', async () => {
    fake.requests.length = 0;
    fake.anthropic.push(
      [{ text: 'Let me read it.' }, { tool: 'read_file', input: { path: 'src/services/userService.ts' } }, { tool: 'find_references', input: { name: 'getUser' } }],
      [{ tool: 'submit_explanation', input: { what: 'missing fields' } }],
      [{ tool: 'submit_explanation', input: VALID }],
    );
    const llm = new AnthropicProvider('k', 'claude-test', 'claude-test', fake.base);
    const events: ExplainEvent[] = [];
    await explain(db, llm, null, 'r', { path: 'src/services/userService.ts', refresh: true }, (e) => events.push(e));
    expect(fake.requests).toHaveLength(3);
    const second = fake.requests[1].body.messages.at(-1).content;
    expect(second.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result']);
    expect(second[0].content).toContain('searchUsers');
    expect(second[1].content).toContain('src/routes/users.ts');
    expect(fake.requests[2].body.messages.at(-1).content[0]).toMatchObject({ is_error: true });
    expect(fake.requests[0].body.tools.map((t: any) => t.name)).toContain('submit_explanation');
    expect(events.some((e) => e.type === 'reset')).toBe(true);
    const res = events.find((e) => e.type === 'result') as Extract<ExplainEvent, { type: 'result' }>;
    expect(res.explanation.what).toBe(VALID.what);
    // Links to files that do not exist are dropped.
    expect(res.explanation.callees.map((c) => c.path)).toEqual(['src/db/client.ts']);
  });

  it('runs the OpenAI tool-calls loop', async () => {
    fake.requests.length = 0;
    fake.openai.push([{ tool: 'list_symbols', input: { path: 'src/services/userService.ts' } }], [{ tool: 'submit_explanation', input: VALID }]);
    const llm = new OpenAIProvider('k', 'gpt-test', 'gpt-test', `${fake.base}/v1`);
    const events: ExplainEvent[] = [];
    await explain(db, llm, null, 'r', { path: 'src/db/client.ts', refresh: true }, (e) => events.push(e));
    const msgs = fake.requests[1].body.messages;
    expect(msgs.at(-2).tool_calls[0].function.name).toBe('list_symbols');
    expect(msgs.at(-1)).toMatchObject({ role: 'tool' });
    expect(msgs.at(-1).content).toContain('searchUsers');
    expect(events.find((e) => e.type === 'result')).toBeTruthy();
  });

  it('falls back to static analysis when the model never submits', async () => {
    fake.anthropic.push(...Array.from({ length: 20 }, () => [{ text: 'thinking' }]));
    const llm = new AnthropicProvider('k', 'claude-test', 'claude-test', fake.base);
    const events: ExplainEvent[] = [];
    await explain(db, llm, null, 'r', { path: 'src/auth/jwt.ts', refresh: true }, (e) => events.push(e));
    expect(events.some((e) => e.type === 'step' && e.step.tool === 'fallback')).toBe(true);
    expect(events.find((e) => e.type === 'result')).toBeTruthy();
    fake.anthropic.length = 0;
  });

  it('answers on the diagram with valid ids only', async () => {
    const dev: DiagramEvent[] = [];
    await answerOnDiagram(db, mock, null, 'r', 'How is a user fetched by id?', false, (e) => dev.push(e));
    const res = dev.find((e) => e.type === 'result') as Extract<DiagramEvent, { type: 'result' }>;
    const arch = getArchitecture(db, 'r');
    expect(res.answer.highlight.componentIds.length).toBeGreaterThan(1);
    for (const id of res.answer.highlight.componentIds) expect(arch.components.some((c) => c.id === id)).toBe(true);
    expect(res.answer.tour.length).toBeGreaterThan(0);

    // A model answer with unknown ids is filtered.
    fake.anthropic.push([{ tool: 'submit_diagram_answer', input: { answerMd: 'x', highlight: { componentIds: ['nope', arch.components[0].id], connectionIds: ['bad'] }, tour: [{ componentId: 'nope', caption: 'c' }] } }]);
    const dev2: DiagramEvent[] = [];
    await answerOnDiagram(db, new AnthropicProvider('k', 'c', 'c', fake.base), null, 'r', 'anything', true, (e) => dev2.push(e));
    const r2 = dev2.find((e) => e.type === 'result') as Extract<DiagramEvent, { type: 'result' }>;
    expect(r2.answer.highlight).toEqual({ componentIds: [arch.components[0].id], connectionIds: [] });
    expect(r2.answer.tour).toEqual([]);
  });
});

import { normalize } from '../src/analyze/architecture.js';
describe('architecture normalization', () => {
  it('downgrades connections whose evidence does not exist to inferred, and keeps extra fields', () => {
    const files = [{ path: 'src/a.ts', lines: 10 }, { path: 'src/b.ts', lines: 10 }] as any[];
    const facts = new Map([['src/a.ts', { imports: [], infra: [{ line: 3, kind: 'db:postgres', detail: 'query' }] }]]);
    const ctx = { files, fileByPath: new Map(files.map((f) => [f.path, f])), facts } as any;
    const arch = normalize(ctx, {
      overview: 'o',
      components: [
        { id: 'a', name: 'A', type: 'service', description: 'd', responsibilities: [], paths: ['src/a.ts'], layer: 'core', group: 'api' },
        { id: 'b', name: 'B', type: 'database', description: 'd', responsibilities: [], paths: [] },
      ],
      connections: [
        { from: 'a', to: 'b', kind: 'db', label: 'SQL', description: 'x', evidence: [{ path: 'src/a.ts', startLine: 3 }], protocol: 'SQL', sync: 'sync' },
        { from: 'b', to: 'a', kind: 'calls', label: 'y', description: 'y', evidence: [{ path: 'nope.ts', startLine: 1 }] },
      ],
    });
    expect(arch.components[0]).toMatchObject({ layer: 'core', group: 'api' });
    expect(arch.connections[0]).toMatchObject({ confidence: 'verified', protocol: 'SQL' });
    expect(arch.connections[1]).toMatchObject({ confidence: 'inferred', evidence: [] });
  });
});
