import { useState } from 'react';
import type { AgentStep } from '@cq/shared';

const ICON: Record<string, string> = {
  read_file: '📄', list_dir: '📁', search_code: '🔎', grep: '⌕', file_info: 'ℹ', list_symbols: '☰', find_definition: '⌖',
  find_references: '⇠', symbol_calls: '⇢', importer_chain: '⛓', get_architecture: '◇', get_insights: '✎', fallback: '⚠',
};

/** Upsert a step into a list (steps arrive as running, then done/error). */
export function upsertStep(steps: AgentStep[], s: AgentStep): AgentStep[] {
  const i = steps.findIndex((x) => x.id === s.id);
  if (i < 0) return [...steps, s];
  const next = steps.slice();
  next[i] = s;
  return next;
}

/** Live list of the tool calls an agent made while investigating. */
export function AgentTrace({ steps, running, notes, defaultOpen }: { steps: AgentStep[]; running: boolean; notes?: string[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  if (!steps.length && !running) return null;
  const shown = open || running ? steps : [];
  return (
    <div className="trace">
      <button className="trace-head" onClick={() => setOpen((o) => !o)}>
        {running ? <span className="spinner" /> : <span className="muted">{open ? '▾' : '▸'}</span>}
        <span>{running ? 'Investigating the code…' : `Investigated with ${steps.length} step${steps.length === 1 ? '' : 's'}`}</span>
      </button>
      {shown.length > 0 && (
        <ol className="trace-list">
          {notes?.map((n, i) => <li key={`n${i}`} className="trace-note">{n}</li>)}
          {shown.map((s) => (
            <li key={s.id} className={`trace-step ${s.status}`} title={s.summary}>
              <span className="ti">{s.status === 'running' ? <span className="spinner" /> : ICON[s.tool] ?? '•'}</span>
              <span className="grow">{s.label}</span>
              {s.status !== 'running' && s.summary && <span className="muted small ts">{s.summary}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
