import { useEffect, useState } from 'react';
import type { AgentStep, Architecture, Flow, FlowEvent } from '@cq/shared';
import { api, streamPost } from '../lib/api';
import { useRepo } from '../lib/repoContext';
import { AgentTrace, upsertStep } from './AgentTrace';
import { Markdown } from './Markdown';
import { SequenceDiagram } from './SequenceDiagram';

export function FlowsView({ arch, flows, selectedId, onSelect, onChanged }: { arch: Architecture; flows: Flow[]; selectedId: string | null; onSelect: (id: string) => void; onChanged: () => void }) {
  const { repo, openCode, askAbout } = useRepo();
  const [step, setStep] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [tracing, setTracing] = useState<{ steps: AgentStep[]; running: boolean; error: string | null } | null>(null);
  const flow = flows.find((f) => f.id === selectedId) ?? flows[0];

  useEffect(() => setStep(null), [flow?.id]);

  const trace = (question: string) => {
    setTracing({ steps: [], running: true, error: null });
    streamPost<FlowEvent>(`/repos/${repo.id}/flows`, { question }, (e) => {
      if (e.type === 'step') setTracing((t) => t && { ...t, steps: upsertStep(t.steps, e.step) });
      else if (e.type === 'result') {
        onChanged();
        onSelect(e.flow.id);
        setQ('');
      } else if (e.type === 'error') setTracing((t) => t && { ...t, error: e.message });
    })
      .catch((err) => setTracing((t) => t && { ...t, error: (err as Error).message }))
      .finally(() => setTracing((t) => t && { ...t, running: false }));
  };

  const s = flow && step !== null ? flow.steps[step] : null;
  return (
    <div className="flows">
      <nav className="flow-list">
        <form
          className="trace-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) trace(q);
          }}
        >
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Trace a flow, e.g. user signup" aria-label="Trace a new flow" />
          <button className="btn sm primary" disabled={!q.trim() || tracing?.running}>Trace</button>
        </form>
        {tracing && (tracing.running || tracing.error) && (
          <div style={{ padding: '0 4px' }}>
            <AgentTrace steps={tracing.steps} running={tracing.running} defaultOpen />
            {tracing.error && <div className="error-box small">{tracing.error}</div>}
          </div>
        )}
        {flows.map((f) => (
          <button key={f.id} className={`flow-item ${flow?.id === f.id ? 'active' : ''}`} onClick={() => onSelect(f.id)}>
            <b>{f.title}</b>
            <span className="muted small">{f.trigger} · {f.steps.length} steps</span>
          </button>
        ))}
        {!flows.length && <div className="muted small" style={{ padding: 10 }}>No flows yet. Describe one above to trace it.</div>}
      </nav>
      {flow ? (
        <div className="flow-main">
          <div className="flow-head">
            <div className="grow">
              <h2 style={{ fontSize: 18 }}>{flow.title}</h2>
              <div className="muted small">Trigger: {flow.trigger}</div>
            </div>
            <button className="btn sm" onClick={() => askAbout({ category: 'architecture', question: `Walk me through the flow "${flow.title}" in detail, including error handling.`, autoSend: true })}>Ask about this flow</button>
            <button
              className="btn sm ghost danger"
              onClick={async () => {
                await api(`/repos/${repo.id}/flows/${encodeURIComponent(flow.id)}`, { method: 'DELETE' });
                onChanged();
              }}
            >
              Remove
            </button>
          </div>
          <Markdown>{flow.summary}</Markdown>
          <div className="seq-wrap card">
            <SequenceDiagram flow={flow} arch={arch} activeStep={step} onStep={(i) => {
              setStep(i);
              const st = flow.steps[i];
              if (st.ref) openCode(st.ref.path, st.ref.startLine, st.ref.endLine);
            }} />
          </div>
          <ol className="step-list">
            {flow.steps.map((st, i) => (
              <li key={i} className={step === i ? 'active' : ''} onClick={() => setStep(i)}>
                <span className="grow">
                  <b>{flow.participants.find((p) => p.id === st.from)?.label}</b> → <b>{flow.participants.find((p) => p.id === st.to)?.label}</b>: <code>{st.label}</code>
                  {st.note && <div className="muted small">{st.note}</div>}
                </span>
                {st.ref && (
                  <button className="cite" onClick={(e) => { e.stopPropagation(); openCode(st.ref!.path, st.ref!.startLine, st.ref!.endLine); }}>
                    {st.ref.path.split('/').pop()}:{st.ref.startLine}
                  </button>
                )}
              </li>
            ))}
          </ol>
          {s && <div className="muted small">Step {step! + 1}: {s.kind}</div>}
        </div>
      ) : (
        <div className="empty grow">No flows traced yet.</div>
      )}
    </div>
  );
}
