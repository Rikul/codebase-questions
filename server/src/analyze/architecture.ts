import type { Architecture, Component, ComponentType, Connection, ConnectionKind, Layer } from '@cq/shared';
import { connectionId } from '@cq/shared';
import { buildHierarchy, filesUnder, flatten } from '../ingest/hierarchy.js';
import { linkHttpCalls } from '../ingest/http.js';
import type { RepoContext } from './context.js';
import { entryPoints, isCode, readmeIntro } from './context.js';

// The architecture diagram comes from static analysis only: the component tree follows packages and
// directories (ingest/hierarchy.ts), and connections are imports, HTTP calls matched to routes, and
// infrastructure use. The LLM never adds, merges or removes components.

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

const LAYER_OF: Record<ComponentType, Layer> = {
  frontend: 'interface', api: 'entry', cli: 'entry', worker: 'entry', service: 'core', library: 'core',
  database: 'data', queue: 'data', config: 'infra', test: 'infra', external: 'external', other: 'core',
};

const CONFIG_LANGS = new Set(['dockerfile', 'shell', 'bash', 'makefile', 'yaml', 'toml', 'hcl', 'terraform', 'nginx', 'powershell', 'batch']);

/** Type from the component's own folder name (not its whole path, so everything under server/ isn't "api") and its files. */
function guessType(ctx: RepoContext, fullPath: string, ownName: string, files: string[]): ComponentType {
  if (/(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/.test(fullPath.toLowerCase())) return 'test';
  const code = files.filter((f) => isCode(ctx.fileByPath.get(f)!));
  if (code.length && code.every((f) => CONFIG_LANGS.has(ctx.fileByPath.get(f)!.lang ?? '') || /(^|\/)(Dockerfile|Makefile)[^/]*$/.test(f))) return 'config';
  const p = ownName.toLowerCase();
  const routes = files.reduce((n, f) => n + (ctx.facts.get(f)?.routes.length ?? 0), 0);
  if (routes > 0 || /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|server)(\/|$)/.test(p)) return 'api';
  const ui = files.filter((f) => /\.(tsx|jsx|vue|svelte|astro|html|css|scss)$/.test(f)).length;
  if (/(^|\/)(web|ui|frontend|client|components|pages|views|public|static|www|site)(\/|$)/.test(p) || ui > files.length / 2) return 'frontend';
  if (/(^|\/)(cli|cmd|bin|scripts?|tools?)(\/|$)/.test(p)) return 'cli';
  if (/(^|\/)(workers?|jobs?|tasks?|queues?|consumers?)(\/|$)/.test(p)) return 'worker';
  if (/(^|\/)(config|configs|settings|deploy|infra|k8s|helm|terraform|\.github)(\/|$)/.test(p)) return 'config';
  if (/(^|\/)(db|database|models?|migrations?|schema|repositories|dal|store|prisma)(\/|$)/.test(p)) return 'library';
  if (/(^|\/)(lib|utils?|common|shared|core|helpers?|pkg|internal)(\/|$)/.test(p)) return 'library';
  return 'service';
}

