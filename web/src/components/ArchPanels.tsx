import { useEffect, useState } from 'react';
import type { Architecture, Component, Connection, Flow } from '@cq/shared';
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

function FlowLinks({ flows, onOpenFlow }: { flows: Flow[]; onOpenFlow: (id: string) => void }) {
  if (!flows.length) return null;
  return (
    <section>
      <h4>Flows ({flows.length})</h4>
      <div className="link-list">
        {flows.map((f) => (
          <button key={f.id} className="link-row" onClick={() => onOpenFlow(f.id)}>
            <span className="arrow">⇄</span>
            <span className="grow">{f.title}<div className="muted small">{f.trigger}</div></span>
            <span className="muted small">{f.steps.length} steps</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function OverviewPanel({
  arch,
  flows,
  onClose,
  onSelect,
  onOpenFlow,
  onAsk,
}: {
  arch: Architecture;
  flows: Flow[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onOpenFlow: (id: string) => void;
  onAsk: (question: string) => void;
}) {
  const verified = arch.connections.filter((c) => c.confidence === 'verified').length;
  return (
    <PanelShell kicker="Architecture" title="System overview" onClose={onClose}>
      <Markdown>{arch.overview || '_No overview available._'}</Markdown>
      {arch.connections.some((c) => c.confidence) && (
        <div className="muted small">{verified} of {arch.connections.length} connections were verified against the code. Dotted arrows marked “?” are inferred.</div>
      )}
      <FlowLinks flows={flows} onOpenFlow={onOpenFlow} />
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
      <section>
        <h4>Show me on the diagram</h4>
        <div className="suggest">
          {[...flows.slice(0, 2).map((f) => `What happens in "${f.title}"?`), 'How does a request travel from entry point to storage?', 'Which components talk to external systems?'].map((q) => (
            <button key={q} onClick={() => onAsk(q)}>{q}</button>
          ))}
        </div>
      </section>
    </PanelShell>
  );
}

export function ComponentPanel({
  comp,
  arch,
  onClose,
  onSelectConnection,
  onDrill,
  flows,
  onOpenFlow,
}: {
  comp: Component;
  arch: Architecture;
  onClose: () => void;
  onSelectConnection: (id: string) => void;
  onDrill: () => void;
  flows: Flow[];
  onOpenFlow: (id: string) => void;
}) {
  const { repo, askAbout, openCode, openFile } = useRepo();
  const myFlows = flows.filter((f) => f.participants.some((p) => p.componentId === comp.id));
  const [files, setFiles] = useState<{ path: string; summary: string | null; lines: number; history?: { lastAt?: string; lastBy?: string; lastSha?: string; commits?: number } | null }[] | null>(null);
  const { openCommit } = useRepo();
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
      {(comp.layer || comp.group || comp.techStack?.length) && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {comp.layer && <span className="chip">layer: {comp.layer}</span>}
          {comp.group && <span className="chip">group: {comp.group}</span>}
          {comp.techStack?.map((t) => <span key={t} className="chip">{t}</span>)}
        </div>
      )}
      {(comp.keyFiles?.length || comp.entryPoints?.length) ? (
        <section>
          <h4>Start reading here</h4>
          <div className="link-list">
            {[...new Set([...(comp.entryPoints ?? []), ...(comp.keyFiles ?? [])])].map((p) => (
              <div key={p} className="link-row">
                <button className="grow plain-btn mono small" onClick={() => openCode(p)}>{p}{comp.entryPoints?.includes(p) ? ' · entry' : ''}</button>
                <button className="btn sm ghost" title="Explain this file" onClick={() => openFile(p)}>?</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <FlowLinks flows={myFlows} onOpenFlow={onOpenFlow} />
      {files?.some((f) => f.history) && (() => {
        const withH = files.filter((f) => f.history?.lastAt);
        const recent = [...withH].sort((a, b) => String(b.history!.lastAt).localeCompare(String(a.history!.lastAt))).slice(0, 5);
        const hot = [...withH].sort((a, b) => (b.history!.commits ?? 0) - (a.history!.commits ?? 0)).slice(0, 5);
        return (
          <section>
            <h4>History</h4>
            <div className="muted small" style={{ marginBottom: 4 }}>Recently changed</div>
            <div className="link-list">
              {recent.map((f) => (
                <div key={f.path} className="link-row">
                  <button className="grow plain-btn mono small" onClick={() => openCode(f.path)}>{f.path.split('/').slice(-2).join('/')}</button>
                  <button className="plain-btn small muted" onClick={() => f.history?.lastSha && openCommit(f.history.lastSha, f.path)}>{String(f.history!.lastAt).slice(0, 10)}</button>
                </div>
              ))}
            </div>
            <div className="muted small" style={{ margin: '8px 0 4px' }}>Hotspots (most commits)</div>
            <div className="link-list">
              {hot.map((f) => (
                <div key={f.path} className="link-row">
                  <button className="grow plain-btn mono small" onClick={() => openFile(f.path)}>{f.path.split('/').slice(-2).join('/')}</button>
                  <span className="chip">{f.history!.commits} commits</span>
                </div>
              ))}
            </div>
          </section>
        );
      })()}
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
              <div key={f.path} className="link-row" title={f.summary ?? ''}>
                <button className="grow plain-btn" style={{ fontFamily: 'var(--mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }} onClick={() => openCode(f.path)}>{f.path}</button>
                <span className="muted small">{f.lines}</span>
                <button className="btn sm ghost" title="Explain this file" onClick={() => openFile(f.path)}>?</button>
              </div>
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
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {conn.confidence && <span className={`chip ${conn.confidence === 'verified' ? 'ok' : 'warn'}`}>{conn.confidence === 'verified' ? '✓ verified in code' : '? inferred, not verified'}</span>}
        {conn.protocol && <span className="chip">{conn.protocol}</span>}
        {conn.sync && <span className="chip">{conn.sync}</span>}
        {conn.direction && conn.direction !== 'request' && <span className="chip">{conn.direction}</span>}
      </div>
      <Markdown>{conn.description}</Markdown>
      {conn.dataExchanged && (
        <section>
          <h4>Data exchanged</h4>
          <div>{conn.dataExchanged}</div>
        </section>
      )}
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
