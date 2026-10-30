import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRepo } from '../lib/repoContext';

const CITE_RE = /\[([^\]\s:]+?\.[\w]+|[^\]\s:]+?\/[^\]\s:]+?):(\d+)(?:-(\d+))?\]/g;
const PATH_LIKE = /^((?:[\w@.~-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?:-(\d+))?)?$/;

/** Turn `[path:1-2]` citations into links the renderer can make clickable. */
function preprocess(md: string): string {
  return md.replace(CITE_RE, (_m, p, s, e) => `[${p}:${s}${e ? `-${e}` : ''}](cite:${encodeURIComponent(p)}:${s}:${e ?? s})`);
}

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
              const [, p, s, e] = href.split(':');
              return (
                <button className="cite" onClick={() => openCode(decodeURIComponent(p), Number(s), Number(e))}>
                  {kids}
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
        {preprocess(children)}
      </ReactMarkdown>
    </div>
  );
}
