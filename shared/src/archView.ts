// Views over the stored architecture. The stored diagram is a tree of components (packages →
// modules → directories, linked by parentId) with connections between the components that own
// the files involved. A view shows some of that tree: collapsed components stand in for their
// descendants, and connections are lifted to the nearest visible component and merged.
import type { Architecture, Component, Connection, ConnectionKind } from './index';

export interface ViewComponent extends Component {
  /** Expanded: drawn as a container around its children. */
  container: boolean;
  hasChildren: boolean;
  depth: number;
}

export interface ViewConnection extends Connection {
  weight: number;
  /** Target is imported by most of the diagram (utils, shared types): drawn faded or hidden. */
  hub?: boolean;
  /** Also implied by a longer import path (A→B→C makes A→C redundant). */
  redundant?: boolean;
}

export interface ArchView {
  overview: string;
  components: ViewComponent[];
  connections: ViewConnection[];
  /** Every component id mapped to the visible component that represents it. */
  visibleOf: Map<string, string>;
}

export const connectionId = (from: string, to: string, kind: ConnectionKind | string) => (kind === 'calls' ? `${from}--${to}` : `${from}--${to}~${kind}`);

export function childIndex(arch: Architecture): Map<string, Component[]> {
  const ids = new Set(arch.components.map((c) => c.id));
  const kids = new Map<string, Component[]>();
  for (const c of arch.components) {
    if (c.parentId && ids.has(c.parentId)) (kids.get(c.parentId) ?? kids.set(c.parentId, []).get(c.parentId)!).push(c);
  }
  return kids;
}

/** Ids of a component and everything below it. */
export function descendants(arch: Architecture, id: string, kids = childIndex(arch)): Set<string> {
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) if (!out.has(k.id)) out.add(k.id), stack.push(k.id);
  return out;
}

/** Components expanded when the diagram first opens. */
export function defaultExpanded(arch: Architecture): Set<string> {
  return new Set(arch.components.filter((c) => c.expandByDefault).map((c) => c.id));
}

function merge(group: Connection[], from: string, to: string, kind: string, name: (id: string) => string): ViewConnection {
  const weight = group.reduce((n, e) => n + (e.weight ?? 1), 0);
  const first = [...group].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))[0];
  const evidence = group.flatMap((e) => e.evidence).slice(0, 6);
  const verified = group.some((e) => e.confidence === 'verified');
  if (group.length === 1) return { ...first, id: connectionId(from, to, kind), from, to, weight };
  const label = kind === 'calls' ? `${weight} import${weight === 1 ? '' : 's'}` : kind === 'http' ? `${weight} API call${weight === 1 ? '' : 's'}` : first.label;
  const description =
    kind === 'calls'
      ? `Code in ${name(from)} imports code in ${name(to)} ${weight} time${weight === 1 ? '' : 's'}, across ${group.length} pairs of their parts.`
      : `${group.length} links from ${name(from)} to ${name(to)}. ${first.description}`;
  return { ...first, id: connectionId(from, to, kind), from, to, label, description, evidence, weight, confidence: verified ? 'verified' : first.confidence };
}

/** The diagram with `expanded` components opened up; everything else collapsed into its ancestors. */
export function viewArchitecture(arch: Architecture, expanded: Set<string>): ArchView {
  const ids = new Set(arch.components.map((c) => c.id));
  const kids = childIndex(arch);
  const byId = new Map(arch.components.map((c) => [c.id, c]));
  const components: ViewComponent[] = [];
  const visibleOf = new Map<string, string>();
  const walk = (c: Component, depth: number) => {
    const ch = kids.get(c.id) ?? [];
    const container = ch.length > 0 && expanded.has(c.id);
    components.push({ ...c, container, hasChildren: ch.length > 0, depth });
    visibleOf.set(c.id, c.id);
    if (container) for (const k of ch) walk(k, depth + 1);
    else for (const d of descendants(arch, c.id, kids)) if (d !== c.id) visibleOf.set(d, c.id);
  };
  for (const c of arch.components) if (!c.parentId || !ids.has(c.parentId)) walk(c, 0);

  const isAncestor = (a: string, b: string) => {
    for (let p = byId.get(b)?.parentId; p; p = byId.get(p)?.parentId) if (p === a) return true;
    return false;
  };
  const name = (id: string) => byId.get(id)?.name ?? id;
  const groups = new Map<string, { from: string; to: string; kind: string; items: Connection[] }>();
  for (const e of arch.connections) {
    const from = visibleOf.get(e.from);
    const to = visibleOf.get(e.to);
    if (!from || !to || from === to || isAncestor(from, to) || isAncestor(to, from)) continue;
    const key = `${from}\0${to}\0${e.kind}`;
    (groups.get(key) ?? groups.set(key, { from, to, kind: e.kind, items: [] }).get(key)!).items.push(e);
  }
  const connections = [...groups.values()].map((g) => merge(g.items, g.from, g.to, g.kind, name));
  flagClutter(components, connections);
  return { overview: arch.overview, components, connections, visibleOf };
}

/** Mark import edges into widely used modules (hub) and edges implied by longer paths (redundant). */
function flagClutter(components: ViewComponent[], connections: ViewConnection[]) {
  const calls = connections.filter((e) => e.kind === 'calls');
  const nodes = components.filter((c) => !c.container && c.type !== 'external' && c.paths.length).length;
  const sources = new Map<string, Set<string>>();
  for (const e of calls) (sources.get(e.to) ?? sources.set(e.to, new Set()).get(e.to)!).add(e.from);
  const hubs = new Set([...sources].filter(([, s]) => s.size >= Math.max(3, Math.ceil(nodes * 0.5))).map(([id]) => id));
  for (const e of calls) if (hubs.has(e.to)) e.hub = true;

  const out = new Map<string, string[]>();
  for (const e of calls) if (!e.hub) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  for (const e of calls) {
    if (e.hub) continue;
    // Is e.to reachable from e.from through at least one other node?
    const seen = new Set<string>([e.from]);
    const stack = (out.get(e.from) ?? []).filter((n) => n !== e.to);
    let found = false;
    while (stack.length && !found) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of out.get(n) ?? []) {
        if (m === e.to) found = true;
        else if (!seen.has(m)) stack.push(m);
      }
    }
    if (found) e.redundant = true;
  }
}

/** The view shown when the diagram opens, as a plain architecture (for prompts and tools). */
export function defaultView(arch: Architecture): Architecture {
  const v = viewArchitecture(arch, defaultExpanded(arch));
  return { overview: v.overview, components: v.components.filter((c) => !c.container), connections: v.connections.filter((e) => !e.hub && !e.redundant) };
}

/** A connection by view id: the stored links between the two components (and their descendants), merged. */
export function findConnection(arch: Architecture, id: string): ViewConnection | null {
  const [pair, kind = 'calls'] = id.split('~');
  const ids = new Set(arch.components.map((c) => c.id));
  const parts = pair.split('--');
  for (let i = 1; i < parts.length; i++) {
    const from = parts.slice(0, i).join('--');
    const to = parts.slice(i).join('--');
    if (!ids.has(from) || !ids.has(to)) continue;
    const kids = childIndex(arch);
    const a = descendants(arch, from, kids);
    const b = descendants(arch, to, kids);
    const items = arch.connections.filter((e) => e.kind === kind && a.has(e.from) && b.has(e.to));
    if (!items.length) return null;
    const byId = new Map(arch.components.map((c) => [c.id, c]));
    return merge(items, from, to, kind, (x) => byId.get(x)?.name ?? x);
  }
  return null;
}
