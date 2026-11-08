import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { AgentStep, Architecture, ComponentType, Connection, DiagramAnswer, DiagramEvent, Layer, ViewComponent, ViewConnection } from '@cq/shared';
import { defaultExpanded, viewArchitecture } from '@cq/shared';
import { api, streamPost } from '../lib/api';
import { KIND_STYLE, TYPE_COLORS } from '../lib/format';
import { useRepo } from '../lib/repoContext';
import { AgentTrace, upsertStep } from './AgentTrace';
import { ComponentPanel, ConnectionPanel, OverviewPanel } from './ArchPanels';
import { Markdown } from './Markdown';

const elk = new ELK();
type Dir = 'RIGHT' | 'DOWN';

type CompData = { comp: ViewComponent; dir: Dir; dim: boolean; selected: boolean; lit: boolean; usedBy: number; onToggle: (id: string) => void };
type GroupData = { comp: ViewComponent; dir: Dir; dim: boolean; selected: boolean; onToggle: (id: string) => void };
type FileData = { label: string; path: string; external: boolean; dir: Dir; summary?: string };

const LAYER_ORDER: Record<Layer, number> = { entry: 0, interface: 1, core: 2, data: 3, infra: 4, external: 5 };
const LAYER_LABEL: Record<Layer, string> = { entry: 'Entry', interface: 'Interface', core: 'Core', data: 'Data', infra: 'Infra', external: 'External' };

const CompNode = memo(({ data }: NodeProps<Node<CompData>>) => {
  const { comp, dir, dim, selected, lit, usedBy, onToggle } = data;
  const [tp, sp] = dir === 'RIGHT' ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  return (
    <div
      className={`comp-node ${comp.type} ${dim ? 'dim' : ''} ${selected ? 'selected' : ''} ${lit ? 'lit' : ''}`}
      style={{ ['--node-color' as string]: TYPE_COLORS[comp.type] ?? TYPE_COLORS.other }}
      title={[comp.label ? `${comp.label} — ${comp.name}` : comp.name, comp.summary, comp.description].filter(Boolean).join('\n')}
    >
      <Handle type="target" position={tp} />
      <div className="t">
        {comp.type}
        {comp.layer && <span className="layer">{LAYER_LABEL[comp.layer]}</span>}
        {comp.hasChildren && (
          <button className="node-toggle nodrag" title="Expand: show what is inside" onClick={(e) => { e.stopPropagation(); onToggle(comp.id); }}>⊕</button>
        )}
      </div>
      {/* LLM label as the title, with the static name (as found in the code) underneath. */}
      <div className="n">{comp.label ?? comp.name}</div>
      <div className="d">{comp.label ? <span className="static-name">{comp.name}</span> : comp.paths.length ? comp.paths.join(', ') : comp.techStack?.length ? comp.techStack.slice(0, 3).join(' · ') : comp.description}</div>
      {usedBy > 0 && <div className="used-by" title="Imports into this widely used module are hidden; use “Shared-module edges” to show them">used by {usedBy} modules</div>}
      <Handle type="source" position={sp} />
    </div>
  );
});

const GroupNode = memo(({ data }: NodeProps<Node<GroupData>>) => {
  const { comp, dir, dim, selected, onToggle } = data;
  const [tp, sp] = dir === 'RIGHT' ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  return (
    <div className={`group-node ${dim ? 'dim' : ''} ${selected ? 'selected' : ''}`} style={{ ['--node-color' as string]: TYPE_COLORS[comp.type] ?? TYPE_COLORS.other }} title={[comp.summary, comp.description].filter(Boolean).join('\n')}>
      <Handle type="target" position={tp} />
      <div className="group-head">
        <button className="node-toggle nodrag" title="Collapse" onClick={(e) => { e.stopPropagation(); onToggle(comp.id); }}>⊖</button>
        <b>{comp.label ?? comp.name}</b>
        <span className="muted">{comp.label ? comp.name : comp.paths[0] ?? ''}</span>
      </div>
      <Handle type="source" position={sp} />
    </div>
  );
});

