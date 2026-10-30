import { z } from 'zod';
import type { Architecture, Flow, FlowEvent } from '@cq/shared';
import { FlowSchema } from '@cq/shared';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import { agentEventMapper } from '../agent/explain.js';
import { RepoIndex, repoTools } from '../agent/tools.js';
import { AGENT_GUIDANCE } from '../llm/agent.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/index.js';
import { agentWithFallback } from '../llm/index.js';
import { getArchitecture } from '../routes/queries.js';
import { slug } from './context.js';

const FlowsOut = z.object({ flows: z.array(FlowSchema).max(10).describe('Up to 10 of the most important end-to-end flows') });

const DB_PKGS = /^(pg|postgres|mysql2?|mongoose|mongodb|sqlite3|better-sqlite3|prisma|@prisma\/client|sequelize|typeorm|knex|drizzle-orm|redis|ioredis|sqlalchemy|psycopg2?|pymongo|gorm)/;
const QUEUE_PKGS = /^(amqplib|kafkajs|bullmq|bull|celery|kombu|nats|@aws-sdk\/client-sqs)/;

function flowSystem(repo: string) {
  return `You are tracing runtime flows through ${repo} to draw sequence diagrams. ${AGENT_GUIDANCE}

For each flow: start at its trigger (HTTP route handler, CLI command, job consumer, startup), then follow the calls with read_file, find_definition and symbol_calls until it reaches persistence, an external system, or returns. Use architecture component ids for participants where they apply (get_architecture), external systems as their own participants, and "client"/"user" for the outside caller.
Every step must have a ref (path + line) you actually read. Include returns only where they carry meaningful data.`;
}

/** Participant for a file: its architecture component when known, else the file itself. */
function participantFor(ix: RepoIndex, arch: Architecture, path: string) {
  const meta = json<any>(ix.fileRow(path)?.meta, {});
  const comp = arch.components.find((c) => c.id === meta.component) ?? arch.components.find((c) => c.paths.some((p) => path === p || path.startsWith(p + '/')));
  return comp ? { id: comp.id, label: comp.name, componentId: comp.id } : { id: slug(path), label: path.split('/').pop()! };
}

function externalParticipant(arch: Architecture, pkg: string) {
  const isDb = DB_PKGS.test(pkg);
  const isQueue = QUEUE_PKGS.test(pkg);
  const comp = arch.components.find((c) => (isDb && c.type === 'database') || (isQueue && c.type === 'queue'));
  return { p: comp ? { id: comp.id, label: comp.name, componentId: comp.id } : { id: `pkg-${slug(pkg)}`, label: pkg }, kind: isDb ? ('db' as const) : isQueue ? ('async' as const) : ('call' as const) };
}

