// Citation links in model-written markdown (pure, so it can be tested without a browser).

// `[path:12]`, `[path:12-30]` or `[path]`. Not `[text](url)` or `[text][ref]`, which are already links.
const CITE_RE = /\[([^\]\s:()[]+?\.[\w]+|[^\]\s:()[]+?\/[^\]\s:()[]+?)(?::(\d+)(?:-(\d+))?)?\](?![([])/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// A link reference definition: `[label]: destination` with an optional quoted title. Only a
// destination that looks like a URL or path counts, so `[setup.py]: Config` reads as a citation.
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*(?:<[^>]*>|(?:[a-z][\w+.-]*:\/\/|mailto:|\.{0,2}\/|#)\S*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/i;
const INLINE_CODE = /(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2(?!`)/g;

/**
 * Turn `[path:1-2]` and `[path]` citations into links the renderer can make clickable. Code (fenced
 * blocks and inline spans), reference links and their definitions are left alone. A citation
 * without line numbers is linked only when `isFile` (the repository's file list) knows the path,
 * so `[Node.js]` or `[and/or]` stay text, and nothing is guessed before the list has loaded.
 * Citations with line numbers are always linked.
 */
export function linkCitations(md: string, isFile?: (path: string) => boolean): string {
  const lines = md.split('\n');
  // Which lines are code (a fence line or inside a fenced block): never rewritten, and their
  // `[label]: url` lines are not reference definitions.
  let fence: string | null = null;
  const code = lines.map((line) => {
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length)) fence = null;
      return true;
    }
    if (f) fence = f;
    return Boolean(f);
  });
  const labels = new Set(lines.filter((_l, i) => !code[i]).map((l) => DEFINITION.exec(l)?.[1].toLowerCase()).filter(Boolean));
  const link = (text: string) =>
    text.replace(CITE_RE, (m, p: string, s?: string, e?: string) => {
      if (!s && (labels.has(p.toLowerCase()) || !isFile?.(p))) return m;
      const label = s ? `${p}:${s}${e ? `-${e}` : ''}` : p;
      return `[${label}](cite:${encodeURIComponent(p)}:${s ?? ''}:${e ?? s ?? ''})`;
    });
  // Rewrite only outside inline code spans.
  const linkLine = (line: string) => {
    let out = '';
    let last = 0;
    for (const c of line.matchAll(INLINE_CODE)) {
      out += link(line.slice(last, c.index)) + c[0];
      last = c.index! + c[0].length;
    }
    return out + link(line.slice(last));
  };
  return lines.map((line, i) => (code[i] || DEFINITION.test(line) ? line : linkLine(line))).join('\n');
}