/** The diagram, plus which component owns each file (the deepest component containing it). */
export function staticArchitecture(ctx: RepoContext): { architecture: Architecture; owner: Map<string, string> } {
  const tree = buildHierarchy(ctx.files);
  const flat = flatten(tree);
  const owner = new Map<string, string>();
  for (const { node } of flat) for (const f of node.ownFiles) owner.set(f, node.id);
  const pathOf = new Map(flat.map(({ node }) => [node.id, node.path]));
  const label = (id: string) => (pathOf.get(id) ? `\`${pathOf.get(id)}\`` : 'the project root');

  const components: Component[] = flat.map(({ node, parent }) => {
    const files = filesUnder(node);
    const codeFiles = files.filter((f) => isCode(ctx.fileByPath.get(f)!));
    const ownName = parent && node.path.startsWith(parent.path + '/') ? node.path.slice(parent.path.length + 1) : node.path;
    const type = guessType(ctx, node.path, ownName || '(root)', files);
    const nonTest = codeFiles.filter((f) => !ctx.facts.get(f)?.isTest);
    const topFiles = [...(nonTest.length ? nonTest : codeFiles)]
      .sort((a, b) => (ctx.centrality.get(b) ?? 0) - (ctx.centrality.get(a) ?? 0) || ctx.fileByPath.get(b)!.lines - ctx.fileByPath.get(a)!.lines)
      .slice(0, 3);
    const exported = topFiles.flatMap((f) => (ctx.facts.get(f)?.symbols ?? []).filter((s) => s.exported).map((s) => s.name)).slice(0, 5);
    const where = node.path ? `under \`${node.path}/\`` : 'at the repository root';
    const what = node.kind === 'package' ? `Package${node.name !== node.path ? ` \`${node.name}\`` : ''} with ${codeFiles.length}` : `${codeFiles.length}`;
    return {
      id: node.id,
      name: node.name,
      type,
      description: `${what} code file${codeFiles.length === 1 ? '' : 's'} ${where}${topFiles.length ? `; main: ${topFiles.map((f) => `\`${f.split('/').pop()}\``).join(', ')}` : ''}${exported.length ? `. Defines ${exported.join(', ')}` : ''}.`,
      responsibilities: topFiles.map((f) => `${f.split('/').pop()}: ${(ctx.summaries.get(f) ?? '').slice(0, 140)}`),
      paths: node.path ? [node.path] : [],
      layer: LAYER_OF[type],
      keyFiles: topFiles,
      entryPoints: files.filter((f) => ctx.facts.get(f)?.isEntry && !ctx.facts.get(f)?.isTest).slice(0, 4),
      techStack: [...new Set(files.flatMap((f) => [...(ctx.graph.external.get(f) ?? [])]))].slice(0, 6),
      ...(parent ? { parentId: parent.id } : {}),
      ...(node.kind === 'package' && !parent ? { expandByDefault: true } : {}),
    };
  });

  const connections: Connection[] = [];
  // Imports between the components that own the two files.
  const imports = new Map<string, { from: string; to: string; n: number; samples: { path: string; line: number; target: string }[] }>();
  for (const e of ctx.graph.edges) {
    const a = owner.get(e.from);
    const b = owner.get(e.to);
    if (!a || !b || a === b) continue;
    const k = `${a}\0${b}`;
    const agg = imports.get(k) ?? imports.set(k, { from: a, to: b, n: 0, samples: [] }).get(k)!;
    agg.n++;
    if (agg.samples.length < 4) agg.samples.push({ path: e.from, line: e.line, target: e.to });
  }
  for (const e of imports.values()) {
    connections.push({
      id: connectionId(e.from, e.to, 'calls'),
      from: e.from,
      to: e.to,
      kind: 'calls',
      label: `${e.n} import${e.n > 1 ? 's' : ''}`,
      description: `Code in ${label(e.from)} imports code in ${label(e.to)} ${e.n} time${e.n > 1 ? 's' : ''}, e.g. ${e.samples.slice(0, 3).map((s) => `\`${s.path}\` → \`${s.target}\``).join(', ')}.`,
      evidence: e.samples.map((s) => ({ path: s.path, startLine: s.line, endLine: s.line, note: `imports ${s.target}` })),
      sync: 'sync',
      protocol: 'in-process call',
      direction: 'request',
      confidence: 'verified',
      weight: e.n,
    });
  }

  // API calls from client code matched to the server routes that handle them.
  const http = new Map<string, { from: string; to: string; calls: Set<string>; routes: Map<string, { path: string; line: number }>; evidence: { path: string; line: number; note: string }[] }>();
  for (const l of linkHttpCalls(ctx.facts)) {
    const a = owner.get(l.client);
    const b = owner.get(l.server);
    if (!a || !b || a === b) continue;
    const k = `${a}\0${b}`;
    const agg = http.get(k) ?? http.set(k, { from: a, to: b, calls: new Set(), routes: new Map(), evidence: [] }).get(k)!;
    const callKey = `${l.client}:${l.clientLine}`;
    if (!agg.calls.has(callKey) && agg.evidence.length < 3) agg.evidence.push({ path: l.client, line: l.clientLine, note: `calls ${l.callPath}` });
    agg.calls.add(callKey);
    agg.routes.set(`${l.method} ${l.route}`, { path: l.server, line: l.serverLine });
  }
  for (const e of http.values()) {
    const routes = [...e.routes];
    connections.push({
      id: connectionId(e.from, e.to, 'http'),
      from: e.from,
      to: e.to,
      kind: 'http',
      label: `${e.calls.size} API call${e.calls.size > 1 ? 's' : ''}`,
      description: `Code in ${label(e.from)} calls ${routes.length} HTTP endpoint${routes.length > 1 ? 's' : ''} served by ${label(e.to)}: ${routes.slice(0, 5).map(([r]) => `\`${r}\``).join(', ')}${routes.length > 5 ? ', …' : ''}.`,
      evidence: [
        ...e.evidence.map((v) => ({ path: v.path, startLine: v.line, endLine: v.line, note: v.note })),
        ...routes.slice(0, 2).map(([r, v]) => ({ path: v.path, startLine: v.line, endLine: v.line, note: `handles ${r}` })),
      ],
      sync: 'sync',
      protocol: 'REST/HTTP',
      direction: 'request',
      confidence: 'verified',
      weight: e.calls.size,
    });
  }

  // External systems from infrastructure signals (databases, queues, third-party APIs).
  const topOf = new Map<string, string>();
  for (const { node, parent } of flat) topOf.set(node.id, parent ? topOf.get(parent.id)! : node.id);
  const infraUse = new Map<string, Map<string, { path: string; line: number; detail: string }[]>>();
  for (const f of ctx.files) {
    const fx = ctx.facts.get(f.path);
    const own = owner.get(f.path);
    if (!fx || fx.isTest || !own) continue;
    for (const s of fx.infra) {
      if (!INFRA_NAMES[s.kind]) continue;
      const m = infraUse.get(s.kind) ?? infraUse.set(s.kind, new Map()).get(s.kind)!;
      const arr = m.get(own) ?? m.set(own, []).get(own)!;
      if (arr.length < 3) arr.push({ path: f.path, line: s.line, detail: s.detail });
    }
  }
  const usedIds = new Set(components.map((c) => c.id));
  for (const [kind, owners] of infraUse) {
    const info = INFRA_NAMES[kind];
    if (kind === 'http-client' && new Set([...owners.keys()].map((o) => topOf.get(o))).size > 6) continue;
    let id = info.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    for (let i = 2; usedIds.has(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
    usedIds.add(id);
    components.push({ id, layer: info.type === 'external' ? 'external' : 'data', name: info.name, type: info.type, description: `${info.name}, detected from how the code uses it (${owners.size} component${owners.size > 1 ? 's' : ''}).`, responsibilities: [], paths: [] });
    for (const [from, uses] of owners) {
      connections.push({
        id: connectionId(from, id, info.kind),
        from,
        to: id,
        kind: info.kind,
        label: info.label,
        description: `${label(from)} talks to ${info.name}.`,
        evidence: uses.map((u) => ({ path: u.path, startLine: u.line, endLine: u.line, note: u.detail.slice(0, 80) })),
        sync: info.kind === 'queue' ? 'async' : 'sync',
        protocol: info.label,
        direction: 'request',
        confidence: 'verified',
        weight: uses.length,
      });
    }
  }

  const top = tree.length;
  const packages = tree.filter((n) => n.kind === 'package').length;
  const eps = entryPoints(ctx);
  const overview = [
    `**${ctx.repoName}** contains ${ctx.files.length} files${packages ? ` in ${packages} package${packages > 1 ? 's' : ''}` : ''}, shown as ${top} top-level component${top > 1 ? 's' : ''}. Expand a component to see the modules and directories inside it.`,
    http.size ? `Client code calls the server over HTTP in ${http.size} place${http.size > 1 ? 's' : ''} (matched from API paths in the code to the routes that handle them).` : '',
    eps.length ? `Entry points: ${eps.slice(0, 6).map((e) => `\`${e}\``).join(', ')}.` : '',
    ctx.readme ? `From the README:\n\n> ${readmeIntro(ctx.readme)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { architecture: { overview, components, connections }, owner };
}