/** Static trace through the references index (offline + fallback). */
export function heuristicFlows(ix: RepoIndex, arch: Architecture): Flow[] {
  const routeSyms = ix.db
    .prepare(`SELECT path, name, line, end_line FROM symbols WHERE repo_id=? AND kind='route' ORDER BY path, line LIMIT 40`)
    .all(ix.repoId) as { path: string; name: string; line: number; end_line: number }[];
  const nonTest = routeSyms.filter((r) => !json<any>(ix.fileRow(r.path)?.meta, {}).isTest && !/(^|\/)(examples?|test)\//.test(r.path));
  const flows: Flow[] = [];
  for (const r of (nonTest.length ? nonTest : routeSyms).slice(0, 10)) {
    const participants = new Map<string, Flow['participants'][number]>();
    const add = (p: Flow['participants'][number]) => (participants.has(p.id) ? p.id : (participants.set(p.id, p), p.id));
    const client = add({ id: 'client', label: 'Client' });
    const handler = participantFor(ix, arch, r.path);
    const hid = add(handler);
    const steps: Flow['steps'] = [{ from: client, to: hid, label: r.name, kind: 'http', ref: { path: r.path, startLine: r.line, endLine: r.line } }];
    const visited = new Set<string>();
    const walk = (path: string, start: number, end: number, from: string, depth: number) => {
      if (depth > 3 || steps.length > 12) return;
      for (const c of ix.callsWithin(path, start, end)) {
        if (!c.target) continue;
        // Follow real calls only: direct calls, or member calls like prisma.user.findMany(...).
        const code = ix.lineAt(path, c.line);
        const chain = code.match(new RegExp(`\\b${c.name.replace(/\$/g, '\\$')}((?:\\??\\.\\w+)+)\\s*\\(`))?.[1]?.replace(/\?/g, '');
        if (c.kind !== 'call' && !chain) continue;
        if (depth === 0 && c.line === start && chain && /^\.(get|post|put|patch|delete|use|all|route)$/.test(chain)) continue; // the router receiver itself
        const key = `${c.target}:${c.targetLine}:${c.name}${chain ?? ''}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (c.target.startsWith('pkg:')) {
          const ext = externalParticipant(arch, c.target.slice(4));
          if (ext.kind === 'call' && depth > 0) continue; // skip incidental library calls
          steps.push({ from, to: add(ext.p), label: `${c.name}${chain ?? ''}()`, kind: ext.kind, ref: { path, startLine: c.line, endLine: c.line } });
          continue;
        }
        const sym = ix.findSymbol(c.target, c.name, c.targetLine ?? undefined);
        if (sym && ['type', 'interface', 'enum'].includes(sym.kind)) continue;
        // A member call on a client object (e.g. prisma.article.findMany) goes to whatever that object wraps.
        if (chain && sym?.kind === 'variable') {
          const ext = ix.callsWithin(c.target, sym.line, sym.endLine).find((x) => x.target?.startsWith('pkg:'));
          if (ext?.target) {
            const e = externalParticipant(arch, ext.target.slice(4));
            steps.push({ from, to: add(e.p), label: `${c.name}${chain}()`, kind: e.kind === 'call' ? 'call' : e.kind, ref: { path, startLine: c.line, endLine: c.line } });
            continue;
          }
        }
        const to = add(participantFor(ix, arch, c.target));
        steps.push({ from, to, label: `${c.name}${chain ?? ''}()`, kind: 'call', ref: { path, startLine: c.line, endLine: c.line } });
        if (sym) walk(c.target, sym.line, sym.endLine, to, depth + 1);
      }
    };
    walk(r.path, r.line, r.end_line ?? r.line, hid, 0);
    steps.push({ from: hid, to: client, label: 'response', kind: 'return', ref: { path: r.path, startLine: r.end_line ?? r.line, endLine: r.end_line ?? r.line } });
    if (steps.length < 3) continue;
    flows.push({
      id: slug(`flow-${r.name}`),
      title: `Handle ${r.name}`,
      trigger: `HTTP ${r.name}`,
      summary: `Request path for \`${r.name}\` traced through the static call graph from [${r.path}:${r.line}-${r.end_line}].`,
      participants: [...participants.values()],
      steps,
    });
  }
  return flows;
}

/** Make a model-produced flow consistent: known participants, real refs, known component ids. */
export function validateFlow(ix: RepoIndex, arch: Architecture, f: Flow): Flow | null {
  const ids = new Set(f.participants.map((p) => p.id));
  const participants = f.participants.map((p) => ({ ...p, componentId: p.componentId && arch.components.some((c) => c.id === p.componentId) ? p.componentId : undefined }));
  const steps = f.steps
    .filter((s) => ids.has(s.from) && ids.has(s.to))
    .map((s) => {
      if (!s.ref) return s;
      try {
        const path = ix.requireFile(s.ref.path);
        const lines = ix.fileRow(path)?.lines ?? 1;
        const start = Math.min(Math.max(1, s.ref.startLine ?? 1), lines);
        return { ...s, ref: { ...s.ref, path, startLine: start, endLine: Math.min(Math.max(start, s.ref.endLine ?? start), lines) } };
      } catch {
        return { ...s, ref: undefined };
      }
    });
  if (steps.length < 2) return null;
  return { ...f, id: slug(f.id || f.title), participants, steps };
}

export function saveFlows(db: DB, repoId: string, flows: Flow[], replace = true) {
  db.transaction(() => {
    if (replace) db.prepare('DELETE FROM flows WHERE repo_id=?').run(repoId);
    const pos = (db.prepare('SELECT coalesce(max(position), -1) AS p FROM flows WHERE repo_id=?').get(repoId) as any).p as number;
    const ins = db.prepare(`INSERT INTO flows (repo_id, id, title, content, position) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo_id, id) DO UPDATE SET title=excluded.title, content=excluded.content`);
    flows.forEach((f, i) => ins.run(repoId, f.id, f.title, JSON.stringify(f), pos + 1 + i));
  })();
}

export function listFlows(db: DB, repoId: string): Flow[] {
  return (db.prepare('SELECT content FROM flows WHERE repo_id=? ORDER BY position').all(repoId) as any[]).map((r) => JSON.parse(r.content));
}

/** Ingest-time: the agent proposes and traces the most important flows. */
export async function analyzeFlows(llm: LLMProvider, ix: RepoIndex, warn: (m: string) => void): Promise<Flow[]> {
  const arch = getArchitecture(ix.db, ix.repoId);
  const routes = ix.db.prepare(`SELECT path, name, line FROM symbols WHERE repo_id=? AND kind='route' LIMIT 40`).all(ix.repoId) as any[];
  const entries = ix.db.prepare(`SELECT path FROM files WHERE repo_id=? AND json_extract(meta,'$.isEntry')=1 AND coalesce(json_extract(meta,'$.isTest'),0)=0 LIMIT 15`).all(ix.repoId) as any[];
  const repo = ix.db.prepare('SELECT name FROM repos WHERE id=?').get(ix.repoId) as { name: string };
  const res = await agentWithFallback(
    llm,
    {
      system: flowSystem(repo.name),
      messages: [
        {
          role: 'user',
          content: [
            `# Components\n${arch.components.map((c) => `- ${c.id}: ${c.name} [${c.type}] ${c.paths.join(', ')}`).join('\n')}`,
            routes.length ? `# Route handlers\n${routes.map((r) => `- ${r.name} (${r.path}:${r.line})`).join('\n')}` : '',
            `# Entry points\n${entries.map((e) => `- ${e.path}`).join('\n')}`,
            'Pick up to 10 distinct important flows a new engineer most needs to understand (main request paths, background jobs, startup), trace each, then submit_flows.',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
      tools: repoTools(ix),
      maxSteps: 16,
      maxTokens: 16_384,
      final: { name: 'flows', schema: FlowsOut },
      scripted: async () => ({ final: { flows: heuristicFlows(ix, arch) } }),
    },
    warn,
  );
  return ((res.final as z.infer<typeof FlowsOut>)?.flows ?? []).map((f) => validateFlow(ix, arch, f)).filter((f): f is Flow => Boolean(f));
}

/** On demand: trace one flow described by the user ("what happens on login?"). */
export async function traceFlow(db: DB, llm: LLMProvider, embeddings: EmbeddingProvider | null, repoId: string, question: string, emit: (e: FlowEvent) => void): Promise<Flow | null> {
  const ix = new RepoIndex(db, repoId, embeddings);
  const arch = getArchitecture(db, repoId);
  const repo = db.prepare('SELECT name FROM repos WHERE id=?').get(repoId) as { name: string };
  const res = await agentWithFallback(llm, {
    system: flowSystem(repo.name),
    messages: [{ role: 'user', content: `# Components\n${arch.components.map((c) => `- ${c.id}: ${c.name} [${c.type}] ${c.paths.join(', ')}`).join('\n')}\n\nTrace this flow and submit it with submit_flow: ${question}` }],
    tools: repoTools(ix),
    maxSteps: 14,
    maxTokens: 8000,
    final: { name: 'flow', schema: FlowSchema },
    onEvent: agentEventMapper(emit),
    scripted: async (call) => {
      // Offline: find the most relevant route handler and trace it statically.
      await call('search_code', { query: question, limit: 4 });
      const flows = heuristicFlows(ix, arch);
      const words = question.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const best = flows.sort((a, b) => score(b) - score(a))[0];
      function score(f: Flow) {
        return words.filter((w) => `${f.title} ${f.steps.map((s) => s.label).join(' ')}`.toLowerCase().includes(w)).length;
      }
      if (!best) throw new Error('No flow could be traced statically; configure an LLM for on-demand tracing');
      return { final: { ...best, id: slug(`flow-${question}`), title: best.title } };
    },
  });
  const flow = res.final ? validateFlow(ix, arch, res.final as Flow) : null;
  if (flow) emit({ type: 'result', flow });
  return flow;
}
