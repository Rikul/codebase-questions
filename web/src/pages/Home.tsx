import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { JobEvent, RepoSummary } from '@cq/shared';
import { CATEGORIES } from '@cq/shared';
import { api, post } from '../lib/api';
import { CATEGORY_META, sourceLabel, timeAgo } from '../lib/format';
import { folderFiles, uploadSource } from '../lib/upload';

const CAT_DESC = {
  architecture: 'An interactive component diagram: click components and connections to see code evidence.',
  onboarding: 'Setup steps, entry points, a suggested reading order and project conventions.',
  security: 'Attack surface, auth, injection sinks and secrets, with severity-ranked findings.',
  api: 'Public interfaces, HTTP endpoints and how third-party libraries are used at runtime.',
  repository: 'Size, languages, activity and contributors, how the code evolved, and a commit explorer filtered by type and size.',
};

export function useJobProgress(jobId: string | null, onDone?: () => void) {
  const [ev, setEv] = useState<JobEvent | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    setEv(null);
    if (!jobId) return;
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    let stage: string | null = null;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as JobEvent;
      setEv(e);
      // Results become readable when the job enters the background code-review stage; refresh once.
      const entered = e.stage !== stage;
      stage = e.stage;
      if (entered && e.stage === 'review' && !e.done) done.current?.();
      if (e.done) {
        es.close();
        done.current?.();
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [jobId]);
  return ev;
}

function RepoRow({ repo, onChange }: { repo: RepoSummary; onChange: () => void }) {
  const active = repo.status === 'running' || repo.status === 'queued' || repo.status === 'enriching';
  const ev = useJobProgress(active ? repo.currentJobId : null, onChange);
  return (
    <div className="card repo-item">
      <div className="grow">
        <div className="row">
          <Link to={`/repo/${repo.id}`} className="name">{repo.name}</Link>
          <span className={`status ${repo.status}`}>{repo.status}</span>
        </div>
        <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sourceLabel(repo.url)} · {repo.fileCount} files{repo.commit ? ` · ${repo.commit.slice(0, 8)}` : ''} · {timeAgo(repo.updatedAt)}
        </div>
        {active && (
          <div style={{ marginTop: 8 }}>
            <div className="progress"><div style={{ width: `${Math.round((ev?.progress ?? 0) * 100)}%` }} /></div>
            <div className="muted small" style={{ marginTop: 4 }}>{ev?.message ?? 'Queued'}</div>
          </div>
        )}
        {repo.status === 'failed' && repo.error && <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>{repo.error}</div>}
      </div>
      <Link className="btn sm" to={`/repo/${repo.id}`}>Open</Link>
      <button
        className="btn sm ghost danger"
        onClick={async () => {
          if (!confirm(`Delete ${repo.name} and its knowledge base?`)) return;
          await api(`/repos/${repo.id}`, { method: 'DELETE' });
          onChange();
        }}
      >
        Delete
      </button>
    </div>
  );
}

