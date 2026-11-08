import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStep, Review, ReviewEvent, ReviewList, ReviewSeverity } from '@cq/shared';
import { REVIEW_SEVERITIES } from '@cq/shared';
import { api, streamPost } from '../lib/api';
import { useRepo } from '../lib/repoContext';
import { AgentTrace, upsertStep } from './AgentTrace';
import { Markdown } from './Markdown';

type Result = { review: Review; createdAt: string; cached: boolean };

const baseName = (p: string) => p.split('/').pop() ?? p;
const dirName = (p: string) => p.split('/').slice(0, -1).join('/');

/** Code review tab: the full codebase review (written in the background) plus per-file reviews. `path` null = full review. */
export function ReviewView({ path }: { path: string | null }) {
  const { repo, openCode, openReview, askAbout } = useRepo();
  const [list, setList] = useState<ReviewList | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewSeverity | null>(null);
  const abort = useRef<AbortController | null>(null);
  const background = repo.status === 'enriching';
  const entries = list?.reviews ?? [];
  const liveFull = list?.running.full ?? false;
  const liveFiles = list?.running.files ?? [];

  const loadList = useCallback(() => api<ReviewList>(`/repos/${repo.id}/reviews`).then(setList).catch(() => undefined), [repo.id]);
  useEffect(() => {
    loadList();
  }, [loadList, repo.status]);
  // Reviews run on the server, so keep the sidebar current while any are in progress.
  const anyLive = background || liveFull || liveFiles.length > 0;
  useEffect(() => {
    if (!anyLive) return;
    const t = window.setInterval(loadList, 3000);
    return () => window.clearInterval(t);
  }, [anyLive, loadList]);

  /** Stream a review: joins one already running on the server, returns a stored one, or starts one. */
  const run = useCallback(
    (refresh: boolean) => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setSteps([]);
      setError(null);
      setRunning(true);
      streamPost<ReviewEvent>(
        `/repos/${repo.id}/review`,
        { path: path ?? undefined, refresh },
        (e) => {
          if (e.type === 'step') setSteps((s) => upsertStep(s, e.step));
          else if (e.type === 'result') setResult(e);
          else if (e.type === 'error') setError(e.message);
        },
        ctrl.signal,
      )
        .catch((err) => (err as Error).name !== 'AbortError' && setError((err as Error).message))
        .finally(() => {
          if (ctrl.signal.aborted) return;
          abort.current = null;
          setRunning(false);
          loadList();
        });
      loadList();
    },
    [repo.id, path, loadList],
  );

  // Switching review: drop the old one. Leaving only stops watching; the server keeps reviewing.
  useEffect(() => {
    setResult(null);
    setSteps([]);
    setError(null);
    setRunning(false);
    setFilter(null);
    if (path) run(false); // a file review starts (or loads, or joins) when opened
    return () => {
      abort.current?.abort();
      abort.current = null;
    };
  }, [path, run]);

  // Full review: show the stored one, and follow a run in progress (user-started or background).
  const listLoaded = list !== null;
  useEffect(() => {
    if (path || !listLoaded || abort.current) return;
    if (liveFull) run(false);
    let active = true;
    setLoading(true);
    api<{ review: Review; createdAt: string } | null>(`/repos/${repo.id}/review`)
      .then((r) => active && r && setResult((cur) => (cur && !cur.cached ? cur : { ...r, cached: true })))
      .catch((e) => active && setError((e as Error).message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [path, listLoaded, liveFull, repo.id, repo.status, run]);

  const files = entries.filter((e) => e.path);
  const full = entries.find((e) => !e.path);
  const review = result?.review;
  const shown = review ? review.findings.filter((f) => !filter || f.severity === filter) : [];

  return (
    <div className="chat">
      <nav className="chat-side">
        <button className={!path ? 'active' : ''} onClick={() => openReview()} title="Review of the whole codebase">
          <SevDot sev={full ? full.worst : undefined} /> <b>Full Codebase Review</b>
          {(liveFull || (background && !full)) && <span className="spinner" style={{ marginLeft: 6 }} />}
        </button>
        <div className="side-label">Files</div>
        {[...new Set([...(path ? [path] : []), ...liveFiles])]
          .filter((p) => !files.some((e) => e.path === p))
          .map((p) => (
            <button key={p} className={p === path ? 'active' : ''} onClick={() => openReview(p)} title={`${p} · reviewing…`}>
              <span className="spinner" /> {baseName(p)}
            </button>
          ))}
        {files.map((e) => (
          <button key={e.path} className={e.path === path ? 'active' : ''} onClick={() => openReview(e.path!)} title={`${e.path} · ${e.findings} finding${e.findings === 1 ? '' : 's'}${e.stale ? ' · file changed since review' : ''}`}>
            {liveFiles.includes(e.path!) ? <span className="spinner" /> : <SevDot sev={e.worst} />} {baseName(e.path!)}
            <span className="muted small"> {dirName(e.path!)}</span>
          </button>
        ))}
        {!files.length && !path && <div className="muted small" style={{ padding: 8 }}>Click <b>Review</b> on a file in the Files tab to review it here.</div>}
      </nav>
      <div className="insights-main">
        <div className="insights-inner">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="muted small" style={{ fontWeight: 600 }}>✓ Code review</div>
              {path ? (
                <h2 style={{ fontSize: 20, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                  <button className="plain-btn link" onClick={() => openCode(path)}>{path}</button>
                </h2>
              ) : (
                <h2 style={{ fontSize: 22, letterSpacing: '-0.01em' }}>Full Codebase Review</h2>
              )}
              {result && <div className="muted small">Reviewed {new Date(result.createdAt).toLocaleString()}{entries.find((e) => e.path === path)?.stale ? (path ? ' · the file has changed since' : ' · the code has been re-analyzed since; refresh to review the current commit') : ''}</div>}
            </div>
            {(result || (path && !running)) && <button className="btn" disabled={running || (!path && liveFull)} onClick={() => run(true)}>Re-run review</button>}
          </div>

          {!path && background && !liveFull && !running && (
            <div className="card insight small"><span className="spinner" /> The codebase review starts in the background once architecture synthesis finishes. It will appear here when ready.</div>
          )}
          {error && <div className="error-box">{error}</div>}
          {running && (
            <div className="card insight">
              <div className="small muted" style={{ marginBottom: 6 }}>
                {review ? 'A new review is running; the one below is the previous review. ' : ''}The review runs on the server, so you can leave this page and come back.
              </div>
              <AgentTrace steps={steps} running defaultOpen />
            </div>
          )}
          {loading && <div className="empty"><span className="spinner" /></div>}
          {!path && !loading && !result && !background && !running && !liveFull && (
            <div className="card insight">
              <p>No codebase review yet. It normally runs after analysis; you can also start one now. It reads the riskiest code and takes a few minutes.</p>
              <button className="btn primary" style={{ marginTop: 10 }} onClick={() => run(true)}>Run full review</button>
            </div>
          )}

          {review && (
            <>
              <div className="card insight">
                <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
                  <b className="grow">{review.findings.length ? `${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}` : 'No findings'}</b>
                  <div className="sev-summary">
                    {REVIEW_SEVERITIES.map((s) => {
                      const n = review.findings.filter((f) => f.severity === s).length;
                      return n ? (
                        <button key={s} className={`sev ${s} sev-btn ${filter && filter !== s ? 'dim' : ''}`} onClick={() => setFilter((f) => (f === s ? null : s))} title={`Show only ${s}`}>
                          {n} {s}
                        </button>
                      ) : null;
                    })}
                  </div>
                </div>
                <Markdown>{review.summaryMd}</Markdown>
                {(review.strengths?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div className="small" style={{ fontWeight: 600 }}>Strengths</div>
                    <ul className="small">{review.strengths!.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
                {!running && steps.length > 0 && <AgentTrace steps={steps} running={false} />}
              </div>
              {shown.map((f, i) => (
                <article key={i} className="card insight">
                  <div className="insight-head">
                    <span className={`sev ${f.severity}`}>{f.severity}</span>
                    <span className="chip">{f.kind}</span>
                    <h3 className="grow">{f.title}</h3>
                    <button
                      className="btn sm ghost"
                      onClick={() => askAbout({ question: `Tell me more about this code review finding: "${f.title}". How should I fix it?`, autoSend: true, focus: f.path ? { path: f.path, label: f.path } : undefined })}
                    >
                      Ask more
                    </button>
                  </div>
                  {f.path && (
                    <div style={{ marginBottom: 6 }}>
                      <button className="cite" onClick={() => openCode(f.path!, f.startLine, f.endLine)}>
                        {f.path}{f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ''}` : ''}
                      </button>
                    </div>
                  )}
                  <Markdown>{f.detail}</Markdown>
                  {f.suggestion && (
                    <div className="rev-fix">
                      <div className="small" style={{ fontWeight: 600 }}>Suggested fix</div>
                      <Markdown>{f.suggestion}</Markdown>
                    </div>
                  )}
                </article>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Most severe finding's color; green when clean, grey when there is no review yet (undefined). */
function SevDot({ sev }: { sev?: ReviewSeverity | null }) {
  if (sev === undefined) return <span className="rev-dot" />;
  return <span className={`rev-dot ${sev ?? 'none'}`} title={sev ? `Most severe: ${sev}` : 'No findings'} />;
}
