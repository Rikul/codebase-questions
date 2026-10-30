import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { AgentStep, Architecture, Component, ComponentType, Connection, DiagramAnswer, DiagramEvent, Flow, Layer } from '@cq/shared';
import { api, streamPost } from '../lib/api';
import { KIND_STYLE, TYPE_COLORS } from '../lib/format';
import { useRepo } from '../lib/repoContext';
import { AgentTrace, upsertStep } from './AgentTrace';
import { ComponentPanel, ConnectionPanel, OverviewPanel } from './ArchPanels';
import { FlowsView } from './FlowsView';
import { Markdown } from './Markdown';

const elk = new ELK();
type Dir = 'RIGHT' | 'DOWN';

type CompData = { comp: Component; dir: Dir; dim: boolean; selected: boolean; lit: boolean };
type GroupData = { label: string };
type FileData = { label: string; path: string; external: boolean; dir: Dir; summary?: string };

const LAYER_ORDER: Record<Layer, number> = { entry: 0, interface: 1, core: 2, data: 3, infra: 4, external: 5 };
const LAYER_LABEL: Record<Layer, string> = { entry: 'Entry', interface: 'Interface', core: 'Core', data: 'Data', infra: 'Infra', external: 'External' };

const CompNode = memo(({ data }: NodeProps<Node<CompData>>) => {
  const { comp, dir, dim, selected, lit } = data;
  const [tp, sp] = dir === 'RIGHT' ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  return (
    <div
      className={`comp-node ${comp.type} ${dim ? 'dim' : ''} ${selected ? 'selected' : ''} ${lit ? 'lit' : ''}`}
      style={{ ['--node-color' as string]: TYPE_COLORS[comp.type] ?? TYPE_COLORS.other }}
      title={comp.description}
    >
      <Handle type="target" position={tp} />
      <div className="t">
        {comp.type}
        {comp.layer && <span className="layer">{LAYER_LABEL[comp.layer]}</span>}
      </div>
      <div className="n">{comp.name}</div>
      <div className="d">{comp.techStack?.length ? comp.techStack.slice(0, 3).join(' · ') : comp.paths.length ? comp.paths.join(', ') : comp.description}</div>
      <Handle type="source" position={sp} />
    </div>
  );
});

const GroupNode = memo(({ data }: NodeProps<Node<GroupData>>) => (
  <div className="group-node">
    <span>{data.label}</span>
  </div>
));

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

const BASE_OPTS = {
  'elk.algorithm': 'layered',
  'elk.layered.spacing.nodeNodeBetweenLayers': '110',
  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeLabel': '6',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.edgeRouting': 'SPLINES',
};

