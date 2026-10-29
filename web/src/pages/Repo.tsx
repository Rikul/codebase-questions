import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Category, RepoSummary } from '@cq/shared';
import { api, post } from '../lib/api';
import { CATEGORY_META } from '../lib/format';
import type { AskIntent, RepoCtx } from '../lib/repoContext';
import { RepoContext } from '../lib/repoContext';
import { ArchDiagram } from '../components/ArchDiagram';
import { Chat } from '../components/Chat';
import { CodeModal, type CodeTarget } from '../components/CodeModal';
import { FilesView } from '../components/FilesView';
import { InsightsView } from '../components/InsightsView';
import { useJobProgress } from './Home';

const TABS = [
  { id: 'architecture', label: `${CATEGORY_META.architecture.icon} Architecture` },
  { id: 'onboarding', label: `${CATEGORY_META.onboarding.icon} Onboarding` },
  { id: 'security', label: `${CATEGORY_META.security.icon} Security` },
  { id: 'api', label: `${CATEGORY_META.api.icon} API & Libraries` },
  { id: 'ask', label: '✦ Ask' },
  { id: 'files', label: '▤ Files' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function Progress({ repo, onDone }: { repo: RepoSummary; onDone: () => void }) {
  const ev = useJobProgress(repo.currentJobId, onDone);
  const stages = ['clone', 'scan', 'parse', 'index', 'summarize', 'architecture', 'insights', 'store', 'flows'];
  const cur = stages.indexOf(ev?.stage ?? '');
  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <div className="card" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18 }}>Building the knowledge base</h2>
        <p className="muted">{repo.url}</p>
        <div className="progress" style={{ margin: '16px 0 8px' }}><div style={{ width: `${Math.round((ev?.progress ?? 0) * 100)}%` }} /></div>
        <div className="row small"><span className="spinner" /> {ev?.message ?? 'Waiting in queue…'}</div>
        <ol className="small" style={{ marginTop: 16, paddingLeft: 20, color: 'var(--text-3)' }}>
          {['Clone repository', 'Scan files', 'Parse imports, routes and signals', 'Build search index', 'Summarize key files with the LLM', 'Synthesize architecture', 'Write onboarding, security and API insights', 'Save', 'Trace key flows'].map((s, i) => (
            <li key={s} style={{ color: i < cur ? 'var(--ok)' : i === cur ? 'var(--text)' : undefined, fontWeight: i === cur ? 600 : 400 }}>{s}</li>
          ))}
        </ol>
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
  const [code, setCode] = useState<CodeTarget | null>(null);
  const [intent, setIntent] = useState<AskIntent | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileSymbol, setFileSymbol] = useState<{ name?: string; line?: number } | null>(null);
  const [menu, setMenu] = useState(false);

  const load = useCallback(() => api<RepoSummary>(`/repos/${id}`).then(setRepo, (e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const setTab = useCallback((t: TabId) => setParams((p) => { p.set('tab', t); return p; }, { replace: true }), [setParams]);
  const ctx = useMemo<RepoCtx | null>(
    () =>
      repo && {
        repo,
        openCode: (path, startLine, endLine) => setCode({ path, startLine, endLine }),
        askAbout: (i) => {
          setIntent(i);
          setTab('ask');
        },
        openFile: (p, symbol) => {
          setCode(null);
          setFilePath(p);
          setFileSymbol(symbol ?? null);
          setTab('files');
        },
      },
    [repo, setTab],
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
            disabled={busy || !repo.url.startsWith('https://')}
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
            {repo.status === 'failed' && <div className="error-box" style={{ margin: 12 }}>Analysis failed: {repo.error}</div>}
            {repo.status === 'ready' && repo.error && <div className="small muted" style={{ padding: '6px 16px', background: 'var(--surface-2)' }}>⚠ {repo.error.split('\n')[0]}</div>}
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
              {tab === 'files' && <FilesView initialPath={filePath} initialSymbol={fileSymbol} />}
            </div>
          </>
        )}
        {code && <CodeModal repoId={repo.id} target={code} onClose={() => setCode(null)} onOpenFile={(p, sym) => ctx.openFile(p, sym)} />}
      </div>
    </RepoContext.Provider>
  );
}