export function Home() {
  const nav = useNavigate();
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<{ provider: string; model: string; embeddings: string | null; maxUploadMb: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  // React has no typed prop for folder pickers.
  useEffect(() => {
    dirRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  const startUpload = async (fd: FormData, bytes: number) => {
    setError(null);
    if (cfg && bytes > cfg.maxUploadMb * 1024 * 1024) {
      setError(`That is ${(bytes / 1024 / 1024).toFixed(0)} MB, over the upload limit of ${cfg.maxUploadMb} MB (MAX_UPLOAD_MB).`);
      return;
    }
    setUploading(0);
    try {
      const r = await uploadSource(fd, setUploading);
      nav(`/repo/${r.repoId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(null);
    }
  };

  const load = () => api<RepoSummary[]>('/repos').then(setRepos).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api<any>('/config').then(setCfg).catch(() => undefined);
  }, []);

  return (
    <div className="page">
      <section className="hero">
        <h1>Understand any codebase</h1>
        <p>Paste a Git repository URL, or upload a ZIP or folder. The app maps its structure with static analysis and an LLM, and builds a knowledge base you can explore and ask questions about.</p>
      </section>
      <div className="card add-card">
        <form
          className="add-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const r = await post<{ repoId: string }>('/repos', { url });
              setUrl('');
              nav(`/repo/${r.repoId}`);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input className="input grow" placeholder="https://github.com/owner/repo  (or owner/repo, optional #branch)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Repository URL" />
          <button className="btn primary" disabled={!url.trim() || busy || uploading !== null} style={{ height: 38 }}>{busy ? <span className="spinner" /> : 'Analyze'}</button>
        </form>
        <div className="add-alt small">
          {uploading !== null ? (
            <>
              <span className="spinner" />
              <span className="muted">{uploading < 1 ? `Uploading ${Math.round(uploading * 100)}%` : 'Extracting files…'}</span>
              <div className="progress grow"><div style={{ width: `${Math.round(uploading * 100)}%` }} /></div>
            </>
          ) : (
            <>
              <span className="muted">No Git URL?</span>
              <button type="button" className="btn sm" onClick={() => zipRef.current?.click()} title="Upload the project as a .zip archive (a GitHub 'Download ZIP' works)">Upload ZIP</button>
              <button type="button" className="btn sm" onClick={() => dirRef.current?.click()} title="Upload a project folder from your computer; node_modules, build output and .gitignored files are left out">Upload folder</button>
              <span className="muted">· uploads have no git history{cfg ? `, up to ${cfg.maxUploadMb} MB` : ''}</span>
              <span className="grow" />
              <button type="button" className="btn sm ghost" onClick={() => fileRef.current?.click()} title="Import a project exported as JSON">Import JSON</button>
            </>
          )}
        </div>
        <input ref={zipRef} type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const fd = new FormData();
          fd.append('file', f);
          void startUpload(fd, f.size);
        }} />
        <input ref={dirRef} type="file" multiple hidden onChange={async (e) => {
          const list = e.target.files;
          if (!list?.length) return;
          const { files, paths } = await folderFiles(list);
          e.target.value = '';
          if (!files.length) return setError('That folder has no source files to analyze.');
          const fd = new FormData();
          fd.append('paths', JSON.stringify(paths));
          for (const f of files) fd.append('files', f, f.name);
          void startUpload(fd, files.reduce((n, f) => n + f.size, 0));
        }} />
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const fd = new FormData();
            fd.append('file', f);
            setError(null);
            const res = await fetch('/api/repos/import', { method: 'POST', body: fd });
            const body = await res.json();
            if (!res.ok) setError(body.error ?? 'Import failed');
            else nav(`/repo/${body.repoId}`);
          }}
        />
      </div>
      {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}
      {cfg?.provider === 'mock' && (
        <div className="card small" style={{ padding: '10px 14px', marginTop: 10, borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))' }}>
          <b style={{ color: 'var(--warn)' }}>Offline mode.</b> No LLM API key is configured, so analysis uses static heuristics only. Set <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> for richer architecture, insights and answers.
        </div>
      )}

      <div className="repo-list">
        {repos?.map((r) => <RepoRow key={r.id} repo={r} onChange={load} />)}
        {repos && !repos.length && <div className="card empty">No repositories yet. Try <code>expressjs/cors</code> or <code>pallets/click</code>.</div>}
        {!repos && !error && <div className="empty"><span className="spinner" /></div>}
      </div>

      <div className="cat-grid">
        {CATEGORIES.map((c) => (
          <div key={c} className="card cat-card">
            <div className="icon">{CATEGORY_META[c].icon}</div>
            <b>{CATEGORY_META[c].label}</b>
            <div className="muted small" style={{ marginTop: 4 }}>{CAT_DESC[c]}</div>
          </div>
        ))}
      </div>
      {cfg && <div className="muted small" style={{ marginTop: 18 }}>LLM: {cfg.provider} ({cfg.model}) · search: {cfg.embeddings ? `hybrid (${cfg.embeddings} embeddings)` : 'keyword'}</div>}
    </div>
  );
}
