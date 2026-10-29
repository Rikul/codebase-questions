import { useEffect, useState } from 'react';
import type { Architecture, Component, Connection } from '@cq/shared';
import { api } from '../lib/api';
import { langFromPath, TYPE_COLORS } from '../lib/format';
import { useRepo } from '../lib/repoContext';
import { CodeViewer } from './CodeViewer';
import { Markdown } from './Markdown';

function PanelShell({ title, kicker, color, onClose, children }: { title: React.ReactNode; kicker: React.ReactNode; color?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <aside className="panel">
      <div className="panel-head">
        <div className="grow">
          <div className="small" style={{ color: color ?? 'var(--text-3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 11 }}>{kicker}</div>
          <h3 style={{ fontSize: 17, marginTop: 2 }}>{title}</h3>
        </div>
        <button className="btn sm ghost" onClick={onClose} aria-label="Close panel">✕</button>
      </div>
      <div className="panel-body">{children}</div>
    </aside>
  );
}

export function OverviewPanel({ arch, onClose, onSelect }: { arch: Architecture; onClose: () => void; onSelect: (id: string) => void }) {
  const { askAbout } = useRepo();
  return (
    <PanelShell kicker="Architecture" title="System overview" onClose={onClose}>
      <Markdown>{arch.overview || '_No overview available._'}</Markdown>
      <section>
        <h4>Components ({arch.components.length})</h4>
        <div className="link-list">
          {arch.components.map((c) => (
            <button key={c.id} className="link-row" onClick={() => onSelect(c.id)}>
              <i style={{ width: 9, height: 9, borderRadius: 3, background: TYPE_COLORS[c.type] }} />
              <span className="grow">{c.name}</span>
              <span className="muted small">{c.type}</span>
            </button>
          ))}
        </div>
      </section>
      <button className="btn primary" onClick={() => askAbout({ category: 'architecture', question: 'Walk me through how a typical request flows through these components.', autoSend: true })}>
        Ask: trace a request end to end
      </button>
    </PanelShell>
  );
}

export function ComponentPanel({
  comp,
  arch,
  onClose,
  onSelectConnection,
  onDrill,
}: {
  comp: Component;
  arch: Architecture;
  onClose: () => void;
  onSelectConnection: (id: string) => void;
  onSelectComponent: (id: string) => void;
  onDrill: () => void;
}) {
  const { repo, askAbout, openCode } = useRepo();
  const [files, setFiles] = useState<{ path: string; summary: string | null; lines: number }[] | null>(null);
  useEffect(() => {
    setFiles(null);
    api<{ files: any[] }>(`/repos/${repo.id}/components/${encodeURIComponent(comp.id)}`).then((r) => setFiles(r.files), () => setFiles([]));
  }, [repo.id, comp.id]);
  const name = (id: string) => arch.components.find((c) => c.id === id)?.name ?? id;
  const outgoing = arch.connections.filter((e) => e.from === comp.id);
  const incoming = arch.connections.filter((e) => e.to === comp.id);
  const focus = { componentId: comp.id, label: comp.name };
  return (
    <PanelShell kicker={comp.type} color={TYPE_COLORS[comp.type]} title={comp.name} onClose={onClose}>
      <div className="md">{comp.description}</div>
      {comp.paths.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {comp.paths.map((p) => <code key={p}>{p}/</code>)}
        </div>
      )}
      {comp.responsibilities.length > 0 && (
        <section>
          <h4>Responsibilities</h4>
          <ul>{comp.responsibilities.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </section>
      )}
      <section>
        <h4>Ask about {comp.name}</h4>
        <div className="suggest">
          <button onClick={() => askAbout({ focus, category: 'architecture', question: `What is ${comp.name} responsible for and how does it interact with the rest of the system?`, autoSend: true })}>How does it fit in?</button>
          <button onClick={() => askAbout({ focus, category: 'onboarding', question: `Where should I start reading to understand ${comp.name}?`, autoSend: true })}>Where do I start reading?</button>
          <button onClick={() => askAbout({ focus, category: 'security', question: `What are the security risks in ${comp.name}?`, autoSend: true })}>Security risks</button>
          <button onClick={() => askAbout({ focus, category: 'api', question: `What interfaces does ${comp.name} expose and how do I use them?`, autoSend: true })}>How do I use its API?</button>
          <button onClick={() => askAbout({ focus })}>Ask my own…</button>
        </div>
      </section>
      {(outgoing.length > 0 || incoming.length > 0) && (
        <section>
          <h4>Connections</h4>
          <div className="link-list">
            {outgoing.map((e) => (
              <button key={e.id} className="link-row" onClick={() => onSelectConnection(e.id)}>
                <span className="arrow">→</span>
                <span className="grow"><b>{name(e.to)}</b> <span className="muted">· {e.label}</span></span>
                <span className="chip">{e.kind}</span>
              </button>
            ))}
            {incoming.map((e) => (
              <button key={e.id} className="link-row" onClick={() => onSelectConnection(e.id)}>
                <span className="arrow">←</span>
                <span className="grow"><b>{name(e.from)}</b> <span className="muted">· {e.label}</span></span>
                <span className="chip">{e.kind}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {comp.paths.length > 0 && (
        <section>
          <div className="row" style={{ marginBottom: 6 }}>
            <h4 className="grow" style={{ margin: 0 }}>Files {files ? `(${files.length})` : ''}</h4>
            <button className="btn sm" onClick={onDrill}>File graph →</button>
          </div>
          {!files && <span className="spinner" />}
          <div className="link-list">
            {files?.slice(0, 60).map((f) => (
              <button key={f.path} className="link-row" onClick={() => openCode(f.path)} title={f.summary ?? ''}>
                <span className="grow" style={{ fontFamily: 'var(--mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.path}</span>
                <span className="muted small">{f.lines}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {incoming.length + outgoing.length === 0 && <div className="muted small">No connections detected for this component.</div>}
    </PanelShell>
  );
}

interface Snip {
  path: string;
  startLine: number;
  endLine: number;
  highlightStart: number | null;
  highlightEnd: number | null;
  code: string;
  note: string | null;
}

export function ConnectionPanel({ conn, arch, onClose, onSelectComponent }: { conn: Connection; arch: Architecture; onClose: () => void; onSelectComponent: (id: string) => void }) {
  const { repo, askAbout, openCode } = useRepo();
  const [snips, setSnips] = useState<Snip[] | null>(null);
  useEffect(() => {
    setSnips(null);
    api<{ snippets: Snip[] }>(`/repos/${repo.id}/connections/${encodeURIComponent(conn.id)}`).then((r) => setSnips(r.snippets), () => setSnips([]));
  }, [repo.id, conn.id]);
  const from = arch.components.find((c) => c.id === conn.from);
  const to = arch.components.find((c) => c.id === conn.to);
  const label = `${from?.name ?? conn.from} → ${to?.name ?? conn.to}`;
  return (
    <PanelShell kicker={`${conn.kind} connection`} title={label} onClose={onClose}>
      <div className="row">
        <button className="btn sm" onClick={() => onSelectComponent(conn.from)}>{from?.name}</button>
        <span className="muted">→ {conn.label} →</span>
        <button className="btn sm" onClick={() => onSelectComponent(conn.to)}>{to?.name}</button>
      </div>
      <Markdown>{conn.description}</Markdown>
      <section>
        <h4>Ask about this interaction</h4>
        <div className="suggest">
          <button onClick={() => askAbout({ focus: { connectionId: conn.id, label }, category: 'architecture', question: `How exactly does ${from?.name} talk to ${to?.name}? Walk through the call path.`, autoSend: true })}>Walk through the call path</button>
          <button onClick={() => askAbout({ focus: { connectionId: conn.id, label }, category: 'api', question: `What data is passed between ${from?.name} and ${to?.name}, and how are errors handled?`, autoSend: true })}>Data & error handling</button>
          <button onClick={() => askAbout({ focus: { connectionId: conn.id, label }, category: 'security', question: `Is the boundary between ${from?.name} and ${to?.name} a trust boundary? What could go wrong?`, autoSend: true })}>Trust boundary?</button>
        </div>
      </section>
      <section>
        <h4>Evidence in code</h4>
        {!snips && <span className="spinner" />}
        {snips?.length === 0 && <div className="muted small">No code evidence recorded.</div>}
        <div style={{ display: 'grid', gap: 10 }}>
          {snips?.map((s, i) => (
            <CodeViewer
              key={i}
              code={s.code}
              lang={langFromPath(s.path)}
              firstLine={s.startLine}
              highlightStart={s.highlightStart}
              highlightEnd={s.highlightEnd}
              title={<>{s.path}{s.highlightStart ? `:${s.highlightStart}` : ''}{s.note ? <span className="muted"> · {s.note}</span> : null}</>}
              actions={<button className="btn sm ghost" onClick={() => openCode(s.path, s.highlightStart ?? undefined, s.highlightEnd ?? undefined)}>Open</button>}
            />
          ))}
        </div>
      </section>
    </PanelShell>
  );
}
