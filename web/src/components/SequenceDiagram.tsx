import type { Architecture, Flow } from '@cq/shared';
import { TYPE_HEX } from '../lib/format';

const COL = 180;
const ROW = 48;
const TOP = 70;
const KIND_COLOR: Record<string, string> = { call: '#5b5bd6', return: '#8a90a2', async: '#e0569b', event: '#e0569b', db: '#e39a12', http: '#7c6cf0' };

/** Clickable SVG sequence diagram: lifelines per participant, one arrow per step. */
export function SequenceDiagram({
  flow,
  arch,
  activeStep,
  onStep,
}: {
  flow: Flow;
  arch: Architecture;
  activeStep: number | null;
  onStep: (i: number) => void;
}) {
  const idx = new Map(flow.participants.map((p, i) => [p.id, i]));
  const x = (id: string) => 90 + (idx.get(id) ?? 0) * COL;
  const width = 90 + flow.participants.length * COL;
  const height = TOP + flow.steps.length * ROW + 40;
  return (
    <svg className="seq" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={flow.title}>
      <defs>
        {Object.entries(KIND_COLOR).map(([k, c]) => (
          <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={c} />
          </marker>
        ))}
      </defs>
      {flow.participants.map((p) => {
        const comp = p.componentId ? arch.components.find((c) => c.id === p.componentId) : undefined;
        const color = comp ? TYPE_HEX[comp.type] : '#8a90a2';
        const cx = x(p.id);
        return (
          <g key={p.id}>
            <line x1={cx} y1={TOP - 14} x2={cx} y2={height - 10} className="lifeline" />
            <rect x={cx - 76} y={10} width={152} height={42} rx={8} className="seq-actor" style={{ stroke: color }} />
            <rect x={cx - 76} y={10} width={152} height={4} rx={2} fill={color} />
            <text x={cx} y={37} textAnchor="middle" className="seq-actor-label">
              {p.label.length > 20 ? p.label.slice(0, 19) + '…' : p.label}
            </text>
            <title>{comp ? `${comp.name} (${comp.type}): ${comp.description}` : p.label}</title>
          </g>
        );
      })}
      {flow.steps.map((s, i) => {
        const y = TOP + i * ROW + 24;
        const x1 = x(s.from);
        const x2 = x(s.to);
        const color = KIND_COLOR[s.kind] ?? KIND_COLOR.call;
        const dashed = s.kind === 'return' || s.kind === 'async' || s.kind === 'event';
        const self = s.from === s.to;
        const label = s.label.length > 34 ? s.label.slice(0, 33) + '…' : s.label;
        const active = activeStep === i;
        return (
          <g key={i} className={`seq-step ${active ? 'active' : ''}`} onClick={() => onStep(i)}>
            <rect x={4} y={y - 30} width={width - 8} height={ROW - 4} className="seq-hit" rx={6} />
            <text x={20} y={y + 4} className="seq-num">{i + 1}</text>
            {self ? (
              <path d={`M${x1},${y - 8} h40 v16 h-38`} fill="none" stroke={color} strokeWidth={active ? 2.6 : 1.6} strokeDasharray={dashed ? '6 4' : undefined} markerEnd={`url(#arrow-${s.kind})`} />
            ) : (
              <line x1={x1} y1={y} x2={x2 + (x2 > x1 ? -4 : 4)} y2={y} stroke={color} strokeWidth={active ? 2.6 : 1.6} strokeDasharray={dashed ? '6 4' : undefined} markerEnd={`url(#arrow-${s.kind})`} />
            )}
            <text x={self ? x1 + 46 : (x1 + x2) / 2} y={self ? y - 12 : y - 7} textAnchor={self ? 'start' : 'middle'} className="seq-label">
              {label}
            </text>
            <title>{`${s.label}${s.note ? ` — ${s.note}` : ''}${s.ref ? `\n${s.ref.path}:${s.ref.startLine ?? ''}` : ''}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
