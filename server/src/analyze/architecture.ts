import { z } from 'zod';
import type { Architecture, Component, ComponentType, Connection, ConnectionKind } from '@cq/shared';
import { COMPONENT_TYPES, CONNECTION_KINDS } from '@cq/shared';
import { jsonWithFallback } from '../llm/index.js';
import type { RepoContext } from './context.js';
import { allRoutes, cleanRefs, dirTree, entryPoints, isCode, readmeIntro, slug, truncate } from './context.js';

const LlmArchSchema = z.object({
  overview: z.string().describe('Markdown overview (3-6 paragraphs) of the system architecture, main flows and design choices.'),
  components: z
    .array(
      z.object({
        id: z.string().describe('short kebab-case id'),
        name: z.string(),
        type: z.enum(COMPONENT_TYPES),
        description: z.string().describe('2-3 sentences'),
        responsibilities: z.array(z.string()).describe('3-6 bullet points'),
        paths: z.array(z.string()).describe('directory prefixes or file paths that belong to this component; empty for external systems'),
      }),
    )
    .describe('5-15 components, including external systems (databases, queues, third-party APIs) the code talks to'),
  connections: z.array(
    z.object({
      from: z.string().describe('component id'),
      to: z.string().describe('component id'),
      kind: z.enum(CONNECTION_KINDS),
      label: z.string().describe('2-5 word edge label, e.g. "REST calls", "reads/writes users"'),
      description: z.string().describe('How and why these components interact; name the functions/endpoints involved.'),
      evidence: z
        .array(z.object({ path: z.string(), startLine: z.number().optional(), endLine: z.number().optional(), note: z.string().optional() }))
        .describe('1-4 code locations demonstrating the interaction, taken from the provided samples'),
    }),
  ),
});

const INFRA_NAMES: Record<string, { name: string; type: ComponentType; kind: ConnectionKind; label: string }> = {
  'db:postgres': { name: 'PostgreSQL', type: 'database', kind: 'db', label: 'SQL queries' },
  'db:mysql': { name: 'MySQL', type: 'database', kind: 'db', label: 'SQL queries' },
  'db:sqlite': { name: 'SQLite', type: 'database', kind: 'db', label: 'SQL queries' },
  'db:mongo': { name: 'MongoDB', type: 'database', kind: 'db', label: 'document reads/writes' },
  'db:orm': { name: 'Database (ORM)', type: 'database', kind: 'db', label: 'ORM queries' },
  'cache:redis': { name: 'Redis', type: 'database', kind: 'db', label: 'cache / KV' },
  queue: { name: 'Message queue', type: 'queue', kind: 'queue', label: 'publish / consume' },
  storage: { name: 'Object storage', type: 'external', kind: 'http', label: 'blob I/O' },
  grpc: { name: 'gRPC services', type: 'external', kind: 'http', label: 'RPC' },
  llm: { name: 'LLM API', type: 'external', kind: 'http', label: 'model calls' },
  'http-client': { name: 'External HTTP APIs', type: 'external', kind: 'http', label: 'HTTP requests' },
};

