import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CodeViewer } from './CodeViewer';
import { ExplainPanel, type ExplainSubject } from './ExplainPanel';

export interface CodeTarget {
  path: string;
  startLine?: number;
  endLine?: number;
}

export function CodeModal({ repoId, target, onClose, onOpenFile }: { repoId: string; target: CodeTarget; onClose: () => void; onOpenFile: (p: string, symbol?: { name?: string; line?: number }) => void }) {
  const [file, setFile] = useState<{ content: string; lang: string | null; summary: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState<ExplainSubject | null>(null);
  const [idents, setIdents] = useState<Set<string>>(new Set());
  useEffect(() => {
    const controller = new AbortController();
    setIdents(new Set());
    api<string[]>(`/repos/${repoId}/identifiers?path=${encodeURIComponent(target.path)}`, { signal: controller.signal }).then((l) => { if (!controller.signal.aborted) setIdents(new Set(l)); }, () => undefined);
    return () => controller.abort();
  }, [repoId, target.path]);
  useEffect(() => {
    setFile(null);
    setError(null);
    setSubject(null);
    const controller = new AbortController();
    api<any>(`/repos/${repoId}/files?path=${encodeURIComponent(target.path)}`, { signal: controller.signal }).then(
      (result) => { if (!controller.signal.aborted) setFile(result); },
      (e) => { if (!controller.signal.aborted) setError(e.message); },
    );
    return () => controller.abort();
  }, [repoId, target.path]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className={`modal card ${subject ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={target.path}>
        <div className="panel-head">
          <div className="grow">
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, wordBreak: 'break-all' }}>
              {target.path}
              {target.startLine ? `:${target.startLine}${target.endLine && target.endLine !== target.startLine ? `-${target.endLine}` : ''}` : ''}
            </div>
            {file?.summary && <div className="muted small" style={{ marginTop: 4 }}>{file.summary}</div>}
          </div>
          <button className={`btn sm ${subject ? '' : 'primary'}`} onClick={() => setSubject(subject ? null : target.startLine ? { path: target.path, symbol: { line: target.startLine } } : { path: target.path })}>
            {subject ? 'Hide explanation' : '✦ Explain'}
          </button>
          <button className="btn sm" onClick={() => onOpenFile(target.path, subject?.symbol)}>Open in Files</button>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-split">
          <div className="body">
            {error && <div className="error-box">{error}</div>}
            {!file && !error && <div className="empty"><span className="spinner" /></div>}
            {file && (
              <CodeViewer
                key={target.path}
                code={file.content}
                lang={file.lang}
                highlightStart={target.startLine}
                highlightEnd={target.endLine}
                full
                identifiers={idents}
                onIdentifierClick={(name, line) => setSubject({ path: target.path, symbol: { name, line } })}
                onExplainSelection={(sel) => setSubject({ path: target.path, snippet: sel })}
              />
            )}
          </div>
          {subject && <ExplainPanel key={JSON.stringify(subject)} subject={subject} onSubject={setSubject} onClose={() => setSubject(null)} />}
        </div>
      </div>
    </div>
  );
}
