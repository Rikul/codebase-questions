import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStep, Explanation, ExplainEvent, ExplainRequest, ExplainTarget } from '@cq/shared';
import { api, streamPost } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useRepo } from '../lib/repoContext';
import { AgentTrace, upsertStep } from './AgentTrace';
import { Markdown } from './Markdown';

export interface ExplainSubject {
  path: string;
  symbol?: { name?: string; line?: number };
  snippet?: { text: string; startLine?: number; endLine?: number };
}

const QUESTIONS = [
  { key: 'what', title: 'What is it?' },
  { key: 'howItFits', title: 'How does it fit in?' },
  { key: 'whenUsed', title: 'When is it used?' },
] as const;

function Section({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="x-section">
      <button className="x-head" onClick={() => setOpen((o) => !o)}>
        <span className="muted">{open ? '▾' : '▸'}</span>
        <h4>{title}</h4>
        {count !== undefined && <span className="chip">{count}</span>}
      </button>
      {open && <div className="x-body">{children}</div>}
    </section>
  );
}

interface HistCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  status?: string;
  added?: number | null;
  deleted?: number | null;
}
type HistoryData =
  | { available: false; reason: string }
  | {
      available: true;
      created?: (HistCommit & { uncertain: boolean }) | null;
      introduced?: (HistCommit & { uncertain: boolean; how: string }) | null;
      lastChanged: HistCommit | null;
      commitCount?: number;
      commits: HistCommit[];
      authors: { name: string; commits: number }[];
      renames?: { from: string; to: string }[];
      truncated: boolean;
    };

