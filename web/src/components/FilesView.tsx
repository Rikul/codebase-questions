import { useEffect, useMemo, useState } from 'react';
import type { FileNode } from '@cq/shared';
import { api } from '../lib/api';
import { useRepo } from '../lib/repoContext';
import { CodeViewer } from './CodeViewer';
import { ExplainPanel, type ExplainSubject } from './ExplainPanel';

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

/** A file to show, optionally explaining a symbol or highlighting a line range. A new object re-applies it. */
export interface FileTarget {
  path: string;
  symbol?: { name?: string; line?: number };
  startLine?: number;
  endLine?: number;
}

export function FilesView({ target }: { target: FileTarget | null }) {
  const { repo, openCode } = useRepo();
  const [tree, setTree] = useState<FileNode | null>(null);
  const [path, setPath] = useState<string | null>(target?.path ?? null);
  const [range, setRange] = useState<{ path: string; start: number; end: number } | null>(null);
  const [file, setFile] = useState<any>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [idents, setIdents] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState<ExplainSubject | null>(target ? { path: target.path, symbol: target.symbol } : null);
  const [showExplain, setShowExplain] = useState(true);
  const [blameOn, setBlameOn] = useState(false);
  const [blameData, setBlameData] = useState<any[] | null>(null);
  const [blameNote, setBlameNote] = useState<string | null>(null);
  const { openCommit } = useRepo();
  useEffect(() => {
    setBlameData(null);
    setBlameNote(null);
    if (!blameOn || !path) return;
    let active = true; // ignore responses for a file the user has already left
    api<any>(`/repos/${repo.id}/blame?path=${encodeURIComponent(path)}`).then(
      (r) => {
        if (active) r.available ? setBlameData(r.ranges) : setBlameNote(r.reason);
      },
      (e) => active && setBlameNote(e.message),
    );
    return () => {
      active = false;
    };
  }, [blameOn, path, repo.id]);

  useEffect(() => {
    api<FileNode>(`/repos/${repo.id}/files`).then((t) => {
      setTree(t);
      setOpen((o) => (o.size ? o : new Set(t.children?.filter((c) => c.type === 'dir').slice(0, 1).map((c) => c.path))));
    });
  }, [repo.id]);
  useEffect(() => {
    if (!target) return;
    setPath(target.path);
    // Keep the current explanation when a plain link points into the file it already explains.
    setSubject((s) => (target.symbol || s?.path !== target.path ? { path: target.path, symbol: target.symbol } : s));
    setShowExplain(true);
    setRange(target.startLine ? { path: target.path, start: target.startLine, end: target.endLine ?? target.startLine } : null);
  }, [target]);
  useEffect(() => {
    if (!path) return;
    setFile(null);
    const parts = path.split('/');
    setOpen((o) => new Set([...o, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))]));
    let active = true;
    api<any>(`/repos/${repo.id}/files?path=${encodeURIComponent(path)}`).then(
      (f) => active && setFile(f),
      () => active && setFile({ error: true }),
    );
    api<string[]>(`/repos/${repo.id}/identifiers?path=${encodeURIComponent(path)}`).then(
      (l) => active && setIdents(new Set(l)),
      () => active && setIdents(new Set()),
    );
    return () => {
      active = false;
    };
  }, [repo.id, path]);

  const selectFile = (p: string) => {
    setPath(p);
    setSubject({ path: p });
  };
  // Navigating the explain panel to another file also opens that file.
  const onSubject = (s: ExplainSubject) => {
    setSubject(s);
    setShowExplain(true);
    if (s.path !== path) setPath(s.path);
  };
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const signals = useMemo(() => ((file?.meta?.security ?? []) as { kind: string; line: number }[]).filter((s) => s.kind !== 'auth'), [file]);
  const hl = range && range.path === path ? range : null;
  const activeLine = subject?.path === path ? subject?.symbol?.line ?? subject?.snippet?.startLine ?? null : null;

  return (
    <div className="files">
      <div className="tree">{tree ? <TreeNode node={tree} depth={-1} selected={path} onSelect={selectFile} open={open} toggle={toggle} /> : <span className="spinner" />}</div>
      <div className="file-view">
        {!path && <div className="empty">Pick a file. You'll get an explanation of what it is, where it fits, when it runs, and who calls it.</div>}
        {path && !file && <div className="empty"><span className="spinner" /></div>}
        {file?.error && <div className="error-box">Could not load {path}</div>}
        {file && !file.error && (
          <>
            <div className="file-meta">
              <div className="row">
                <h3 className="grow" style={{ fontFamily: 'var(--mono)', fontSize: 15, wordBreak: 'break-all' }}>{file.path}</h3>
                <button className={`btn sm ${blameOn ? 'primary' : ''}`} onClick={() => setBlameOn((b) => !b)} title="Show who last changed each line">
                  {blameOn ? '✓ Blame' : 'Blame'}
                </button>
                {!showExplain && <button className="btn sm" onClick={() => { setShowExplain(true); setSubject({ path: file.path }); }}>✦ Explain</button>}
              </div>
              {file.meta?.history && (
                <div className="small muted hist-line">
                  {file.meta.history.uncertain ? 'Created on or before ' : 'Created '}
                  <button className="plain-btn link" onClick={() => openCommit(file.meta.history.createdSha, file.meta.history.createdPath ?? file.path)}>{String(file.meta.history.createdAt).slice(0, 10)}</button> by {file.meta.history.createdBy}
                  {' · '}last changed{' '}
                  <button className="plain-btn link" onClick={() => openCommit(file.meta.history.lastSha, file.path)}>{String(file.meta.history.lastAt).slice(0, 10)}</button> by {file.meta.history.lastBy}
                  {' · '}{file.meta.history.commits} commit{file.meta.history.commits === 1 ? '' : 's'}
                </div>
              )}
              {blameNote && <div className="small muted">{blameNote}</div>}
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {file.meta?.isEntry && <span className="chip">entry point</span>}
                {file.meta?.isTest && <span className="chip">test</span>}
                {(file.meta?.routes ?? []).slice(0, 8).map((r: any, i: number) => (
                  <button key={i} className="cite" onClick={() => openCode(file.path, r.line, r.line)}>{r.method} {r.path}</button>
                ))}
                {signals.slice(0, 8).map((s, i) => (
                  <button key={`s${i}`} className="chip" style={{ cursor: 'pointer', color: 'var(--danger)' }} onClick={() => openCode(file.path, s.line, s.line)}>⚠ {s.kind}:{s.line}</button>
                ))}
                <span className="muted small">Click an underlined name to explain it, or select code and choose <b>Explain selection</b>.</span>
              </div>
            </div>
            <CodeViewer
              code={file.content}
              lang={file.lang}
              full
              title={`${file.content.split('\n').length} lines · ${file.lang ?? 'text'}`}
              identifiers={idents}
              activeLine={activeLine}
              highlightStart={hl?.start ?? null}
              highlightEnd={hl?.end ?? null}
              blame={blameOn ? blameData : null}
              onBlameClick={(sha) => openCommit(sha, file.path)}
              onIdentifierClick={(name, line) => onSubject({ path: file.path, symbol: { name, line } })}
              onExplainSelection={(sel) => onSubject({ path: file.path, snippet: sel })}
            />
          </>
        )}
      </div>
      {subject && showExplain && <ExplainPanel key={JSON.stringify(subject)} subject={subject} onSubject={onSubject} onClose={() => setShowExplain(false)} />}
    </div>
  );
}
