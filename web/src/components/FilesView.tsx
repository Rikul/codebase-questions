import { useEffect, useMemo, useState } from 'react';
import type { FileNode } from '@cq/shared';
import { api } from '../lib/api';
import { useRepo } from '../lib/repoContext';
import { CodeViewer } from './CodeViewer';

function TreeNode({ node, depth, selected, onSelect, open, toggle }: { node: FileNode; depth: number; selected: string | null; onSelect: (p: string) => void; open: Set<string>; toggle: (p: string) => void }) {
  const name = node.path.split('/').pop() || '/';
  if (node.type === 'file') {
    return (
      <div className={`tree-row ${selected === node.path ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(node.path)} title={node.summary ?? node.path}>
        <span className="caret" />
        {name}
      </div>
    );
  }
  const isOpen = open.has(node.path);
  return (
    <>
      {depth >= 0 && (
        <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(node.path)}>
          <span className="caret">{isOpen ? '▾' : '▸'}</span>
          <b style={{ fontWeight: 550 }}>{name}</b>
        </div>
      )}
      {(isOpen || depth < 0) && node.children?.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} open={open} toggle={toggle} />)}
    </>
  );
}

export function FilesView({ initialPath }: { initialPath: string | null }) {
  const { repo, askAbout, openCode } = useRepo();
  const [tree, setTree] = useState<FileNode | null>(null);
  const [path, setPath] = useState<string | null>(initialPath);
  const [file, setFile] = useState<any>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    api<FileNode>(`/repos/${repo.id}/files`).then((t) => {
      setTree(t);
      setOpen(new Set(t.children?.filter((c) => c.type === 'dir').slice(0, 1).map((c) => c.path)));
    });
  }, [repo.id]);
  useEffect(() => {
    setPath(initialPath);
  }, [initialPath]);
  useEffect(() => {
    if (!path) return;
    setFile(null);
    const parts = path.split('/');
    setOpen((o) => new Set([...o, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))]));
    api<any>(`/repos/${repo.id}/files?path=${encodeURIComponent(path)}`).then(setFile, () => setFile({ error: true }));
  }, [repo.id, path]);

  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const signals = useMemo(() => (file?.meta?.security ?? []) as { kind: string; line: number }[], [file]);

  return (
    <div className="files">
      <div className="tree">{tree ? <TreeNode node={tree} depth={-1} selected={path} onSelect={setPath} open={open} toggle={toggle} /> : <span className="spinner" />}</div>
      <div className="file-view">
        {!path && <div className="empty">Select a file to read it with its summary, symbols and dependencies.</div>}
        {path && !file && <div className="empty"><span className="spinner" /></div>}
        {file?.error && <div className="error-box">Could not load {path}</div>}
        {file && !file.error && (
          <>
            <div className="file-meta">
              <div className="row">
                <h3 className="grow" style={{ fontFamily: 'var(--mono)', fontSize: 15, wordBreak: 'break-all' }}>{file.path}</h3>
                <button className="btn sm" onClick={() => askAbout({ focus: { path: file.path, label: file.path } })}>Ask about this file</button>
              </div>
              {file.summary && <div className="card" style={{ padding: 12 }}>{file.summary}</div>}
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {file.meta?.isEntry && <span className="chip">entry point</span>}
                {file.meta?.isTest && <span className="chip">test</span>}
                {(file.meta?.routes ?? []).slice(0, 8).map((r: any, i: number) => (
                  <button key={i} className="cite" onClick={() => openCode(file.path, r.line, r.line)}>{r.method} {r.path}</button>
                ))}
                {signals.slice(0, 8).map((s, i) => (
                  <button key={`s${i}`} className="chip" style={{ cursor: 'pointer', color: 'var(--danger)' }} onClick={() => openCode(file.path, s.line, s.line)}>⚠ {s.kind}:{s.line}</button>
                ))}
              </div>
              {(file.imports.length > 0 || file.importedBy.length > 0) && (
                <div className="row small" style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 16 }}>
                  {file.imports.length > 0 && (
                    <div>
                      <span className="muted">Imports: </span>
                      {file.imports.slice(0, 20).map((x: any, i: number) =>
                        String(x.path).startsWith('pkg:') ? <span key={i} className="chip" style={{ margin: 2 }}>{x.path.slice(4)}</span> : <button key={i} className="cite" style={{ margin: 2 }} onClick={() => setPath(x.path)}>{x.path}</button>,
                      )}
                    </div>
                  )}
                  {file.importedBy.length > 0 && (
                    <div>
                      <span className="muted">Imported by: </span>
                      {file.importedBy.slice(0, 20).map((x: any, i: number) => <button key={i} className="cite" style={{ margin: 2 }} onClick={() => setPath(x.path)}>{x.path}</button>)}
                    </div>
                  )}
                </div>
              )}
            </div>
            <CodeViewer code={file.content} lang={file.lang} full title={`${file.content.split('\n').length} lines · ${file.lang ?? 'text'}`} />
          </>
        )}
      </div>
    </div>
  );
}
