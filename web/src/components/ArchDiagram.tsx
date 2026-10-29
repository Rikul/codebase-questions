import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
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
import type { Architecture, Component, ComponentType, Connection } from '@cq/shared';
import { api } from '../lib/api';
import { KIND_STYLE, TYPE_COLORS, TYPE_HEX } from '../lib/format';
import { useRepo } from '../lib/repoContext';
import { ComponentPanel, ConnectionPanel, OverviewPanel } from './ArchPanels';

const elk = new ELK();
type Dir = 'RIGHT' | 'DOWN';

type CompData = { comp: Component; dir: Dir; dim: boolean; selected: boolean; fileCount?: number };
type FileData = { label: string; path: string; external: boolean; dir: Dir; summary?: string };

const CompNode = memo(({ data }: NodeProps<Node<CompData>>) => {
  const { comp, dir, dim, selected } = data;
  const [tp, sp] = dir === 'RIGHT' ? [Position.Left, Position.Right] : [Position.Top, Position.Bottom];
  return (
    <div
      className={`comp-node ${comp.type} ${dim ? 'dim' : ''} ${selected ? 'selected' : ''}`}
      style={{ ['--node-color' as string]: TYPE_COLORS[comp.type] ?? TYPE_COLORS.other }}
      title={comp.description}
    >
      <Handle type="target" position={tp} />
      <div className="t">{comp.type}</div>
      <div className="n">{comp.name}</div>
      <div className="d">{comp.paths.length ? comp.paths.join(', ') : comp.description}</div>
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

const nodeTypes = { comp: CompNode, file: FileNodeView };

async function layout<T extends Record<string, unknown>>(nodes: Node<T>[], edges: { id: string; source: string; target: string }[], dir: Dir, size: (n: Node<T>) => { w: number; h: number }) {
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir,
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.nodeNode': '40',
      'elk.spacing.edgeLabel': '6',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.edgeRouting': 'SPLINES',
    },
    children: nodes.map((n) => ({ id: n.id, width: size(n).w, height: size(n).h })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const res = await elk.layout(graph);
  const pos = new Map(res.children?.map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
  return nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? { x: 0, y: 0 } }));
}

type Selection = { kind: 'component'; id: string } | { kind: 'connection'; id: string } | { kind: 'overview' } | null;

function Diagram() {
  const { repo, openCode } = useRepo();
  const rf = useReactFlow();
  const [arch, setArch] = useState<Architecture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState<Dir>('RIGHT');
  const [sel, setSel] = useState<Selection>({ kind: 'overview' });
  const [hidden, setHidden] = useState<Set<ComponentType>>(new Set(['test']));
  const [drill, setDrill] = useState<Component | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    api<Architecture>(`/repos/${repo.id}/architecture`).then(setArch, (e) => setError(e.message));
  }, [repo.id, repo.updatedAt]);

  const visible = useMemo(() => {
    if (!arch) return null;
    const comps = arch.components.filter((c) => !hidden.has(c.type));
    const ids = new Set(comps.map((c) => c.id));
    return { comps, conns: arch.connections.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [arch, hidden]);

  // Component-level layout.
  useEffect(() => {
    if (!visible || drill) return;
    const base: Node<CompData>[] = visible.comps.map((c) => ({ id: c.id, type: 'comp', position: { x: 0, y: 0 }, data: { comp: c, dir, dim: false, selected: false } }));
    const es = visible.conns.map((e) => ({ id: e.id, source: e.from, target: e.to }));
    let cancelled = false;
    layout(base, es, dir, () => ({ w: 220, h: 92 })).then((laid) => {
      if (cancelled) return;
      setNodes(laid);
      setEdges(
        visible.conns.map((e) => {
          const st = KIND_STYLE[e.kind] ?? KIND_STYLE.other;
          return {
            id: e.id,
            source: e.from,
            target: e.to,
            label: e.label,
            data: { conn: e },
            animated: e.kind === 'queue' || e.kind === 'event',
            style: { stroke: st.color, strokeWidth: 1.8, strokeDasharray: st.dash },
            markerEnd: { type: MarkerType.ArrowClosed, color: st.color, width: 18, height: 18 },
            labelBgPadding: [6, 3] as [number, number],
            labelBgBorderRadius: 4,
            interactionWidth: 24,
          };
        }),
      );
      requestAnimationFrame(() => rf.fitView({ padding: 0.15, duration: 300 }));
    });
    return () => {
      cancelled = true;
    };
  }, [visible, dir, drill, rf]);

  // File-level drill-down.
  useEffect(() => {
    if (!drill) return;
    let cancelled = false;
    api<{ nodes: { path: string; summary: string | null; external: boolean; component: string | null }[]; edges: { from: string; to: string; line: number }[] }>(
      `/repos/${repo.id}/graph?scope=${encodeURIComponent(drill.id)}`,
    ).then(async (g) => {
      const label = (p: string) => {
        const pre = drill.paths.find((x) => p.startsWith(x + '/'));
        return pre ? p.slice(pre.length + 1) : p;
      };
      const ns: Node<FileData>[] = g.nodes.map((n) => ({ id: n.path, type: 'file', position: { x: 0, y: 0 }, data: { label: label(n.path), path: n.path, external: n.external, dir, summary: n.summary ?? undefined } }));
      const es = g.edges.map((e, i) => ({ id: `f${i}`, source: e.from, target: e.to }));
      const laid = await layout(ns, es, dir, (n) => ({ w: Math.min(240, 18 + (n.data as FileData).label.length * 7), h: 28 }));
      if (cancelled) return;
      setNodes(laid);
      setEdges(
        g.edges.map((e, i) => ({
          id: `f${i}`,
          source: e.from,
          target: e.to,
          data: { line: e.line },
          style: { stroke: 'var(--edge-calls)', strokeWidth: 1.2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-calls)' },
        })),
      );
      requestAnimationFrame(() => rf.fitView({ padding: 0.12, duration: 300 }));
    });
    return () => {
      cancelled = true;
    };
  }, [drill, dir, repo.id, rf]);

  // Neighbor highlighting for the selected component.
  const selectedId = sel?.kind === 'component' ? sel.id : null;
  const selectedEdge = sel?.kind === 'connection' ? sel.id : null;
  const displayNodes = useMemo(() => {
    if (drill) return nodes;
    const neighbors = new Set<string>();
    if (selectedId) {
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
    return nodes.map((n) => ({
      ...n,
      selected: n.id === selectedId,
      data: { ...n.data, selected: n.id === selectedId, dim: neighbors.size > 0 && !neighbors.has(n.id) },
    }));
  }, [nodes, edges, selectedId, selectedEdge, drill]);
  const displayEdges = useMemo(() => {
    if (drill) return edges;
    return edges.map((e) => {
      const active = selectedEdge ? e.id === selectedEdge : selectedId ? e.source === selectedId || e.target === selectedId : true;
      return { ...e, selected: e.id === selectedEdge, style: { ...e.style, opacity: active ? 1 : 0.15, strokeWidth: e.id === selectedEdge ? 3 : 1.8 } };
    });
  }, [edges, selectedId, selectedEdge, drill]);

  const onNodeClick = useCallback(
    (_: unknown, n: Node) => {
      if (drill) {
        const d = n.data as FileData;
        openCode(d.path);
      } else setSel({ kind: 'component', id: n.id });
    },
    [drill, openCode],
  );
  const onEdgeClick = useCallback(
    (_: unknown, e: Edge) => {
      if (drill) {
        const line = (e.data as { line?: number })?.line;
        openCode(e.source, line ?? undefined, line ?? undefined);
      } else setSel({ kind: 'connection', id: e.id });
    },
    [drill, openCode],
  );

  if (error) return <div className="empty">{error}</div>;
  if (!arch) return <div className="empty"><span className="spinner" /></div>;
  if (!arch.components.length) return <div className="empty">No architecture yet. Run the analysis first.</div>;

  const types = [...new Set(arch.components.map((c) => c.type))];
  const comp = sel?.kind === 'component' ? arch.components.find((c) => c.id === sel.id) : undefined;
  const conn: Connection | undefined = sel?.kind === 'connection' ? arch.connections.find((c) => c.id === sel.id) : undefined;

  return (
    <>
      <div className="diagram-wrap">
        <div className="diagram-toolbar">
          {drill ? (
            <div className="card">
              <button className="btn sm ghost" onClick={() => setDrill(null)}>← All components</button>
              <span className="small" style={{ padding: '0 8px' }}>
                Files in <b>{drill.name}</b> · click a file to read it, an edge to see the import
              </span>
            </div>
          ) : (
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
            if (!drill) {
              const c = arch.components.find((x) => x.id === n.id);
              if (c?.paths.length) setDrill(c);
            }
          }}
          onEdgeClick={onEdgeClick}
          onPaneClick={() => !drill && setSel(null)}
          nodesConnectable={false}
          minZoom={0.15}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="var(--border)" />
          <Controls showInteractive={false} />
          {nodes.length >= 8 && <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'comp' ? TYPE_HEX[(n.data as CompData).comp.type] : '#8a90a2')} />}
        </ReactFlow>
        {!drill && (
          <div className="legend card">
            {Object.entries({ calls: 'in-process call', http: 'network / HTTP', db: 'database', queue: 'queue / event' }).map(([k, label]) => {
              const st = KIND_STYLE[k as keyof typeof KIND_STYLE];
              return (
                <span key={k}>
                  <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke={st.color} strokeWidth="2" strokeDasharray={st.dash} /></svg>
                  {label}
                </span>
              );
            })}
            <span className="muted">Click a box or arrow for details · double-click a box for its files</span>
          </div>
        )}
      </div>
      {!drill && sel?.kind === 'overview' && <OverviewPanel arch={arch} onClose={() => setSel(null)} onSelect={(id) => setSel({ kind: 'component', id })} />}
      {!drill && comp && (
        <ComponentPanel
          comp={comp}
          arch={arch}
          onClose={() => setSel(null)}
          onSelectConnection={(id) => setSel({ kind: 'connection', id })}
          onSelectComponent={(id) => setSel({ kind: 'component', id })}
          onDrill={() => setDrill(comp)}
        />
      )}
      {!drill && conn && <ConnectionPanel conn={conn} arch={arch} onClose={() => setSel(null)} onSelectComponent={(id) => setSel({ kind: 'component', id })} />}
    </>
  );
}

export function ArchDiagram() {
  return (
    <ReactFlowProvider>
      <Diagram />
    </ReactFlowProvider>
  );
}