async function flatLayout<T extends Record<string, unknown>>(nodes: Node<T>[], edges: { id: string; source: string; target: string }[], dir: Dir, size: (n: Node<T>) => { w: number; h: number }) {
  const res = await elk.layout({
    id: 'root',
    layoutOptions: { ...BASE_OPTS, 'elk.direction': dir },
    children: nodes.map((n) => ({ id: n.id, width: size(n).w, height: size(n).h })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const pos = new Map(res.children?.map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  return nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? { x: 0, y: 0 } }));
}

/** Component layout: layers drive left→right order; groups (services/packages) become containers. */
async function componentLayout(comps: Component[], conns: Connection[], dir: Dir): Promise<Node[]> {
  const W = 220;
  const H = 96;
  const groups = [...new Set(comps.map((c) => c.group).filter((g): g is string => Boolean(g)))];
  const useGroups = groups.length >= 2;
  const edges = conns.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] }));
  if (!useGroups) {
    const usePartitions = comps.some((c) => c.layer);
    const res = await elk.layout({
      id: 'root',
      layoutOptions: { ...BASE_OPTS, 'elk.direction': dir, ...(usePartitions ? { 'elk.partitioning.activate': 'true' } : {}) },
      children: comps.map((c) => ({
        id: c.id,
        width: W,
        height: H,
        ...(usePartitions ? { layoutOptions: { 'elk.partitioning.partition': String(LAYER_ORDER[c.layer ?? 'core']) } } : {}),
      })),
      edges,
    });
    const pos = new Map(res.children?.map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
    return comps.map((c) => ({ id: c.id, type: 'comp', position: pos.get(c.id) ?? { x: 0, y: 0 }, data: { comp: c, dir, dim: false, selected: false, lit: false } }));
  }
  const res = await elk.layout({
    id: 'root',
    layoutOptions: { ...BASE_OPTS, 'elk.direction': dir, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' },
    children: [
      ...groups.map((g) => ({
        id: `group:${g}`,
        layoutOptions: { 'elk.padding': '[top=34,left=16,bottom=16,right=16]' },
        children: comps.filter((c) => c.group === g).map((c) => ({ id: c.id, width: W, height: H })),
      })),
      ...comps.filter((c) => !c.group).map((c) => ({ id: c.id, width: W, height: H })),
    ],
    edges,
  });
  const out: Node[] = [];
  for (const ch of res.children ?? []) {
    if (ch.id.startsWith('group:')) {
      out.push({ id: ch.id, type: 'group', position: { x: ch.x ?? 0, y: ch.y ?? 0 }, data: { label: ch.id.slice(6) }, style: { width: ch.width, height: ch.height }, selectable: false, draggable: true });
      for (const k of ch.children ?? []) {
        const c = comps.find((x) => x.id === k.id)!;
        out.push({ id: c.id, type: 'comp', parentId: ch.id, extent: 'parent', position: { x: k.x ?? 0, y: k.y ?? 0 }, data: { comp: c, dir, dim: false, selected: false, lit: false } });
      }
    } else {
      const c = comps.find((x) => x.id === ch.id)!;
      out.push({ id: c.id, type: 'comp', position: { x: ch.x ?? 0, y: ch.y ?? 0 }, data: { comp: c, dir, dim: false, selected: false, lit: false } });
    }
  }
  return out;
}

function edgeFor(e: Connection): Edge {
  const st = KIND_STYLE[e.kind] ?? KIND_STYLE.other;
  const async = e.sync === 'async' || e.kind === 'queue' || e.kind === 'event';
  const inferred = e.confidence === 'inferred';
  const label = e.protocol && !/^in-process/i.test(e.protocol) && !e.label.toLowerCase().includes(e.protocol.toLowerCase()) ? `${e.label} · ${e.protocol}` : e.label;
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    label: inferred ? `${label} ?` : label,
    data: { conn: e, baseOpacity: inferred ? 0.55 : 1 },
    animated: async,
    style: { stroke: st.color, strokeWidth: 1.8, strokeDasharray: async ? '6 4' : inferred ? '2 3' : st.dash },
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

function Diagram({ arch, flows, onOpenFlow }: { arch: Architecture; flows: Flow[]; onOpenFlow: (id: string) => void }) {
  const { repo, openCode } = useRepo();
  const rf = useReactFlow();
  const [dir, setDir] = useState<Dir>('RIGHT');
  const [sel, setSel] = useState<Selection>({ kind: 'overview' });
  const [hidden, setHidden] = useState<Set<ComponentType>>(new Set(['test']));
  const [drill, setDrill] = useState<Component | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [q, setQ] = useState('');
  const [ans, setAns] = useState<AnswerState | null>(null);
  const [tourIdx, setTourIdx] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const visible = useMemo(() => {
    const comps = arch.components.filter((c) => !hidden.has(c.type));
    const ids = new Set(comps.map((c) => c.id));
    return { comps, conns: arch.connections.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [arch, hidden]);

  useEffect(() => {
    if (drill) return;
    let cancelled = false;
    componentLayout(visible.comps, visible.conns, dir).then((laid) => {
      if (cancelled) return;
      setNodes(laid);
      setEdges(visible.conns.map(edgeFor));
      requestAnimationFrame(() => rf.fitView({ padding: 0.08, duration: 300, maxZoom: 1.1 }));
    });
    return () => {
      cancelled = true;
    };
  }, [visible, dir, drill, rf]);

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
      const laid = await flatLayout(ns, es, dir, (n) => ({ w: Math.min(240, 18 + (n.data as FileData).label.length * 7), h: 28 }));
      if (cancelled) return;
      setNodes(laid);
      setEdges(g.edges.map((e, i) => ({ id: `f${i}`, source: e.from, target: e.to, data: { line: e.line }, style: { stroke: 'var(--edge-calls)', strokeWidth: 1.2 }, markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-calls)' } })));
      requestAnimationFrame(() => rf.fitView({ padding: 0.12, duration: 300 }));
    });
    return () => {
      cancelled = true;
    };
  }, [drill, dir, repo.id, rf]);

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
  const highlight = ans?.answer && sel?.kind === 'answer' ? ans.answer.highlight : null;
  const tour = ans?.answer?.tour ?? [];
  const stop = tourIdx !== null ? tour[tourIdx] : null;

  // Pan/zoom to each tour stop.
  useEffect(() => {
    if (!stop) return;
    const conn = stop.connectionId ? arch.connections.find((c) => c.id === stop.connectionId) : undefined;
    const ids = conn ? [conn.from, conn.to] : stop.componentId ? [stop.componentId] : [];
    if (ids.length) rf.fitView({ nodes: ids.map((id) => ({ id })), duration: 500, padding: 0.8, maxZoom: 1.3 });
  }, [stop, arch, rf]);

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
      n.type !== 'comp'
        ? n
        : {
            ...n,
            selected: n.id === selectedId,
            data: { ...n.data, selected: n.id === selectedId || (stop?.connectionId ? false : false), dim: neighbors.size > 0 && !neighbors.has(n.id), lit: Boolean(highlight?.componentIds.includes(n.id)) },
          },
    );
  }, [nodes, edges, selectedId, selectedEdge, drill, highlight, stop]);
  const displayEdges = useMemo(() => {
    if (drill) return edges;
    return edges.map((e) => {
      const base = (e.data as { baseOpacity?: number })?.baseOpacity ?? 1;
      const inAnswer = highlight?.connectionIds.includes(e.id);
      const active = selectedEdge ? e.id === selectedEdge : highlight ? inAnswer : selectedId ? e.source === selectedId || e.target === selectedId : true;
      return { ...e, animated: e.animated || Boolean(inAnswer), selected: e.id === selectedEdge, style: { ...e.style, opacity: active ? base : 0.12, strokeWidth: e.id === selectedEdge ? 3.2 : inAnswer ? 2.8 : 1.8 } };
    });
  }, [edges, selectedId, selectedEdge, drill, highlight]);

  const onNodeClick = useCallback(
    (_: unknown, n: Node) => {
      if (n.type === 'group') return;
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
  const comp = sel?.kind === 'component' ? arch.components.find((c) => c.id === sel.id) : undefined;
  const conn = sel?.kind === 'connection' ? arch.connections.find((c) => c.id === sel.id) : undefined;
  const suggested = flows.slice(0, 3).map((f) => `What happens in "${f.title}"?`);

  return (
    <>
      <div className="diagram-wrap">
        <div className="diagram-toolbar">
          {drill ? (
            <div className="card">
              <button className="btn sm ghost" onClick={() => setDrill(null)}>← All components</button>
              <span className="small" style={{ padding: '0 8px' }}>
                Files in <b>{drill.name}</b>. Click a file to read it, or an edge to see the import.
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
              <form
                className="card ask-diagram"
                onSubmit={(e) => {
                  e.preventDefault();
                  askDiagram(q);
                }}
              >
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask the diagram, e.g. what happens on login?" aria-label="Ask the diagram" list="diagram-suggestions" />
                <datalist id="diagram-suggestions">{suggested.map((s) => <option key={s} value={s} />)}</datalist>
                <button className="btn sm primary" disabled={!q.trim() || ans?.running}>Show me</button>
              </form>
            </>
          )}
          <div className="card">
            <button className="btn sm ghost" onClick={() => setDir((d) => (d === 'RIGHT' ? 'DOWN' : 'RIGHT'))} title="Toggle layout direction">
              {dir === 'RIGHT' ? '⇢ Horizontal' : '⇣ Vertical'}
            </button>
          </div>
        </div>
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={(_, n) => {
            if (!drill && n.type === 'comp') {
              const c = arch.components.find((x) => x.id === n.id);
              if (c?.paths.length) setDrill(c);
            }
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
            <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--edge-calls)" strokeWidth="2" strokeDasharray="2 3" opacity="0.6" /></svg>not verified</span>
            <span className="muted">Click a box or arrow for details. Double-click a box for its files.</span>
          </div>
        )}
      </div>
      {!drill && sel?.kind === 'overview' && <OverviewPanel arch={arch} flows={flows} onClose={() => setSel(null)} onSelect={(id) => setSel({ kind: 'component', id })} onOpenFlow={onOpenFlow} onAsk={(question) => { setQ(question); askDiagram(question); }} />}
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
                            <b>{t.componentId ? arch.components.find((c) => c.id === t.componentId)?.name : (() => { const e = arch.connections.find((c) => c.id === t.connectionId); return e ? `${arch.components.find((c) => c.id === e.from)?.name} → ${arch.components.find((c) => c.id === e.to)?.name}` : ''; })()}</b>
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
        <ComponentPanel comp={comp} arch={arch} flows={flows} onClose={() => setSel(null)} onSelectConnection={(id) => setSel({ kind: 'connection', id })} onDrill={() => setDrill(comp)} onOpenFlow={onOpenFlow} />
      )}
      {!drill && conn && <ConnectionPanel conn={conn} arch={arch} onClose={() => setSel(null)} onSelectComponent={(id) => setSel({ kind: 'component', id })} />}
    </>
  );
}

