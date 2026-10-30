import { useEffect, useMemo, useRef, useState } from 'react';
import { highlight } from '../lib/highlight';

interface Props {
  code: string;
  lang?: string | null;
  /** Line number of the first line of `code`. */
  firstLine?: number;
  highlightStart?: number | null;
  highlightEnd?: number | null;
  full?: boolean;
  title?: React.ReactNode;
  actions?: React.ReactNode;
  /** Identifiers to make clickable (e.g. symbols defined or referenced in this file). */
  identifiers?: Set<string>;
  onIdentifierClick?: (name: string, line: number) => void;
  onExplainSelection?: (sel: { text: string; startLine: number; endLine: number }) => void;
  activeLine?: number | null;
  /** Blame ranges for a gutter column (line numbers refer to `firstLine`-based lines). */
  blame?: { start: number; end: number; sha: string; author: string; date: string; summary: string }[] | null;
  onBlameClick?: (sha: string) => void;
  /** Color +/- lines of a unified diff. */
  diff?: boolean;
}

function initials(name: string) {
  return name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

function age(date: string) {
  const days = (Date.now() - new Date(date).getTime()) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 730) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

const PAGE_LINES = 250;
const HIGHLIGHT_CHARS = 50_000;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;

/** Wrap known identifiers inside highlighted line HTML with clickable spans. */
function markIdentifiers(html: string, idents: Set<string>): string {
  if (html.length > 20_000 || !idents.size || !/[A-Za-z_$]/.test(html)) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    const s = t.data;
    let last = 0;
    const frag = document.createDocumentFragment();
    let changed = false;
    for (const m of s.matchAll(IDENT_RE)) {
      if (!idents.has(m[0])) continue;
      changed = true;
      if (m.index! > last) frag.append(s.slice(last, m.index));
      const span = document.createElement('span');
      span.className = 'ident';
      span.dataset.ident = m[0];
      span.textContent = m[0];
      frag.append(span);
      last = m.index! + m[0].length;
    }
    if (!changed) continue;
    if (last < s.length) frag.append(s.slice(last));
    t.replaceWith(frag);
  }
  return tpl.innerHTML;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function CodeViewer({ code, lang, firstLine = 1, highlightStart, highlightEnd, full, title, actions, identifiers, onIdentifierClick, onExplainSelection, activeLine, blame, onBlameClick, diff }: Props) {
  const blameAt = useMemo(() => {
    if (!blame?.length) return null;
    const m = new Map<number, (typeof blame)[number]>();
    for (const r of blame) m.set(r.start, r);
    const times = blame.map((r) => new Date(r.date).getTime());
    return { starts: m, min: Math.min(...times), max: Math.max(...times) };
  }, [blame]);
  const rawLines = useMemo(() => code.split('\n'), [code]);
  const paged = rawLines.length > 500 || code.length > HIGHLIGHT_CHARS;
  const focus = highlightStart ?? activeLine ?? firstLine;
  const initialPage = Math.floor(Math.max(0, Math.min(rawLines.length - 1, focus - firstLine)) / PAGE_LINES);
  const [page, setPage] = useState(initialPage);
  useEffect(() => { setPage(initialPage); }, [code, firstLine, focus, initialPage]);
  const pageStart = paged ? Math.min(page, Math.floor((rawLines.length - 1) / PAGE_LINES)) * PAGE_LINES : 0;
  const visibleLines = useMemo(() => paged ? rawLines.slice(pageStart, pageStart + PAGE_LINES) : rawLines, [rawLines, paged, pageStart]);
  const visibleCode = useMemo(() => visibleLines.join('\n'), [visibleLines]);
  const displayFirstLine = firstLine + pageStart;
  const [selection, setSelection] = useState<{ text: string; startLine: number; endLine: number; x: number; y: number } | null>(null);
  const plain = useMemo(() => visibleLines.map(escapeHtml), [visibleLines]);
  const [highlighted, setHighlighted] = useState<{ code: string; lang: Props['lang']; lines: string[] } | null>(null);
  const lines = highlighted?.code === visibleCode && highlighted.lang === lang ? highlighted.lines : plain;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    if (visibleCode.length > HIGHLIGHT_CHARS) return;
    highlight(visibleCode, lang, controller.signal).then((html) => {
      if (controller.signal.aborted || !html) return;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ls = [...doc.querySelectorAll('.line')].map((l) => l.innerHTML);
      if (ls.length === visibleLines.length) setHighlighted({ code: visibleCode, lang, lines: ls });
    });
    return () => controller.abort();
  }, [visibleCode, lang, visibleLines.length]);

  useEffect(() => {
    if (!highlightStart || !scrollRef.current) return;
    const row = scrollRef.current.querySelector<HTMLTableRowElement>(`tr[data-ln="${highlightStart}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [highlightStart, pageStart, code]);

  const rendered = useMemo(() => (identifiers && Boolean(onIdentifierClick) ? lines.map((l) => markIdentifiers(l, identifiers)) : lines), [lines, identifiers, Boolean(onIdentifierClick)]);

  const lineOfNode = (n: Node | null): number | null => {
    const el = n instanceof Element ? n : n?.parentElement;
    const tr = el?.closest('tr[data-ln]') as HTMLElement | null;
    return tr ? Number(tr.dataset.ln) : null;
  };

  const onClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('.ident') as HTMLElement | null;
    if (!el || !onIdentifierClick) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // user is selecting text
    const line = lineOfNode(el);
    if (line) onIdentifierClick(el.dataset.ident!, line);
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (!onExplainSelection) return;
    const sel = window.getSelection();
    const text = sel?.toString() ?? '';
    if (!sel || sel.isCollapsed || text.trim().length < 3 || !scrollRef.current?.contains(sel.anchorNode)) return setSelection(null);
    const a = lineOfNode(sel.anchorNode);
    const b = lineOfNode(sel.focusNode);
    if (!a || !b) return setSelection(null);
    // Line-number cells are not selectable; strip any stray gutter text.
    const box = scrollRef.current.getBoundingClientRect();
    setSelection({ text: text.replace(/\u00a0/g, ' '), startLine: Math.min(a, b), endLine: Math.max(a, b), x: e.clientX - box.left + scrollRef.current.scrollLeft, y: e.clientY - box.top + scrollRef.current.scrollTop });
  };

  const hs = highlightStart ?? -1;
  const he = highlightEnd ?? hs;
  return (
    <div className="code-block">
      {(title || actions) && (
        <div className="head">
          <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          {actions}
        </div>
      )}
      {paged && (
        <div className="head" aria-label="File sections">
          <button className="btn sm" disabled={pageStart === 0} onClick={() => { setPage(Math.max(0, page - 1)); setSelection(null); }}>Previous</button>
          <span className="small muted grow">Lines {displayFirstLine}–{displayFirstLine + visibleLines.length - 1} of {firstLine + rawLines.length - 1}</span>
          <label className="small muted">Section <select aria-label="File section" value={pageStart / PAGE_LINES} onChange={(e) => { setPage(Number(e.target.value)); setSelection(null); }}>
            {Array.from({ length: Math.ceil(rawLines.length / PAGE_LINES) }, (_, i) => <option key={i} value={i}>{firstLine + i * PAGE_LINES}–{Math.min(firstLine + (i + 1) * PAGE_LINES - 1, firstLine + rawLines.length - 1)}</option>)}
          </select></label>
          <button className="btn sm" disabled={pageStart + PAGE_LINES >= rawLines.length} onClick={() => { setPage(page + 1); setSelection(null); }}>Next</button>
        </div>
      )}
      <div
        className={`code-scroll shiki ${full ? 'full' : ''} ${onIdentifierClick ? 'clickable' : ''}`}
        ref={scrollRef}
        onClick={onClick}
        onMouseUp={onMouseUp}
        style={{ position: 'relative' }}
      >
        {selection && onExplainSelection && (
          <button
            className="sel-btn"
            style={{ left: selection.x + 8, top: selection.y + 12 }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onExplainSelection({ text: selection.text, startLine: selection.startLine, endLine: selection.endLine });
              setSelection(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            ✦ Explain selection
          </button>
        )}
        <table className="code-table">
          <tbody>
            {rendered.map((l, i) => {
              const n = displayFirstLine + i;
              return (
                <tr
                  key={i}
                  data-ln={n}
                  className={
                    [
                      n >= hs && n <= he ? 'hl' : '',
                      activeLine === n ? 'active' : '',
                      diff ? (visibleLines[i]?.startsWith('+') && !visibleLines[i]?.startsWith('+++') ? 'add' : visibleLines[i]?.startsWith('-') && !visibleLines[i]?.startsWith('---') ? 'del' : visibleLines[i]?.startsWith('@@') ? 'hunk' : '') : '',
                    ]
                      .join(' ')
                      .trim() || undefined
                  }
                >
                  {blameAt && (() => {
                    const r = blameAt.starts.get(n);
                    if (!r) return <td className="blame" />;
                    const t = (new Date(r.date).getTime() - blameAt.min) / Math.max(1, blameAt.max - blameAt.min);
                    return (
                      <td className="blame start" style={{ ['--age' as string]: String(t) }}>
                        <button
                          type="button"
                          className="blame-btn"
                          title={`${r.sha.slice(0, 8)} · ${r.author} · ${r.date.slice(0, 10)}\n${r.summary}`}
                          aria-label={`Open commit ${r.sha.slice(0, 7)} by ${r.author} on ${r.date.slice(0, 10)}: ${r.summary}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onBlameClick?.(r.sha);
                          }}
                        >
                          <span className="who">{initials(r.author)}</span>
                          <span className="when">{age(r.date)}</span>
                        </button>
                      </td>
                    );
                  })()}
                  <td className="ln">{n}</td>
                  <td dangerouslySetInnerHTML={{ __html: l || ' ' }} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