const FileNodeView = memo(({ data }: NodeProps<Node<FileData>>) => {
  const [tp, sp] = data.dir === 'RIGHT' ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  return (
    <div className={`file-node ${data.external ? 'ext' : ''}`} title={data.summary ?? data.path}>
      <Handle type="target" position={tp} />
      {data.label}
      <Handle type="source" position={sp} />
    </div>
  );
});

const nodeTypes = { comp: CompNode, file: FileNodeView, group: GroupNode };

type Pt = { x: number; y: number };
type EdgeData = { points?: Pt[]; square?: boolean; free?: boolean; [k: string]: unknown };

/** Draws the route ELK computed (straight segments, right-angle turns). Falls back to a step or curve once a box is dragged. */
const RoutedEdge = memo((props: EdgeProps<Edge<EdgeData>>) => {
  const { data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props;
  let path: string;
  let lx: number;
  let ly: number;
  const pts = data?.points;
  if (pts && pts.length >= 2 && !data?.free) {
    path = `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')}`;
    // Label at the halfway point along the route.
    const segs = pts.slice(1).map((p, i) => ({ a: pts[i], b: p, len: Math.abs(p.x - pts[i].x) + Math.abs(p.y - pts[i].y) }));
    let half = segs.reduce((n, sg) => n + sg.len, 0) / 2;
    const sg = segs.find((x) => (half -= x.len) <= 0) ?? segs[segs.length - 1];
    const t = sg.len ? (sg.len + half) / sg.len : 0.5;
    lx = sg.a.x + (sg.b.x - sg.a.x) * t;
    ly = sg.a.y + (sg.b.y - sg.a.y) * t;
  } else {
    const args = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
    [path, lx, ly] = data?.square ? getSmoothStepPath({ ...args, borderRadius: 0 }) : getBezierPath(args);
  }
  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={props.markerEnd}
      style={props.style}
      interactionWidth={props.interactionWidth}
      label={props.label}
      labelX={lx}
      labelY={ly}
      labelStyle={props.labelStyle}
      labelShowBg={props.labelShowBg}
      labelBgStyle={props.labelBgStyle}
      labelBgPadding={props.labelBgPadding}
      labelBgBorderRadius={props.labelBgBorderRadius}
    />
  );
});

const edgeTypes = { routed: RoutedEdge };

const BASE_OPTS = {
  'elk.algorithm': 'layered',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  // Edge routes in diagram (root) coordinates, so they can be drawn directly.
  'elk.json.edgeCoords': 'ROOT',
};

/** Layout options: square = right-angle routes with compact spacing; otherwise curves with roomier spacing. */
function layoutOpts(dir: Dir, square: boolean): Record<string, string> {
  return {
    ...BASE_OPTS,
    'elk.direction': dir,
    'elk.edgeRouting': square ? 'ORTHOGONAL' : 'SPLINES',
    'elk.layered.spacing.nodeNodeBetweenLayers': square ? '64' : '110',
    'elk.spacing.nodeNode': square ? '24' : '40',
    'elk.spacing.edgeNode': '14',
    'elk.spacing.edgeEdge': '8',
    'elk.layered.spacing.edgeNodeBetweenLayers': '14',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '8',
    'elk.spacing.edgeLabel': '4',
  };
}

type ElkEdge = { id: string; sections?: { startPoint: Pt; endPoint: Pt; bendPoints?: Pt[] }[] };

/** Edge routes from an ELK result (edges can end up on any level of the hierarchy). */
function routesOf(n: { edges?: ElkEdge[]; children?: unknown[] }, out = new Map<string, Pt[]>()): Map<string, Pt[]> {
  for (const e of n.edges ?? []) {
    const sec = e.sections?.[0];
    if (sec) out.set(e.id, [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]);
  }
  for (const c of (n.children ?? []) as { edges?: ElkEdge[]; children?: unknown[] }[]) routesOf(c, out);
  return out;
}

