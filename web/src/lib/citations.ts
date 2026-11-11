// Citation links in model-written markdown (pure, so it can be tested without a browser).

// `[path:12]`, `[path:12-30]` or `[path]`, but not `[text](url)`, which is already a link.
const CITE_RE = /\[([^\]\s:()]+?\.[\w]+|[^\]\s:()]+?\/[^\]\s:()]+?)(?::(\d+)(?:-(\d+))?)?\](?!\()/g;
// Without line numbers, a bracketed name is only a file if it has a folder or a familiar source or
// config extension (so `[v1.2]` or `[e.g.]` stay text).
const FILE_EXT = /\.(?:[cm]?[jt]sx?|py|pyi|rb|go|rs|java|kt|kts|scala|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|cs|fs|php|pl|lua|r|dart|ex|exs|erl|clj|elm|hs|ml|vue|svelte|astro|sh|bash|zsh|ps1|sql|graphql|gql|proto|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|md|mdx|rst|txt|html?|css|scss|sass|less|xml|gradle|tf|hcl|dockerfile|mk|cmake)$/i;

/** Turn `[path:1-2]` and `[path]` citations into links the renderer can make clickable. */
export function linkCitations(md: string): string {
  return md.replace(CITE_RE, (m, p: string, s?: string, e?: string) => {
    if (!s && !(p.includes('/') || FILE_EXT.test(p))) return m;
    const label = s ? `${p}:${s}${e ? `-${e}` : ''}` : p;
    return `[${label}](cite:${encodeURIComponent(p)}:${s ?? ''}:${e ?? s ?? ''})`;
  });
}
