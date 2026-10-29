import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CodeViewer } from './CodeViewer';

export interface CodeTarget {
  path: string;
  startLine?: number;
  endLine?: number;
}

export function CodeModal({ repoId, target, onClose, onOpenFile }: { repoId: string; target: CodeTarget; onClose: () => void; onOpenFile: (p: string) => void }) {
  const [file, setFile] = useState<{ content: string; lang: string | null; summary: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFile(null);
    setError(null);
    api<any>(`/repos/${repoId}/files?path=${encodeURIComponent(target.path)}`).then(setFile, (e) => setError(e.message));
  }, [repoId, target.path]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={target.path}>
        <div className="panel-head">
          <div className="grow">
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, wordBreak: 'break-all' }}>
              {target.path}
              {target.startLine ? `:${target.startLine}${target.endLine && target.endLine !== target.startLine ? `-${target.endLine}` : ''}` : ''}
            </div>
            {file?.summary && <div className="muted small" style={{ marginTop: 4 }}>{file.summary}</div>}
          </div>
          <button className="btn sm" onClick={() => onOpenFile(target.path)}>Open in Files</button>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="body">
          {error && <div className="error-box">{error}</div>}
          {!file && !error && <div className="empty"><span className="spinner" /></div>}
          {file && <CodeViewer code={file.content} lang={file.lang} highlightStart={target.startLine} highlightEnd={target.endLine} full />}
        </div>
      </div>
    </div>
  );
}
