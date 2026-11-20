import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { unwrapMarkdown } from '@cq/shared';
import { linkCitations, pathResolver } from '../lib/citations';
import { useRepo } from '../lib/repoContext';

const PATH_LIKE = /^((?:[\w@.~-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?:-(\d+))?)?$/;

const lineOf = (v?: string) => (v ? Number(v) : undefined);

export function Markdown({ children }: { children: string }) {
  const { openCode, paths } = useRepo();
  const md = String(unwrapMarkdown(children));
  const resolve = pathResolver(paths, md);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith('cite:') ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children: kids }) {
            if (href?.startsWith('cite:')) {
              const [, enc, s, e, label] = href.split(':');
              const p = decodeURIComponent(enc);
              // Label as the citation was written (as link text, `__init__.py` would render as bold
              // "init"); the full path is in the tooltip.
              return (
                <button className="cite" title={p} onClick={() => openCode(p, lineOf(s), lineOf(e))}>
                  {label ? decodeURIComponent(label) : s ? `${p}:${s}${e && e !== s ? `-${e}` : ''}` : p}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {kids}
              </a>
            );
          },
          code({ className, children: kids }) {
            const text = String(kids ?? '');
            if (!className && !text.includes('\n')) {
              const m = text.match(PATH_LIKE);
              // With the file list, link what resolves to a file (`App.tsx:12` included); before it
              // loads, only what looks like a path.
              const target = m && (resolve ? resolve(m[1]) : text.includes('/') || m[2] ? m[1] : null);
              if (m && target) {
                const [, , s, e] = m;
                return (
                  <button className="cite" title={target} onClick={() => openCode(target, lineOf(s), lineOf(e ?? s))}>
                    {text}
                  </button>
                );
              }
            }
            return <code className={className}>{kids}</code>;
          },
        }}
      >
        {linkCitations(md, resolve)}
      </ReactMarkdown>
    </div>
  );
}
