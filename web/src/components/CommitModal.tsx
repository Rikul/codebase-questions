import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useRepo } from '../lib/repoContext';
import { CodeViewer } from './CodeViewer';

interface Commit {
  available: true;
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: { status: string; path: string; oldPath?: string }[];
  patch: string;
  patchTruncated: boolean;
}

const STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'type changed' };

export function CommitModal({ sha, path, onClose }: { sha: string; path?: string; onClose: () => void }) {
  const { repo, askAbout, openCode } = useRepo();
  const [scope, setScope] = useState<string | undefined>(path);
  const [c, setC] = useState<Commit | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Opening a different commit/file while the modal is open resets the diff scope.
  useEffect(() => {
    setScope(path);
  }, [sha, path]);
  useEffect(() => {
    setC(null);
    setError(null);
    let active = true;
    api<Commit | { available: false; reason: string }>(`/repos/${repo.id}/commits/${sha}${scope ? `?path=${encodeURIComponent(scope)}` : ''}`).then(
      (r) => {
        if (active) r.available ? setC(r) : setError(r.reason);
      },
      (e) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [repo.id, sha, scope]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal card commit-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Commit ${sha}`}>
        <div className="panel-head">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="kicker">commit {sha.slice(0, 10)}</div>
            <h3 style={{ fontSize: 16, marginTop: 2 }}>{c?.subject ?? '…'}</h3>
            {c && <div className="muted small">{c.author} · {c.date.slice(0, 10)} ({timeAgo(c.date)})</div>}
          </div>
          {c && (
            <button
              className="btn sm primary"
              onClick={() => {
                onClose();
                askAbout({ category: 'onboarding', question: `Explain commit ${c.sha.slice(0, 10)} ("${c.subject}"): what changed${scope ? ` in ${scope}` : ''} and why?`, autoSend: true, focus: scope ? { path: scope, label: `${scope} @ ${c.sha.slice(0, 7)}` } : undefined });
              }}
            >
              ✦ Explain this change
            </button>
          )}
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {error && <div className="body"><div className="error-box">{error}</div></div>}
        {!c && !error && <div className="empty"><span className="spinner" /></div>}
        {c && (
          <>
            {/* Three panes that scroll independently: message (top), diff (middle), changed files (bottom). */}
            {c.body && <pre className="commit-body commit-pane-top">{c.body}</pre>}
            <div className="commit-pane-diff">
              <CodeViewer code={c.patch || '(no textual changes)'} lang="diff" diff full title={scope ? `Diff of ${scope}` : `Diff (${c.files.length} files)`} />
            </div>
            <div className="commit-pane-files">
              <div className="files-head small">
                <b>{c.files.length} file{c.files.length === 1 ? '' : 's'} changed</b>
                <span className="muted"> · click a file to show only its diff{scope ? ', click it again for the whole commit' : ''}</span>
              </div>
              <div className="link-list">
                {c.files.slice(0, 500).map((f) => (
                  <div key={f.path} className={`link-row ${scope === f.path ? 'active-row' : ''}`}>
                    <span className={`chip st-${f.status}`}>{STATUS[f.status] ?? f.status}</span>
                    <button className="grow plain-btn mono small" onClick={() => setScope(scope === f.path ? undefined : f.path)} title="Show only this file's diff">
                      {f.oldPath ? `${f.oldPath} → ` : ''}{f.path}
                    </button>
                    {f.status !== 'D' && <button className="btn sm ghost" onClick={() => { onClose(); openCode(f.path); }}>Open</button>}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
