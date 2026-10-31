import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Category, RepoSummary } from '@cq/shared';
import { ANALYSIS_STEPS } from '@cq/shared';
import { api, post } from '../lib/api';
import { CATEGORY_META } from '../lib/format';
import type { AskIntent, RepoCtx } from '../lib/repoContext';
import { RepoContext } from '../lib/repoContext';
import { ArchDiagram } from '../components/ArchDiagram';
import { Chat } from '../components/Chat';
import { CommitModal } from '../components/CommitModal';
import { FilesView, type FileTarget } from '../components/FilesView';
import { InsightsView } from '../components/InsightsView';
import { ReviewView } from '../components/ReviewView';
import { useJobProgress } from './Home';

const TABS = [
  { id: 'architecture', label: `${CATEGORY_META.architecture.icon} Architecture` },
  { id: 'onboarding', label: `${CATEGORY_META.onboarding.icon} Onboarding` },
  { id: 'security', label: `${CATEGORY_META.security.icon} Security` },
  { id: 'api', label: `${CATEGORY_META.api.icon} API & Libraries` },
  { id: 'ask', label: '✦ Ask' },
  { id: 'review', label: '✓ Review' },
  { id: 'files', label: '▤ Files' },
] as const;
type TabId = (typeof TABS)[number]['id'];

// The last steps run after results are shown (repo status 'enriching'), when this view is gone.
const FOREGROUND_STEPS = ANALYSIS_STEPS.filter((step) => step.id !== 'architecture' && step.id !== 'review');

function Progress({ repo, onDone }: { repo: RepoSummary; onDone: () => void }) {
  const ev = useJobProgress(repo.currentJobId, onDone);
  const cur = FOREGROUND_STEPS.findIndex((step) => step.id === (ev?.stage === 'embed' ? 'index' : ev?.stage));
  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <div className="card" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18 }}>Building the knowledge base</h2>
        <p className="muted">{repo.url}</p>
        <div className="progress" style={{ margin: '16px 0 8px' }}><div style={{ width: `${Math.round((ev?.progress ?? 0) * 100)}%` }} /></div>
        <div className="row small"><span className="spinner" /> {ev?.message ?? 'Waiting in queue…'}</div>
        <ol className="small" style={{ marginTop: 16, paddingLeft: 20, color: 'var(--text-3)' }}>
          {FOREGROUND_STEPS.map((step, i) => (
            <li key={step.id} style={{ color: i < cur ? 'var(--ok)' : i === cur ? 'var(--text)' : undefined, fontWeight: i === cur ? 600 : 400 }}>{step.label}</li>
          ))}
        </ol>
        <p className="small muted" style={{ marginTop: 8 }}>Results open once these steps finish; the architecture diagram is then refined and the code reviewed in the background.</p>
      </div>
    </div>
  );
}