async function flatLayout<T extends Record<string, unknown>>(nodes: Node<T>[], edges: { id: string; source: string; target: string }[], dir: Dir, square: boolean, size: (n: Node<T>) => { w: number; h: number }) {
  const res = await elk.layout({
    id: 'root',
    layoutOptions: layoutOpts(dir, square),
    children: nodes.map((n) => ({ id: n.id, width: size(n).w, height: size(n).h })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const pos = new Map(res.children?.map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  return { nodes: nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? { x: 0, y: 0 }, style: { width: size(n).w, height: size(n).h } })), routes: routesOf(res as never) };
}

type ElkNode = { id: string; width?: number; height?: number; x?: number; y?: number; children?: ElkNode[]; layoutOptions?: Record<string, string> };

/** Component layout: expanded components are containers around their children (nested to any depth). */
async function componentLayout(comps: ViewComponent[], conns: Connection[], dir: Dir, square: boolean, toggle: (id: string) => void, usedBy: Map<string, number>): Promise<{ nodes: Node[]; routes: Map<string, Pt[]> }> {
  const W = 200;
  const H = 80;
  const ids = new Set(comps.map((c) => c.id));
  const kids = new Map<string, ViewComponent[]>();
  const roots: ViewComponent[] = [];
  for (const c of comps) {
    if (c.parentId && ids.has(c.parentId)) (kids.get(c.parentId) ?? kids.set(c.parentId, []).get(c.parentId)!).push(c);
    else roots.push(c);
  }
  // Layers order the columns, but only work in a flat graph.
  const usePartitions = !comps.some((c) => c.container) && comps.some((c) => c.layer);
  const toElk = (c: ViewComponent): ElkNode =>
    c.container && kids.get(c.id)?.length
      ? { id: c.id, layoutOptions: { 'elk.padding': '[top=40,left=16,bottom=16,right=16]' }, children: kids.get(c.id)!.map(toElk) }
      : { id: c.id, width: W, height: usedBy.get(c.id) ? H + 18 : H, ...(usePartitions ? { layoutOptions: { 'elk.partitioning.partition': String(LAYER_ORDER[c.layer ?? 'core']) } } : {}) };
  const res = (await elk.layout({
    id: 'root',
    layoutOptions: { ...layoutOpts(dir, square), 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', ...(usePartitions ? { 'elk.partitioning.activate': 'true' } : {}) },
    children: roots.map(toElk),
    edges: conns.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  })) as ElkNode;
  const byId = new Map(comps.map((c) => [c.id, c]));
  const out: Node[] = [];
  // React Flow needs parents before children; child positions are relative to the parent, as ELK reports them.
  const emit = (n: ElkNode, parent?: string) => {
    const c = byId.get(n.id)!;
    const base = { id: c.id, position: { x: n.x ?? 0, y: n.y ?? 0 }, ...(parent ? { parentId: parent, extent: 'parent' as const } : {}) };
    if (n.children?.length) {
      out.push({ ...base, type: 'group', data: { comp: c, dir, dim: false, selected: false, onToggle: toggle }, style: { width: n.width, height: n.height } });
      for (const k of n.children) emit(k, c.id);
    } else out.push({ ...base, type: 'comp', style: { width: n.width, height: n.height }, data: { comp: c, dir, dim: false, selected: false, lit: false, usedBy: usedBy.get(c.id) ?? 0, onToggle: toggle } });
  };
  for (const n of res.children ?? []) emit(n);
  return { nodes: out, routes: routesOf(res as never) };
}

function edgeFor(e: ViewConnection, square: boolean, points?: Pt[]): Edge {
  const st = KIND_STYLE[e.kind] ?? KIND_STYLE.other;
  const async = e.sync === 'async' || e.kind === 'queue' || e.kind === 'event';
  const inferred = e.confidence === 'inferred';
  // Hub and redundant edges are only drawn when the user asks for them, and then faded.
  const faded = inferred || e.hub || e.redundant;
  const label = e.protocol && !/^in-process/i.test(e.protocol) && !e.label.toLowerCase().includes(e.protocol.toLowerCase()) ? `${e.label} · ${e.protocol}` : e.label;
  const width = Math.min(5, 1.2 + Math.log2(Math.max(1, e.weight)));
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    label: inferred ? `${label} ?` : e.hub || e.redundant ? undefined : label,
    type: 'routed',
    data: { conn: e, baseOpacity: faded ? 0.35 : 1, width, square, points },
    animated: async,
    style: { stroke: st.color, strokeWidth: width, strokeDasharray: async ? '6 4' : inferred ? '2 3' : st.dash },
    markerEnd: { type: MarkerType.ArrowClosed, color: st.color, width: 18, height: 18 },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    interactionWidth: 24,
  };
}

type Selection =
  | { kind: 'component'; id: string }
  | { kind: 'connection'; id: string }
  | { kind: 'overview' }
  | { kind: 'answer' }
  | null;

interface AnswerState {
  question: string;
  steps: AgentStep[];
  running: boolean;
  answer: DiagramAnswer | null;
  cached: boolean;
  error: string | null;
}

function Diagram({ arch }: { arch: Architecture }) {
  const { repo, openCode } = useRepo();
  const rf = useReactFlow();
  const [dir, setDir] = useState<Dir>('RIGHT');
  const [sel, setSel] = useState<Selection>({ kind: 'overview' });
  const [hidden, setHidden] = useState<Set<ComponentType>>(new Set(['test']));
  const [drill, setDrill] = useState<ViewComponent | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(arch));
  const [showHubs, setShowHubs] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Square edges (straight lines, right-angle turns, compact layout) unless the user picked curves.
  const [square, setSquare] = useState(() => localStorage.getItem('cq.diagram.edges') !== 'curved');
  useEffect(() => localStorage.setItem('cq.diagram.edges', square ? 'square' : 'curved'), [square]);
  /** Boxes the user dragged: their edges no longer match the computed routes. */
  const [moved, setMoved] = useState<Set<string>>(new Set());
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [q, setQ] = useState('');
  const [ans, setAns] = useState<AnswerState | null>(null);
  const [tourIdx, setTourIdx] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // A new diagram (after re-analysis) starts from its default expansion.
  const treeSig = useMemo(() => arch.components.map((c) => c.id).join(','), [arch]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setExpanded(defaultExpanded(arch)), [treeSig]);
  const toggle = useCallback((id: string) => setExpanded((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const view = useMemo(() => viewArchitecture(arch, expanded), [arch, expanded]);

  const visible = useMemo(() => {
    // Hiding a type also hides whatever is inside those components.
    const byId = new Map(view.components.map((c) => [c.id, c]));
    const shown = (c: ViewComponent): boolean => !hidden.has(c.type) && (!c.parentId || !byId.has(c.parentId) || shown(byId.get(c.parentId)!));
    const comps = view.components.filter(shown);
    const ids = new Set(comps.map((c) => c.id));
    const inView = view.connections.filter((e) => ids.has(e.from) && ids.has(e.to));
    const conns = inView.filter((e) => (showHubs || !e.hub) && (showAll || !e.redundant || e.hub));
    // Badge for widely used modules whose incoming imports are hidden.
    const usedBy = new Map<string, number>();
    if (!showHubs) for (const e of inView) if (e.hub) usedBy.set(e.to, (usedBy.get(e.to) ?? 0) + 1);
    return { comps, conns, usedBy, hiddenHubs: inView.filter((e) => e.hub).length, hiddenRedundant: inView.filter((e) => e.redundant && !e.hub).length };
  }, [view, hidden, showHubs, showAll]);

  useEffect(() => {
    if (drill) return;
    let cancelled = false;
    componentLayout(visible.comps, visible.conns, dir, square, toggle, visible.usedBy).then(({ nodes: laid, routes }) => {
      if (cancelled) return;
      setMoved(new Set());
      setNodes(laid);
      setEdges(visible.conns.map((e) => edgeFor(e, square, square ? routes.get(e.id) : undefined)));
      requestAnimationFrame(() => rf.fitView({ padding: 0.08, duration: 300, maxZoom: 1.1 }));
    });
    return () => {
      cancelled = true;
    };
  }, [visible, dir, square, drill, rf, toggle]);

  // File-level drill-down.
  useEffect(() => {
    if (!drill) return;
    let cancelled = false;
    api<{ nodes: { path: string; summary: string | null; external: boolean }[]; edges: { from: string; to: string; line: number }[] }>(`/repos/${repo.id}/graph?scope=${encodeURIComponent(drill.id)}`).then(async (g) => {
      const label = (p: string) => {
        const pre = drill.paths.find((x) => p.startsWith(x + '/'));
        return pre ? p.slice(pre.length + 1) : p;
      };
      const ns: Node<FileData>[] = g.nodes.map((n) => ({ id: n.path, type: 'file', position: { x: 0, y: 0 }, data: { label: label(n.path), path: n.path, external: n.external, dir, summary: n.summary ?? undefined } }));
      const es = g.edges.map((e, i) => ({ id: `f${i}`, source: e.from, target: e.to }));
      const { nodes: laid, routes } = await flatLayout(ns, es, dir, square, (n) => ({ w: Math.min(240, 18 + (n.data as FileData).label.length * 7), h: 28 }));
      if (cancelled) return;
      setMoved(new Set());
      setNodes(laid);
      setEdges(g.edges.map((e, i) => ({ id: `f${i}`, type: 'routed', source: e.from, target: e.to, data: { line: e.line, square, points: square ? routes.get(`f${i}`) : undefined }, style: { stroke: 'var(--edge-calls)', strokeWidth: 1.2 }, markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-calls)' } })));
      requestAnimationFrame(() => rf.fitView({ padding: 0.12, duration: 300 }));
    });
    return () => {
      cancelled = true;
    };
  }, [drill, dir, square, repo.id, rf]);

  // ---- Ask the diagram ----
  const askDiagram = (question: string, refresh = false) => {
    if (!question.trim()) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAns({ question, steps: [], running: true, answer: null, cached: false, error: null });
    setTourIdx(null);
    setSel({ kind: 'answer' });
    streamPost<DiagramEvent>(
      `/repos/${repo.id}/diagram/answer`,
      { question, refresh },
      (e) => {
        if (e.type === 'step') setAns((a) => a && { ...a, steps: upsertStep(a.steps, e.step) });
        else if (e.type === 'result') setAns((a) => a && { ...a, answer: e.answer, cached: e.cached, running: false });
        else if (e.type === 'error') setAns((a) => a && { ...a, error: e.message, running: false });
      },
      ctrl.signal,
    )
      .catch((err) => (err as Error).name !== 'AbortError' && setAns((a) => a && { ...a, error: (err as Error).message }))
      .finally(() => setAns((a) => a && { ...a, running: false }));
  };
  // Answers may name components inside collapsed ones: show them on the visible component that contains them.
  const shownComp = useCallback((id: string) => view.visibleOf.get(id) ?? id, [view]);
  const shownEdge = useCallback(
    (id: string) => {
      if (visible.conns.some((e) => e.id === id)) return id;
      const [pair, kind = 'calls'] = id.split('~');
      const stored = arch.connections.find((e) => e.id === id);
      const ends = stored ? [stored.from, stored.to] : pair.split('--').length === 2 ? pair.split('--') : null;
      if (!ends) return id;
      const [a, b] = ends.map(shownComp);
      return visible.conns.find((e) => e.from === a && e.to === b && e.kind === (stored?.kind ?? kind))?.id ?? id;
    },
    [visible, arch, shownComp],
  );
  const rawHighlight = ans?.answer && sel?.kind === 'answer' ? ans.answer.highlight : null;
  const highlight = useMemo(
    () => rawHighlight && { componentIds: [...new Set(rawHighlight.componentIds.map(shownComp))], connectionIds: [...new Set(rawHighlight.connectionIds.map(shownEdge))] },
    [rawHighlight, shownComp, shownEdge],
  );
  const tour = ans?.answer?.tour ?? [];
  const rawStop = tourIdx !== null ? tour[tourIdx] : null;
  const stop = useMemo(
    () => rawStop && { ...rawStop, componentId: rawStop.componentId ? shownComp(rawStop.componentId) : undefined, connectionId: rawStop.connectionId ? shownEdge(rawStop.connectionId) : undefined },
    [rawStop, shownComp, shownEdge],
  );

  // Pan/zoom to each tour stop.
  useEffect(() => {
    if (!stop) return;
    const conn = stop.connectionId ? visible.conns.find((c) => c.id === stop.connectionId) : undefined;
    const ids = conn ? [conn.from, conn.to] : stop.componentId ? [stop.componentId] : [];
    if (ids.length) rf.fitView({ nodes: ids.map((id) => ({ id })), duration: 500, padding: 0.8, maxZoom: 1.3 });
  }, [stop, visible, rf]);

  // ---- emphasis (selection, answer highlight, tour stop) ----
  const selectedId = sel?.kind === 'component' ? sel.id : stop?.componentId ?? null;
  const selectedEdge = sel?.kind === 'connection' ? sel.id : stop?.connectionId ?? null;
  const displayNodes = useMemo(() => {
    if (drill) return nodes;
    const neighbors = new Set<string>();
    if (highlight) highlight.componentIds.forEach((id) => neighbors.add(id));
    else if (selectedId) {
      neighbors.add(selectedId);
      for (const e of edges) {
        if (e.source === selectedId) neighbors.add(e.target);
        if (e.target === selectedId) neighbors.add(e.source);
      }
    }
    if (selectedEdge) {
      const e = edges.find((x) => x.id === selectedEdge);
      if (e) neighbors.add(e.source).add(e.target);
    }
    return nodes.map((n) =>
      n.type === 'group'
        ? { ...n, data: { ...n.data, selected: n.id === selectedId, dim: false } }
        : {
            ...n,
            selected: n.id === selectedId,
            data: { ...n.data, selected: n.id === selectedId, dim: neighbors.size > 0 && !neighbors.has(n.id), lit: Boolean(highlight?.componentIds.includes(n.id)) },
          },
    );
  }, [nodes, edges, selectedId, selectedEdge, drill, highlight, stop]);
  const displayEdges = useMemo(() => {
    // Dragging a box (or the container around it) detaches its edges from the computed routes.
    const parent = new Map(nodes.map((n) => [n.id, n.parentId]));
    const isMoved = (id: string) => {
      for (let cur: string | undefined = id; cur; cur = parent.get(cur)) if (moved.has(cur)) return true;
      return false;
    };
    const detach = (e: Edge) => (moved.size && (isMoved(e.source) || isMoved(e.target)) ? { ...e, data: { ...e.data, free: true } } : e);
    if (drill) return edges.map(detach);
    return edges.map(detach).map((e) => {
      const { baseOpacity: base = 1, width = 1.8 } = (e.data ?? {}) as { baseOpacity?: number; width?: number };
      const inAnswer = highlight?.connectionIds.includes(e.id);
      const active = selectedEdge ? e.id === selectedEdge : highlight ? inAnswer : selectedId ? e.source === selectedId || e.target === selectedId : true;
      return { ...e, animated: e.animated || Boolean(inAnswer), selected: e.id === selectedEdge, style: { ...e.style, opacity: active ? base : 0.12, strokeWidth: e.id === selectedEdge ? width + 1.4 : inAnswer ? width + 1 : width } };
    });
  }, [edges, nodes, moved, selectedId, selectedEdge, drill, highlight]);

  const onNodeClick = useCallback(
    (_: unknown, n: Node) => {
      if (drill) openCode((n.data as FileData).path);
      else {
        setTourIdx(null);
        setSel({ kind: 'component', id: n.id });
      }
    },
    [drill, openCode],
  );
  const onEdgeClick = useCallback(
    (_: unknown, e: Edge) => {
      if (drill) {
        const line = (e.data as { line?: number })?.line;
        openCode(e.source, line ?? undefined, line ?? undefined);
      } else {
        setTourIdx(null);
        setSel({ kind: 'connection', id: e.id });
      }
    },
    [drill, openCode],
  );

  const types = [...new Set(arch.components.map((c) => c.type))];
  const title = (id: string) => { const c = arch.components.find((x) => x.id === id); return c ? c.label ?? c.name : id; };
  // Panels describe what is on screen: visible components and the edges between them.
  const shownArch: Architecture = useMemo(() => ({ overview: arch.overview, components: visible.comps, connections: visible.conns }), [arch.overview, visible]);
  const comp = sel?.kind === 'component' ? visible.comps.find((c) => c.id === sel.id) : undefined;
  const conn = sel?.kind === 'connection' ? visible.conns.find((c) => c.id === sel.id) : undefined;

  return (
    <>
      <div className="diagram-wrap">
        <div className="diagram-toolbar">
          {drill ? (
            <div className="card">
              <button className="btn sm ghost" onClick={() => setDrill(null)}>← All components</button>
              <span className="small" style={{ padding: '0 8px' }}>
                Files in <b>{drill.label ?? drill.name}</b>. Click a file to read it, or an edge to see the import.
              </span>
            </div>
          ) : (
            <>
              <div className="card">
                <button className={`btn sm ${sel?.kind === 'overview' ? '' : 'ghost'}`} onClick={() => setSel({ kind: 'overview' })}>Overview</button>
                {types.map((t) => (
                  <button
                    key={t}
                    className="btn sm ghost"
                    style={{ opacity: hidden.has(t) ? 0.45 : 1 }}
                    title={hidden.has(t) ? `Show ${t}` : `Hide ${t}`}
                    onClick={() => setHidden((h) => { const n = new Set(h); n.has(t) ? n.delete(t) : n.add(t); return n; })}
                  >
                    <i style={{ width: 8, height: 8, borderRadius: 2, background: TYPE_COLORS[t], display: 'inline-block' }} />
                    {t}
                  </button>
                ))}
              </div>
              <div className="card">
                <button className="btn sm ghost" title="Open every component" onClick={() => setExpanded(new Set(arch.components.filter((c) => arch.components.some((k) => k.parentId === c.id)).map((c) => c.id)))}>⊕ All</button>
                <button className="btn sm ghost" title="Back to the default view" onClick={() => setExpanded(defaultExpanded(arch))}>⊖ Reset</button>
                {(visible.hiddenHubs > 0 || showHubs) && (
                  <button className={`btn sm ${showHubs ? '' : 'ghost'}`} title="Imports into modules used by most of the code (helpers, shared types)" onClick={() => setShowHubs((v) => !v)}>
                    {showHubs ? '✓ ' : ''}Shared-module edges
                  </button>
                )}
                {(visible.hiddenRedundant > 0 || showAll) && (
                  <button className={`btn sm ${showAll ? '' : 'ghost'}`} title="Edges already implied by a longer path (A→B→C hides A→C)" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? '✓ ' : ''}All edges
                  </button>
                )}
              </div>
              <form
                className="card ask-diagram"
                onSubmit={(e) => {
                  e.preventDefault();
                  askDiagram(q);
                }}
              >
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask the diagram, e.g. what happens on login?" aria-label="Ask the diagram" />
                <button className="btn sm primary" disabled={!q.trim() || ans?.running}>Show me</button>
              </form>
            </>
          )}
          <div className="card">
            <button className="btn sm ghost" onClick={() => setDir((d) => (d === 'RIGHT' ? 'DOWN' : 'RIGHT'))} title="Toggle layout direction">
              {dir === 'RIGHT' ? '⇢ Horizontal' : '⇣ Vertical'}
            </button>
            <button className="btn sm ghost" onClick={() => setSquare((v) => !v)} title={square ? 'Switch to curved edges' : 'Switch to straight edges with right-angle turns (compact)'}>
              {square ? '┐ Square edges' : '∿ Curved edges'}
            </button>
          </div>
        </div>
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeDragStart={(_, n) => setMoved((m) => (m.has(n.id) ? m : new Set(m).add(n.id)))}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={(_, n) => {
            if (drill) return;
            const c = visible.comps.find((x) => x.id === n.id);
            if (c?.hasChildren) toggle(c.id);
            else if (c?.paths.length) setDrill(c);
          }}
          onEdgeClick={onEdgeClick}
          onPaneClick={() => {
            if (drill) return;
            setTourIdx(null);
            setSel(null);
          }}
          nodesConnectable={false}
          minZoom={0.15}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="var(--border)" />
          <Controls showInteractive={false} />
        </ReactFlow>
        {!drill && stop && (
          <div className="tour card">
            <div className="row">
              <b className="grow">Step {tourIdx! + 1} of {tour.length}</b>
              <button className="btn sm" disabled={tourIdx === 0} onClick={() => setTourIdx((i) => Math.max(0, (i ?? 0) - 1))}>← Prev</button>
              <button className="btn sm primary" disabled={tourIdx === tour.length - 1} onClick={() => setTourIdx((i) => Math.min(tour.length - 1, (i ?? 0) + 1))}>Next →</button>
              <button className="btn sm ghost" onClick={() => setTourIdx(null)} aria-label="End tour">✕</button>
            </div>
            <div className="small" style={{ marginTop: 6 }}>{stop.caption}</div>
            {stop.ref && <button className="cite" style={{ marginTop: 6 }} onClick={() => openCode(stop.ref!.path, stop.ref!.startLine, stop.ref!.endLine)}>{stop.ref.path}{stop.ref.startLine ? `:${stop.ref.startLine}` : ''}</button>}
          </div>
        )}
        {!drill && !stop && (
          <div className="legend card">
            {Object.entries({ calls: 'in-process call', http: 'network / HTTP', db: 'database', queue: 'async / queue' }).map(([k, label]) => {
              const st = KIND_STYLE[k as keyof typeof KIND_STYLE];
              return (
                <span key={k}>
                  <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke={st.color} strokeWidth="2" strokeDasharray={k === 'queue' ? '6 4' : st.dash} /></svg>
                  {label}
                </span>
              );
            })}
            <span className="muted">Thicker arrows stand for more imports or calls. Click a box or arrow for details; ⊕ or double-click opens a box, and a box with nothing inside shows its files.</span>
          </div>
        )}
      </div>
      {!drill && sel?.kind === 'overview' && <OverviewPanel arch={shownArch} onClose={() => setSel(null)} onSelect={(id) => setSel({ kind: 'component', id })} onAsk={(question) => { setQ(question); askDiagram(question); }} />}
      {!drill && sel?.kind === 'answer' && ans && (
        <aside className="panel">
          <div className="panel-head">
            <div className="grow">
              <div className="small kicker">Diagram answer{ans.cached ? ' · cached' : ''}</div>
              <h3 style={{ fontSize: 16, marginTop: 2 }}>{ans.question}</h3>
            </div>
            {ans.answer && <button className="btn sm ghost" title="Re-investigate" onClick={() => askDiagram(ans.question, true)}>↻</button>}
            <button className="btn sm ghost" onClick={() => { setSel(null); setTourIdx(null); }} aria-label="Close">✕</button>
          </div>
          <div className="panel-body">
            <AgentTrace steps={ans.steps} running={ans.running} />
            {ans.error && <div className="error-box">{ans.error}</div>}
            {ans.answer && (
              <>
                {tour.length > 0 && (
                  <button className="btn primary" onClick={() => setTourIdx(0)}>▶ Walk me through it ({tour.length} steps)</button>
                )}
                <Markdown>{ans.answer.answerMd}</Markdown>
                {tour.length > 0 && (
                  <section>
                    <h4>Tour</h4>
                    <ol className="tour-list">
                      {tour.map((t, i) => (
                        <li key={i} className={tourIdx === i ? 'active' : ''}>
                          <button className="plain-btn" onClick={() => setTourIdx(i)}>
                            <b>{t.componentId ? title(t.componentId) : (() => { const e = visible.conns.find((c) => c.id === shownEdge(t.connectionId ?? '')); return e ? `${title(e.from)} → ${title(e.to)}` : ''; })()}</b>
                            <div className="small muted">{t.caption}</div>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </>
            )}
          </div>
        </aside>
      )}
      {!drill && comp && (
        <ComponentPanel comp={comp} arch={shownArch} onClose={() => setSel(null)} onSelectConnection={(id) => setSel({ kind: 'connection', id })} onDrill={() => setDrill(comp)} />
      )}
      {!drill && conn && <ConnectionPanel conn={conn} arch={shownArch} expanded={expanded} onClose={() => setSel(null)} onSelectComponent={(id) => setSel({ kind: 'component', id })} />}
    </>
  );
}

export function ArchDiagram() {
  const { repo } = useRepo();
  const [arch, setArch] = useState<Architecture | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Architecture>(`/repos/${repo.id}/architecture`).then(setArch, (e) => setError(e.message));
  }, [repo.id, repo.updatedAt, repo.status]);

  if (error) return <div className="empty">{error}</div>;
  if (!arch) return <div className="empty"><span className="spinner" /></div>;
  if (!arch.components.length) return <div className="empty">No architecture yet. Run the analysis first.</div>;
  return (
    <div className="arch-shell">
      <div className="arch-top">
        <span className="muted small">{arch.components.filter((c) => !c.parentId).length} top-level components · {arch.components.length} in total, from static analysis</span>
      </div>
      <div className="arch-body">
        <ReactFlowProvider>
          <Diagram arch={arch} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