function HistorySection({ data, narrative, onCommit }: { data: HistoryData | null; narrative?: { created: string; evolution: string; keyCommits: { sha: string; date?: string; why: string }[] }; onCommit: (sha: string) => void }) {
  const [all, setAll] = useState(false);
  if (!data) return <div className="muted small"><span className="spinner" /> Loading history…</div>;
  if (!data.available) return <div className="muted small">{data.reason}</div>;
  const first = data.created ?? data.introduced ?? null;
  const count = data.commitCount ?? data.commits.length;
  const list = all ? data.commits : data.commits.slice(0, 8);
  return (
    <div className="history">
      <div className="hist-facts">
        {first && (
          <button className="hist-fact" onClick={() => onCommit(first.sha)} title={first.subject}>
            <span className="k">{data.introduced?.how === 'pickaxe' ? 'First appeared' : 'Created'}</span>
            <span className="v">{first.uncertain ? '≤ ' : ''}{first.date.slice(0, 10)}</span>
            <span className="s">{first.author} · <code className="plain">{first.sha.slice(0, 7)}</code></span>
          </button>
        )}
        {data.lastChanged && (
          <button className="hist-fact" onClick={() => onCommit(data.lastChanged!.sha)} title={data.lastChanged.subject}>
            <span className="k">Last changed</span>
            <span className="v">{data.lastChanged.date.slice(0, 10)}</span>
            <span className="s">{data.lastChanged.author} · {timeAgo(data.lastChanged.date)}</span>
          </button>
        )}
        <div className="hist-fact static">
          <span className="k">Commits</span>
          <span className="v">{count}</span>
          <span className="s">{data.authors.slice(0, 3).map((a) => a.name).join(', ')}{data.authors.length > 3 ? ` +${data.authors.length - 3}` : ''}</span>
        </div>
      </div>
      {first?.uncertain && <div className="muted small">History is truncated (shallow clone), so this may be older. Set HISTORY_DEPTH=0 for full history.</div>}
      {data.renames?.length ? <div className="muted small">Renamed: {data.renames.map((r) => `${r.from} → ${r.to}`).join(', ')}</div> : null}
      {narrative && (
        <>
          <Markdown>{narrative.created}</Markdown>
          <Markdown>{narrative.evolution}</Markdown>
          {narrative.keyCommits.length > 0 && (
            <div className="refs">
              {narrative.keyCommits.slice(0, 6).map((k) => (
                <button key={k.sha} className="cite" title={k.why} onClick={() => onCommit(k.sha)}>{k.sha.slice(0, 7)}</button>
              ))}
            </div>
          )}
        </>
      )}
      <ol className="timeline">
        {list.map((c) => (
          <li key={c.sha}>
            <button className="plain-btn" onClick={() => onCommit(c.sha)}>
              <span className="mono small muted">{c.date.slice(0, 10)}</span>
              <span className="grow tl-subject">{c.subject}</span>
              {c.status && c.status !== 'M' && <span className={`chip st-${c.status}`}>{c.status === 'A' ? 'added' : c.status === 'R' ? 'renamed' : c.status === 'D' ? 'deleted' : c.status}</span>}
              {(c.added != null || c.deleted != null) && <span className="small diffstat"><span className="plus">+{c.added ?? 0}</span> <span className="minus">−{c.deleted ?? 0}</span></span>}
              <span className="small muted">{c.author}</span>
            </button>
          </li>
        ))}
      </ol>
      {data.commits.length > 8 && <button className="btn sm ghost" onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${data.commits.length}`}</button>}
    </div>
  );
}

const isPkg = (p: string) => !p.includes('/') && !/\.\w{1,5}$/.test(p);

export function ExplainPanel({
  subject,
  onSubject,
  onClose,
  title,
}: {
  subject: ExplainSubject;
  /** Navigate the panel to another file/symbol (outline click, caller click). */
  onSubject: (s: ExplainSubject) => void;
  onClose?: () => void;
  title?: string;
}) {
  const { repo, openCode, askAbout, openCommit } = useRepo();
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [target, setTarget] = useState<ExplainTarget | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [narration, setNarration] = useState('');
  const [result, setResult] = useState<{ explanation: Explanation; cached: boolean; createdAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const run = useCallback(
    (refresh = false) => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setSteps([]);
      setNotes([]);
      setNarration('');
      setResult(null);
      setError(null);
      setRunning(true);
      const body: ExplainRequest = { path: subject.path, symbol: subject.symbol, snippet: subject.snippet, refresh };
      streamPost<ExplainEvent>(
        `/repos/${repo.id}/explain`,
        body,
        (e) => {
          if (e.type === 'target') setTarget(e.target);
          else if (e.type === 'step') setSteps((s) => upsertStep(s, e.step));
          else if (e.type === 'token') setNarration((n) => n + e.text);
          else if (e.type === 'reset') {
            setNotes((n) => [...n, e.text.trim()].filter(Boolean));
            setNarration('');
          } else if (e.type === 'result') setResult(e);
          else if (e.type === 'error') setError(e.message);
        },
        ctrl.signal,
      )
        .catch((err) => (err as Error).name !== 'AbortError' && setError((err as Error).message))
        .finally(() => !ctrl.signal.aborted && setRunning(false));
    },
    [repo.id, subject.path, subject.symbol?.name, subject.symbol?.line, subject.snippet?.text],
  );

  useEffect(() => {
    run(false);
    return () => abort.current?.abort();
  }, [run]);

  // Git facts load independently of (and usually faster than) the model's explanation.
  useEffect(() => {
    if (!target) return;
    setHistory(null);
    const q = new URLSearchParams({ path: target.path });
    let url = `/repos/${repo.id}/history/file`;
    if (target.kind === 'symbol') {
      url = `/repos/${repo.id}/history/symbol`;
      if (target.name) q.set('name', target.name);
      if (target.line) q.set('line', String(target.line));
    } else if (target.kind === 'snippet' && target.line) {
      url = `/repos/${repo.id}/history/symbol`;
      q.set('start', String(target.line));
      q.set('end', String(target.endLine ?? target.line));
    }
    api<HistoryData>(`${url}?${q}`).then(setHistory, (e) => setHistory({ available: false, reason: e.message }));
  }, [repo.id, target?.kind, target?.path, target?.name, target?.line, target?.endLine]);

  const x = result?.explanation;
  const heading =
    title ??
    (target?.kind === 'symbol' ? target.name : target?.kind === 'snippet' ? `Selection · lines ${target.line}-${target.endLine}` : subject.path.split('/').pop());
  const kicker = target?.kind === 'symbol' ? `${target.symbolKind ?? 'symbol'} · ${target.path}` : target?.kind === 'snippet' ? target.path : 'file';
  const focus = { path: subject.path, symbol: subject.symbol, snippet: subject.snippet, label: heading ?? subject.path };

  return (
    <aside className="panel explain">
      <div className="panel-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="small kicker">{kicker}</div>
          <h3 className="x-title" title={heading}>{heading}</h3>
        </div>
        {result && (
          <button className="btn sm ghost" onClick={() => run(true)} disabled={running} title="Re-investigate with the model">
            ↻
          </button>
        )}
        {onClose && <button className="btn sm ghost" onClick={onClose} aria-label="Close explanation">✕</button>}
      </div>
      <div className="panel-body">
        {target?.kind !== 'file' && (
          <button className="link-row" onClick={() => onSubject({ path: target?.path ?? subject.path })}>
            <span className="arrow">↑</span>
            <span className="grow small">Explain the whole file <code>{target?.path ?? subject.path}</code></span>
          </button>
        )}
        <AgentTrace steps={steps} running={running} notes={notes} />
        {running && narration && <div className="muted small narration">{narration}</div>}
        {!x && history?.available && (
          <Section title="When was it created & how has it changed?" count={history.commitCount ?? history.commits.length}>
            <HistorySection data={history} onCommit={(sha) => openCommit(sha, target?.path)} />
          </Section>
        )}
        {error && <div className="error-box">{error}</div>}
        {result && (
          <div className="muted small row">
            {result.cached ? <span className="chip">cached</span> : <span className="chip">fresh</span>}
            <span>generated {timeAgo(result.createdAt)}</span>
          </div>
        )}
        {x && (
          <>
            {x.signature && <pre className="sig"><code>{x.signature}</code></pre>}
            {QUESTIONS.map((q) => (
              <Section key={q.key} title={q.title}>
                <Markdown>{x[q.key]}</Markdown>
              </Section>
            ))}
            <Section title="When was it created & how has it changed?" count={history?.available ? history.commitCount ?? history.commits.length : undefined}>
              <HistorySection data={history} narrative={x.history} onCommit={(sha) => openCommit(sha, target?.path)} />
            </Section>
            <Section title="What does it contain?" count={x.contains.length}>
              {x.contains.length ? (
                <div className="link-list">
                  {x.contains.map((c, i) => (
                    <button key={i} className="link-row" onClick={() => onSubject({ path: target?.path ?? subject.path, symbol: { name: c.name, line: c.line } })} title="Explain this">
                      <span className="chip kind">{c.kind}</span>
                      <span className="grow">
                        <code className="plain">{c.name}</code>
                        {c.description && <div className="muted small clamp">{c.description}</div>}
                      </span>
                      {c.line && <span className="muted small">:{c.line}</span>}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="muted small">Nothing notable.</div>
              )}
            </Section>
            <Section title="Who calls it?" count={x.callers.length}>
              <LinkList items={x.callers} empty="No callers found. It may be an entry point, used dynamically, or unused." onOpen={openCode} onExplain={(p, line) => onSubject({ path: p, symbol: line ? { line } : undefined })} />
            </Section>
            <Section title="What does it call?" count={x.callees.length}>
              <LinkList items={x.callees} empty="It doesn't call anything notable." onOpen={openCode} onExplain={(p, line) => onSubject({ path: p, symbol: line ? { line } : undefined })} />
            </Section>
            {!!x.examples?.length && (
              <Section title="Usage examples" count={x.examples.length} defaultOpen={false}>
                <LinkList items={x.examples.map((e) => ({ ...e, why: e.note }))} empty="" onOpen={openCode} />
              </Section>
            )}
            {!!x.gotchas?.length && (
              <Section title="Gotchas" count={x.gotchas.length}>
                <ul>{x.gotchas.map((g, i) => <li key={i}><Markdown>{g}</Markdown></li>)}</ul>
              </Section>
            )}
            <div className="suggest">
              <button onClick={() => askAbout({ focus, question: `Show me an example of how to use ${heading}.`, autoSend: true, category: 'api' })}>Show an example usage</button>
              <button onClick={() => askAbout({ focus, question: `What could go wrong with ${heading}? Any edge cases or security concerns?`, autoSend: true, category: 'security' })}>What could go wrong?</button>
              <button onClick={() => askAbout({ focus })}>Ask a follow-up…</button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function LinkList({
  items,
  empty,
  onOpen,
  onExplain,
}: {
  items: { path: string; line?: number; symbol?: string; why: string }[];
  empty: string;
  onOpen: (p: string, s?: number, e?: number) => void;
  onExplain?: (p: string, line?: number) => void;
}) {
  if (!items.length) return <div className="muted small">{empty}</div>;
  return (
    <div className="link-list">
      {items.map((c, i) =>
        isPkg(c.path) || c.path.startsWith('@') ? (
          <div key={i} className="link-row static">
            <span className="chip">pkg</span>
            <span className="grow"><code className="plain">{c.path}</code>{c.symbol ? <span className="muted"> · {c.symbol}</span> : null}<div className="muted small">{c.why}</div></span>
          </div>
        ) : (
          <div key={i} className="link-row">
            <button className="grow plain-btn" onClick={() => onOpen(c.path, c.line, c.line)} title="Open code">
              <span className="mono small">{c.path}{c.line ? `:${c.line}` : ''}</span>
              {c.symbol && <span className="muted small"> · in {c.symbol}</span>}
              <div className="small">{c.why}</div>
            </button>
            {onExplain && <button className="btn sm ghost" title="Explain this" onClick={() => onExplain(c.path, c.line)}>?</button>}
          </div>
        ),
      )}
    </div>
  );
}