export function ArchDiagram() {
  const { repo } = useRepo();
  const [arch, setArch] = useState<Architecture | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'components' | 'flows'>('components');
  const [flowId, setFlowId] = useState<string | null>(null);

  const loadFlows = useCallback(() => api<Flow[]>(`/repos/${repo.id}/flows`).then(setFlows).catch(() => undefined), [repo.id]);
  useEffect(() => {
    api<Architecture>(`/repos/${repo.id}/architecture`).then(setArch, (e) => setError(e.message));
    loadFlows();
  }, [repo.id, repo.updatedAt, repo.status, loadFlows]);

  if (error) return <div className="empty">{error}</div>;
  if (!arch) return <div className="empty"><span className="spinner" /></div>;
  if (!arch.components.length) return <div className="empty">No architecture yet. Run the analysis first.</div>;
  const openFlow = (id: string) => {
    setFlowId(id);
    setView('flows');
  };
  return (
    <div className="arch-shell">
      <div className="arch-top">
        <div className="seg">
          <button className={view === 'components' ? 'active' : ''} onClick={() => setView('components')}>◇ Components</button>
          <button className={view === 'flows' ? 'active' : ''} onClick={() => setView('flows')}>⇄ Flows{flows.length ? ` (${flows.length})` : ''}</button>
        </div>
        <span className="muted small">
          {view === 'components' ? `${arch.components.length} components · ${arch.connections.length} connections` : 'Sequence diagrams of key runtime paths. Click a step to see its code.'}
        </span>
      </div>
      <div className="arch-body">
      {view === 'components' ? (
        <ReactFlowProvider>
          <Diagram arch={arch} flows={flows} onOpenFlow={openFlow} />
        </ReactFlowProvider>
      ) : (
        <FlowsView arch={arch} flows={flows} selectedId={flowId} onSelect={setFlowId} onChanged={loadFlows} />
      )}
      </div>
    </div>
  );
}