export function Repo() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabId) || 'architecture';
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<AskIntent | null>(null);
  const [menu, setMenu] = useState(false);
  const [commit, setCommit] = useState<{ sha: string; path?: string } | null>(null);

  const load = useCallback(() => api<RepoSummary>(`/repos/${id}`).then(setRepo, (e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  useJobProgress(repo?.status === 'enriching' ? repo.currentJobId : null, load);
  useEffect(() => {
    if (repo?.status !== 'enriching') return;
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [repo?.status, load]);

  // Tabs and the open file live in the URL, and each change adds a history entry,
  // so the browser's Back button steps back through them.
  const setTab = useCallback((t: TabId) => setParams((p) => { p.set('tab', t); return p; }), [setParams]);
  const showFile = useCallback(
    (t: FileTarget) =>
      setParams((p) => {
        p.set('tab', 'files');
        p.set('path', t.path);
        const put = (k: string, v: string | undefined) => (v ? p.set(k, v) : p.delete(k));
        put('lines', t.startLine ? (t.endLine && t.endLine !== t.startLine ? `${t.startLine}-${t.endLine}` : String(t.startLine)) : undefined);
        put('sym', t.symbol?.name);
        put('symLine', t.symbol?.line ? String(t.symbol.line) : undefined);
        return p;
      }),
    [setParams],
  );
  const openReview = useCallback(
    (path?: string) =>
      setParams((p) => {
        p.set('tab', 'review');
        if (path) p.set('rpath', path);
        else p.delete('rpath');
        return p;
      }),
    [setParams],
  );
  const reviewPath = params.get('rpath');
  const [fPath, fLines, fSym, fSymLine] = ['path', 'lines', 'sym', 'symLine'].map((k) => params.get(k));
  const fileTarget = useMemo<FileTarget | null>(() => {
    if (!fPath) return null;
    const [start, end] = (fLines ?? '').split('-').map(Number);
    const symbol = fSym || fSymLine ? { name: fSym ?? undefined, line: fSymLine ? Number(fSymLine) : undefined } : undefined;
    return { path: fPath, symbol, startLine: start || undefined, endLine: end || start || undefined };
  }, [fPath, fLines, fSym, fSymLine]);
  const ctx = useMemo<RepoCtx | null>(
    () =>
      repo && {
        repo,
        // File links open in the Files tab (scrolled to and highlighting the cited lines).
        openCode: (path, startLine, endLine) => showFile({ path, startLine, endLine }),
        askAbout: (i) => {
          setIntent(i);
          setTab('ask');
        },
        openCommit: (sha, path) => setCommit({ sha, path }),
        openFile: (p, symbol) => showFile({ path: p, symbol }),
        openReview,
      },
    [repo, setTab, showFile, openReview],
  );

  if (error) return <div className="page"><div className="error-box">{error}</div><p><Link to="/">← Back</Link></p></div>;
  if (!repo || !ctx) return <div className="empty"><span className="spinner" /></div>;

  const busy = repo.status === 'running' || repo.status === 'queued';
  return (
    <RepoContext.Provider value={ctx}>
      <div className="repo-shell">
        <div className="repo-head">
          <Link to="/" className="muted">Repositories</Link>
          <span className="muted">/</span>
          <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.name}</b>
          <span className={`status ${repo.status}`}>{repo.status}</span>
          {repo.commit && <code className="small">{repo.commit.slice(0, 8)}</code>}
          <span className="grow" />
          <a className="btn sm ghost" href={repo.url.split('#')[0]} target="_blank" rel="noreferrer">Source ↗</a>
          <div style={{ position: 'relative' }}>
            <button className="btn sm" onClick={() => setMenu((m) => !m)} disabled={busy}>Export ▾</button>
            {menu && (
              <div className="card" style={{ position: 'absolute', right: 0, top: 34, zIndex: 30, padding: 6, width: 240, display: 'grid' }} onMouseLeave={() => setMenu(false)}>
                <a className="link-row" href={`/api/repos/${repo.id}/export`} onClick={() => setMenu(false)}>
                  <span className="grow">Knowledge base (JSON)<div className="muted small">Architecture, insights, summaries, chats</div></span>
                </a>
                <a className="link-row" href={`/api/repos/${repo.id}/export?includeSource=true`} onClick={() => setMenu(false)}>
                  <span className="grow">With source code (JSON)<div className="muted small">Larger; the code viewer works after import</div></span>
                </a>
              </div>
            )}
          </div>
          <button
            className="btn sm"
            disabled={busy || repo.status === 'enriching' || !repo.url.startsWith('https://')}
            onClick={async () => {
              await post(`/repos/${repo.id}/reanalyze`);
              load();
            }}
            title="Re-clone and rebuild the knowledge base (unchanged file summaries are reused)"
          >
            Re-analyze
          </button>
        </div>
        {busy ? (
          <Progress repo={repo} onDone={load} />
        ) : (
          <>
            {repo.status === 'enriching' && <div className="small muted" style={{ padding: '8px 16px' }}><span className="spinner" /> Results are available. Architecture synthesis and the code review are running in the background; the diagram and Review tab update automatically.</div>}
            {repo.status === 'failed' && <div className="error-box" style={{ margin: 12 }}>Analysis failed: {repo.error}</div>}
            {repo.status === 'ready' && repo.error && (
              <details className="small muted" style={{ padding: '6px 16px', background: 'var(--surface-2)' }}>
                <summary>⚠ Analysis completed with warnings — show details</summary>
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 8 }}>{repo.error}</div>
              </details>
            )}
            {repo.status === 'imported' && !repo.hasSource && <div className="small muted" style={{ padding: '6px 16px', background: 'var(--surface-2)' }}>Imported without source code. Search uses file summaries, and Re-analyze will clone the repository again.</div>}
            <nav className="tabs">
              {TABS.map((t) => (
                <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
              ))}
            </nav>
            <div className="repo-body">
              {tab === 'architecture' && <ArchDiagram />}
              {(['onboarding', 'security', 'api'] as Category[]).includes(tab as Category) && (
                <div className="insights-layout">
                  <InsightsView category={tab as Category} />
                </div>
              )}
              {tab === 'ask' && <Chat intent={intent} onIntentConsumed={() => setIntent(null)} />}
              {tab === 'review' && <ReviewView path={reviewPath} />}
              {tab === 'files' && <FilesView target={fileTarget} />}
            </div>
          </>
        )}
        {commit && <CommitModal sha={commit.sha} path={commit.path} onClose={() => setCommit(null)} />}
      </div>
    </RepoContext.Provider>
  );
}
