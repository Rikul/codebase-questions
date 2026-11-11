import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { unwrapMarkdown } from '@cq/shared';
import { linkCitations } from '../lib/citations';
import { useRepo } from '../lib/repoContext';

const PATH_LIKE = /^((?:[\w@.~-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?:-(\d+))?)?$/;

const lineOf = (v?: string) => (v ? Number(v) : undefined);

export function Markdown({ children }: { children: string }) {
  const { openCode } = useRepo();
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith('cite:') ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children: kids }) {
            if (href?.startsWith('cite:')) {
              const [, enc, s, e] = href.split(':');
              const p = decodeURIComponent(enc);
              // Label from the path itself: as link text, `__init__.py` would render as bold "init".
              return (
                <button className="cite" onClick={() => openCode(p, lineOf(s), lineOf(e))}>
                  {s ? `${p}:${s}${e && e !== s ? `-${e}` : ''}` : p}
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
              if (m && (text.includes('/') || m[2])) {
                const [, p, s, e] = m;
                return (
                  <button className="cite" onClick={() => openCode(p, s ? Number(s) : undefined, e ? Number(e) : s ? Number(s) : undefined)}>
                    {text}
                  </button>
                );
              }
            }
            return <code className={className}>{kids}</code>;
          },
        }}
      >
        {linkCitations(String(unwrapMarkdown(children)))}
      </ReactMarkdown>
    </div>
  );
}
