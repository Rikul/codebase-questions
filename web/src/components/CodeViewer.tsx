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
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function CodeViewer({ code, lang, firstLine = 1, highlightStart, highlightEnd, full, title, actions }: Props) {
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
      <div className={`code-scroll shiki ${full ? 'full' : ''}`} ref={scrollRef}>
        <table className="code-table">
          <tbody>
            {lines.map((l, i) => {
              const n = firstLine + i;
              return (
                <tr key={i} data-ln={n} className={n >= hs && n <= he ? 'hl' : undefined}>
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
