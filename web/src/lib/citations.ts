// Citation links in model-written markdown (pure, so it can be tested without a browser).

// `[path:12]`, `[path:12-30]` or `[path]`. Not `[text](url)` or `[text][ref]`, which are already links.
const CITE_RE = /\[([^\]\s:()[]+?\.[\w]+|[^\]\s:()[]+?\/[^\]\s:()[]+?)(?::(\d+)(?:-(\d+))?)?\](?![([])/g;
// Before the repository's file list is known, a bracketed name without line numbers counts as a
// file only if it has a folder or a familiar source or config extension.
const FILE_EXT = /\.(?:[cm]?[jt]sx?|py|pyi|rb|go|rs|java|kt|kts|scala|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|cs|fs|php|pl|lua|r|dart|ex|exs|erl|clj|elm|hs|ml|vue|svelte|astro|sh|bash|zsh|ps1|sql|graphql|gql|proto|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|md|mdx|rst|txt|html?|css|scss|sass|less|xml|gradle|tf|hcl|dockerfile|mk|cmake)$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// A link reference definition: `[label]: destination` with an optional quoted title.
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*(?:<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const INLINE_CODE = /(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2(?!`)/g;

/**
 * Turn `[path:1-2]` and `[path]` citations into links the renderer can make clickable. Code (fenced
 * blocks and inline spans), reference links and their definitions are left alone. `isFile`, when
 * the repository's file list is known, decides whether a citation without line numbers is a file
 * (so `[Node.js]` or `[and/or]` stay text); citations with line numbers are always linked.
 */
export function linkCitations(md: string, isFile?: (path: string) => boolean): string {
  const lines = md.split('\n');
  const labels = new Set(lines.map((l) => DEFINITION.exec(l)?.[1].toLowerCase()).filter(Boolean));
  const looksLikeFile = (p: string) => (isFile ? isFile(p) : p.includes('/') || FILE_EXT.test(p));
  const link = (text: string) =>
    text.replace(CITE_RE, (m, p: string, s?: string, e?: string) => {
      if (!s && (labels.has(p.toLowerCase()) || !looksLikeFile(p))) return m;
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
  let fence: string | null = null;
  return lines
    .map((line) => {
      const f = FENCE.exec(line)?.[1];
      if (fence) {
        if (f && f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length)) fence = null;
        return line;
      }
      if (f) {
        fence = f;
        return line;
      }
      return DEFINITION.test(line) ? line : linkLine(line);
    })
    .join('\n');
}