function guessType(ctx: RepoContext, id: string, files: string[]): ComponentType {
  const p = id.toLowerCase();
  if (/(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/.test(p)) return 'test';
  if (/(^|\/)(web|ui|frontend|client|components|pages|views|public|static|www|site|app\/\(|src\/app)/.test(p)) return 'frontend';
  if (/(^|\/)(cli|cmd|bin|scripts?|tools?)(\/|$)/.test(p)) return 'cli';
  if (/(^|\/)(workers?|jobs?|tasks?|queues?|consumers?)(\/|$)/.test(p)) return 'worker';
  if (/(^|\/)(config|configs|settings|deploy|infra|k8s|helm|terraform|\.github)(\/|$)/.test(p)) return 'config';
  if (/(^|\/)(db|database|models?|migrations?|schema|repositories|dal|store)(\/|$)/.test(p)) return 'library';
  const routes = files.reduce((n, f) => n + (ctx.facts.get(f)?.routes.length ?? 0), 0);
  if (routes > 0 || /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|server)(\/|$)/.test(p)) return 'api';
  if (/(^|\/)(lib|utils?|common|shared|core|helpers?|pkg|internal)(\/|$)/.test(p)) return 'library';
  return 'service';
}

function prettyName(id: string): string {
  if (id === '(root)') return 'Project root';
  const segs = id.split('/');
  const last = segs[segs.length - 1];
  const parent = segs.length > 1 ? segs[segs.length - 2] : '';
  const generic = ['src', 'lib', 'app', 'index', 'main'];
  const name = generic.includes(last) && parent ? `${parent}/${last}` : last;
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Architecture derived purely from directory structure, the import graph and infra signals. */
export function heuristicArchitecture(ctx: RepoContext): Architecture {
  const components: Component[] = [];
  const idFor = new Map<string, string>();
  const used = new Set<string>();
  const uniq = (base: string) => {
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return id;
  };
  const withCode = ctx.groups.filter((g) => g.codeFiles > 0);
  for (const g of (withCode.length ? withCode : ctx.groups).slice(0, 18)) {
    const id = uniq(slug(g.id === '(root)' ? 'root' : g.id));
    idFor.set(g.id, id);
    const type = guessType(ctx, g.id, g.files);
    const codeFiles = g.files.filter((f) => isCode(ctx.fileByPath.get(f)!));
    const nonTest = codeFiles.filter((f) => !ctx.facts.get(f)?.isTest);
    const topFiles = (nonTest.length ? nonTest : codeFiles)
      .sort((a, b) => (ctx.centrality.get(b) ?? 0) - (ctx.centrality.get(a) ?? 0) || ctx.fileByPath.get(b)!.lines - ctx.fileByPath.get(a)!.lines)
      .slice(0, 3);
    const where = g.id === '(root)' ? 'at the repository root' : `under \`${g.id}/\``;
    const exported = topFiles.flatMap((f) => (ctx.facts.get(f)?.symbols ?? []).filter((s) => s.exported).map((s) => s.name)).slice(0, 5);
    components.push({
      id,
      name: prettyName(g.id),
      type,
      description: `${codeFiles.length} code file${codeFiles.length === 1 ? '' : 's'} ${where}${topFiles.length ? `; main: ${topFiles.map((f) => `\`${f.split('/').pop()}\``).join(', ')}` : ''}${exported.length ? `. Defines ${exported.join(', ')}` : ''}.`,
      responsibilities: topFiles.map((f) => `${f.split('/').pop()}: ${(ctx.summaries.get(f) ?? '').slice(0, 140)}`),
      paths: g.id === '(root)' ? [] : [g.id],
    });
  }
  const connections: Connection[] = [];
  for (const e of ctx.moduleEdges.slice(0, 40)) {
    const a = idFor.get(e.from);
    const b = idFor.get(e.to);
    if (!a || !b) continue;
    connections.push({
      id: `${a}--${b}`,
      from: a,
      to: b,
      kind: 'calls',
      label: `${e.count} import${e.count > 1 ? 's' : ''}`,
      description: `Code in \`${e.from}\` imports ${e.count} module(s) from \`${e.to}\`, e.g. ${e.samples
        .slice(0, 3)
        .map((s) => `\`${s.path}\` → \`${s.target}\``)
        .join(', ')}.`,
      evidence: e.samples.slice(0, 4).map((s) => ({ path: s.path, startLine: s.line, endLine: s.line, note: `imports ${s.target}` })),
    });
  }
  // External systems from infra signals.
  const infraUse = new Map<string, Map<string, { path: string; line: number; detail: string }[]>>();
  for (const f of ctx.files) {
    const fx = ctx.facts.get(f.path);
    if (!fx || fx.isTest) continue;
    const mod = ctx.fileToModule.get(f.path);
    if (!mod || !idFor.has(mod)) continue;
    for (const s of fx.infra) {
      if (!INFRA_NAMES[s.kind]) continue;
      const m = infraUse.get(s.kind) ?? infraUse.set(s.kind, new Map()).get(s.kind)!;
      const arr = m.get(mod) ?? m.set(mod, []).get(mod)!;
      if (arr.length < 3) arr.push({ path: f.path, line: s.line, detail: s.detail });
    }
  }
  for (const [kind, mods] of infraUse) {
    const info = INFRA_NAMES[kind];
    if (kind === 'http-client' && mods.size > 6) continue;
    const id = uniq(slug(info.name));
    components.push({ id, name: info.name, type: info.type, description: `${info.name}, detected from how the code uses it (${[...mods.keys()].length} module(s)).`, responsibilities: [], paths: [] });
    for (const [mod, uses] of mods) {
      const from = idFor.get(mod)!;
      connections.push({
        id: `${from}--${id}`,
        from,
        to: id,
        kind: info.kind,
        label: info.label,
        description: `\`${mod}\` talks to ${info.name}.`,
        evidence: uses.map((u) => ({ path: u.path, startLine: u.line, endLine: u.line, note: u.detail.slice(0, 80) })),
      });
    }
  }
  const eps = entryPoints(ctx);
  const overview = [
    `**${ctx.repoName}** contains ${ctx.files.length} files grouped into ${components.filter((c) => c.paths.length).length} modules.`,
    eps.length ? `Entry points: ${eps.slice(0, 6).map((e) => `\`${e}\``).join(', ')}.` : '',
    ctx.readme ? `From the README:\n\n> ${readmeIntro(ctx.readme)}` : '',
    '_This overview was generated from static analysis. Configure an LLM API key for richer architecture descriptions._',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { overview, components, connections };
}

function architecturePrompt(ctx: RepoContext): string {
  const routes = allRoutes(ctx);
  const modules = ctx.groups.slice(0, 22).map((g) => {
    const files = g.files
      .filter((f) => ctx.summaries.has(f))
      .sort((a, b) => (ctx.centrality.get(b) ?? 0) - (ctx.centrality.get(a) ?? 0))
      .slice(0, 6);
    const infra = new Set<string>();
    for (const f of g.files) for (const s of ctx.facts.get(f)?.infra ?? []) infra.add(s.kind);
    const ext = new Set<string>();
    for (const f of g.files) for (const p of ctx.graph.external.get(f) ?? []) ext.add(p);
    return [
      `## Module \`${g.id}\` (${g.files.length} files, ${g.codeFiles} code)`,
      infra.size ? `infra signals: ${[...infra].join(', ')}` : '',
      ext.size ? `external packages: ${[...ext].slice(0, 15).join(', ')}` : '',
      ...files.map((f) => `- ${f}: ${truncate(ctx.summaries.get(f)!, 400)}`),
    ]
      .filter(Boolean)
      .join('\n');
  });
  const edges = ctx.moduleEdges
    .slice(0, 60)
    .map((e) => `- ${e.from} -> ${e.to} (${e.count} imports) e.g. ${e.samples.slice(0, 2).map((s) => `${s.path}:${s.line} imports ${s.target}`).join('; ')}`);
  const infraSamples: string[] = [];
  for (const f of ctx.files) {
    for (const s of ctx.facts.get(f.path)?.infra ?? []) {
      if (infraSamples.length < 60 && s.kind !== 'http-client') infraSamples.push(`- ${f.path}:${s.line} [${s.kind}] ${s.detail}`);
    }
  }
  return [
    `Repository: ${ctx.repoName}`,
    ctx.readme ? `# README (excerpt)\n${truncate(ctx.readme, 4000)}` : '',
    `# Directory tree\n${dirTree(ctx.files)}`,
    `# Dependencies\n${ctx.deps.filter((d) => !d.dev).slice(0, 80).map((d) => `${d.ecosystem}:${d.name}@${d.version} (${d.manifest})`).join('\n')}`,
    `# Entry points\n${entryPoints(ctx).join('\n')}`,
    routes.length ? `# HTTP routes\n${routes.slice(0, 60).map((r) => `- ${r.method} ${r.route} (${r.path}:${r.line})`).join('\n')}` : '',
    `# Modules\n${modules.join('\n\n')}`,
    `# Module import edges\n${edges.join('\n')}`,
    infraSamples.length ? `# Infrastructure touch points\n${infraSamples.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function normalize(ctx: RepoContext, raw: z.infer<typeof LlmArchSchema>): Architecture {
  const used = new Set<string>();
  const remap = new Map<string, string>();
  const components: Component[] = [];
  for (const c of raw.components) {
    let id = slug(c.id || c.name);
    for (let i = 2; used.has(id); i++) id = `${slug(c.id || c.name)}-${i}`;
    used.add(id);
    remap.set(c.id, id);
    remap.set(slug(c.name), id);
    const paths = c.paths
      .map((p) => p.replace(/^\.?\//, '').replace(/\/\*\*?$/, '').replace(/\/$/, ''))
      .filter((p) => p && ctx.files.some((f) => f.path === p || f.path.startsWith(p + '/')));
    components.push({ ...c, id, paths });
  }
  const connections: Connection[] = [];
  const seen = new Set<string>();
  for (const e of raw.connections) {
    const from = remap.get(e.from) ?? remap.get(slug(e.from));
    const to = remap.get(e.to) ?? remap.get(slug(e.to));
    if (!from || !to || from === to) continue;
    let id = `${from}--${to}`;
    for (let i = 2; seen.has(id); i++) id = `${from}--${to}-${i}`;
    seen.add(id);
    connections.push({ id, from, to, kind: e.kind, label: e.label, description: e.description, evidence: cleanRefs(ctx, e.evidence) });
  }
  return { overview: raw.overview, components, connections };
}

export async function analyzeArchitecture(ctx: RepoContext): Promise<Architecture> {
  const heuristic = heuristicArchitecture(ctx);
  if (ctx.llm.name === 'mock') return heuristic;
  const toLlmShape = () => ({
    overview: heuristic.overview,
    components: heuristic.components,
    connections: heuristic.connections.map(({ id: _id, ...rest }) => rest),
  });
  const raw = await jsonWithFallback(
    ctx.llm,
    {
      name: 'architecture',
      maxTokens: 12_000,
      system:
        'You are a principal software architect. From the static-analysis facts provided, produce an accurate component-level architecture of the repository for an interactive diagram. ' +
        'Group modules into meaningful components (5-15) by responsibility, not just by folder. Include external systems the code talks to (databases, caches, queues, third-party APIs, the browser/user if relevant) as components with empty paths. ' +
        'Every connection must describe a real interaction supported by the import edges or infrastructure touch points, with evidence taken from the given file:line samples. Prefer kinds: http for network calls, db for persistence, queue/event for async messaging, calls for in-process calls.',
      messages: [{ role: 'user', content: architecturePrompt(ctx) }],
      schema: LlmArchSchema,
      heuristic: toLlmShape,
    },
    ctx.warn,
  );
  const arch = normalize(ctx, raw);
  return arch.components.length ? arch : heuristic;
}

/** Map every file to the component whose path prefix matches most specifically. */
export function assignFilesToComponents(ctx: RepoContext, arch: Architecture): Map<string, string> {
  const prefixes = arch.components.flatMap((c) => c.paths.map((p) => ({ p, id: c.id }))).sort((a, b) => b.p.length - a.p.length);
  const m = new Map<string, string>();
  for (const f of ctx.files) {
    const hit = prefixes.find(({ p }) => f.path === p || f.path.startsWith(p + '/'));
    if (hit) m.set(f.path, hit.id);
  }
  return m;
}
