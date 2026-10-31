import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AskEvent } from '@cq/shared';
import { openDb } from '../src/db/index.js';
import { analyzeDirectory } from '../src/ingest/pipeline.js';
import { MockProvider } from '../src/llm/mock.js';
import { answerQuestion, classifyHeuristic } from '../src/qa/answer.js';
import { retrieve } from '../src/qa/retrieve.js';
import { exportProject, importProject } from '../src/export/export.js';
import { getArchitecture } from '../src/routes/queries.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/sample-app');

describe('analysis pipeline (offline provider)', () => {
  const db = openDb(':memory:');
  const llm = new MockProvider();
  const repoId = 'sample';

  beforeAll(async () => {
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES (?, 'acme/sample-app', 'https://github.com/acme/sample-app', 'running')`).run(repoId);
    await analyzeDirectory(db, llm, null, repoId, FIXTURE, () => undefined);
  });

  it('stores files, chunks and edges', () => {
    const files = db.prepare('SELECT count(*) n FROM files WHERE repo_id=?').get(repoId) as any;
    const chunks = db.prepare('SELECT count(*) n FROM chunks WHERE repo_id=?').get(repoId) as any;
    expect(files.n).toBeGreaterThan(8);
    expect(chunks.n).toBeGreaterThanOrEqual(files.n);
  });

  it('builds an architecture with components, connections and external systems', () => {
    const arch = getArchitecture(db, repoId);
    expect(arch.components.length).toBeGreaterThanOrEqual(4);
    expect(arch.components.some((c) => c.type === 'database')).toBe(true);
    expect(arch.connections.length).toBeGreaterThan(2);
    for (const e of arch.connections) {
      expect(arch.components.some((c) => c.id === e.from)).toBe(true);
      expect(arch.components.some((c) => c.id === e.to)).toBe(true);
      expect(e.evidence.length).toBeGreaterThan(0);
    }
  });

  it('writes insights and suggested questions for all four categories', () => {
    for (const cat of ['architecture', 'onboarding', 'security', 'api']) {
      const n = db.prepare('SELECT count(*) n FROM insights WHERE repo_id=? AND category=?').get(repoId, cat) as any;
      const q = db.prepare('SELECT count(*) n FROM suggested_questions WHERE repo_id=? AND category=?').get(repoId, cat) as any;
      expect(n.n, cat).toBeGreaterThan(0);
      expect(q.n, cat).toBeGreaterThan(0);
    }
    const findings = db.prepare(`SELECT title FROM insights WHERE repo_id=? AND kind='finding'`).all(repoId) as any[];
    expect(findings.map((f) => f.title)).toEqual(expect.arrayContaining(['SQL built by string concatenation', 'Raw HTML rendering (XSS sink)']));
  });

  it('retrieves relevant code', async () => {
    const chunks = await retrieve(db, repoId, 'How does searchUsers query the database?', { category: 'security' });
    expect(chunks.slice(0, 2).map((c) => c.path)).toContain('src/services/userService.ts');
  });

  it('classifies questions', () => {
    expect(classifyHeuristic('Is there any SQL injection vulnerability?').category).toBe('security');
    expect(classifyHeuristic('How do the components interact in this architecture?').category).toBe('architecture');
    expect(classifyHeuristic('How do I get started and run it locally?').category).toBe('onboarding');
    expect(classifyHeuristic('How do I call the API client and handle retry behavior?').category).toBe('api');
  });

  it('answers questions with streaming events and citations', async () => {
    const events: AskEvent[] = [];
    for await (const ev of answerQuestion(db, llm, null, repoId, { question: 'Where is JWT auth enforced?' })) events.push(ev);
    expect(events[0]).toMatchObject({ type: 'meta', category: 'security' });
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.citations.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'token').length).toBeGreaterThan(0);
  });

  it('round-trips through export and import', () => {
    const exp = exportProject(db, repoId, true);
    const json = JSON.parse(JSON.stringify(exp));
    const newId = importProject(db, json);
    const a = getArchitecture(db, repoId);
    const b = getArchitecture(db, newId);
    expect(b.components).toEqual(a.components);
    expect(b.connections).toEqual(a.connections);
    const ins = (id: string) => db.prepare('SELECT category, title, body_md FROM insights WHERE repo_id=? ORDER BY position').all(id);
    expect(ins(newId)).toEqual(ins(repoId));
    const convs = db.prepare('SELECT count(*) n FROM conversations WHERE repo_id=?').get(newId) as any;
    expect(convs.n).toBe(1);
    expect(() => importProject(db, { format: 'nope' })).toThrow(/Invalid export file/);
  });
});

describe('background architecture synthesis', () => {
  it('publishes insights before synthesis and preserves them when architecture changes', async () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO repos (id, name, url, status) VALUES ('background', 'sample', 'https://github.com/acme/sample', 'running')`).run();
    const mock = new MockProvider();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const resultsReady = new Promise<void>((resolve) => { ready = resolve; });
    const llm = Object.create(mock) as import('../src/llm/provider.js').LLMProvider;
    Object.defineProperty(llm, 'name', { value: 'test' });
    llm.completeJSON = async <T,>(opts: import('../src/llm/provider.js').JSONOptions<T>): Promise<T> => {
      if (opts.name !== 'architecture') return mock.completeJSON(opts);
      await blocked;
      const raw = opts.heuristic!() as any;
      return opts.schema.parse({ ...raw, overview: 'Background architecture complete', components: raw.components.map((c: any) => ({ ...c, id: `new-${c.id}` })), connections: [] });
    };
    const stages: string[] = [];
    const progress: number[] = [];
    const analysis = analyzeDirectory(db, llm, null, 'background', FIXTURE, (stage, _message, fraction) => { stages.push(stage); progress.push(fraction); }, () => undefined, null, ready);
    await resultsReady;
    const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table} WHERE repo_id='background'`).get() as { n: number }).n;
    try {
      expect(count('insights')).toBeGreaterThan(0);
      expect(stages.indexOf('architecture')).toBeGreaterThan(stages.indexOf('store'));
      expect(progress[stages.indexOf('store')]).toBeCloseTo(7 / 9);
      expect(progress[stages.indexOf('architecture')]).toBeCloseTo(8 / 9);
      expect(progress.every((value, i) => i === 0 || value >= progress[i - 1])).toBe(true);
      // A user action performed while synthesis is running must survive its completion.
      db.prepare(`UPDATE insights SET title='User-visible result' WHERE repo_id='background' AND category!='architecture'`).run();
      // Diagram answers cached against the initial diagram must not outlive it.
      db.prepare(`INSERT INTO diagram_answers (repo_id, question, content) VALUES ('background', 'q', '{}')`).run();
    } finally {
      release();
    }
    const { architecture } = await analysis;
    expect(architecture.overview).toBe('Background architecture complete');
    expect((db.prepare(`SELECT title FROM insights WHERE repo_id='background' AND category!='architecture' LIMIT 1`).get() as any).title).toBe('User-visible result');
    expect(count('diagram_answers')).toBe(0);
    // The architecture insight is rewritten from the synthesized diagram and still sorts first.
    const archInsights = db.prepare(`SELECT body_md, position FROM insights WHERE repo_id='background' AND category='architecture' ORDER BY position`).all() as any[];
    expect(archInsights[0].body_md).toBe('Background architecture complete');
    const positions = (db.prepare(`SELECT position FROM insights WHERE repo_id='background' ORDER BY position`).all() as any[]).map((r) => r.position);
    expect(positions).toEqual(positions.map((_, i) => i));
    expect((db.prepare(`SELECT count(*) n FROM suggested_questions WHERE repo_id='background' AND category='architecture'`).get() as any).n).toBeGreaterThan(0);
    db.close();
  });
});
