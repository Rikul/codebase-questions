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
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g;

/** Wrap known identifiers inside highlighted line HTML with clickable spans. */
function markIdentifiers(html: string, idents: Set<string>): string {
  if (!idents.size || !/[A-Za-z_$]/.test(html)) return html;
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

export function CodeViewer({ code, lang, firstLine = 1, highlightStart, highlightEnd, full, title, actions, identifiers, onIdentifierClick, onExplainSelection, activeLine }: Props) {
  const [selection, setSelection] = useState<{ text: string; startLine: number; endLine: number; x: number; y: number } | null>(null);
  const plain = useMemo(() => code.split('\n').map(escapeHtml), [code]);
  const [lines, setLines] = useState<string[]>(plain);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines(plain);
    let cancelled = false;
    if (code.length > 400_000) return;
    highlight(code, lang).then((html) => {
      if (cancelled || !html) return;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ls = [...doc.querySelectorAll('.line')].map((l) => l.innerHTML);
      if (ls.length) setLines(ls);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, plain]);

  useEffect(() => {
    if (!highlightStart || !scrollRef.current) return;
    const row = scrollRef.current.querySelector<HTMLTableRowElement>(`tr[data-ln="${highlightStart}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [highlightStart, lines]);

  const rendered = useMemo(() => (identifiers && onIdentifierClick ? lines.map((l) => markIdentifiers(l, identifiers)) : lines), [lines, identifiers, onIdentifierClick]);

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
              const n = firstLine + i;
              return (
                <tr key={i} data-ln={n} className={[n >= hs && n <= he ? 'hl' : '', activeLine === n ? 'active' : ''].join(' ').trim() || undefined}>
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
