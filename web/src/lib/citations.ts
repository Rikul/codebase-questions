// Citation links in model-written markdown (pure, so it can be tested without a browser).

// `[path:12]`, `[path:12-30]`, `[path:12-30, 40]` or `[path]`. Not `[text](url)` or `[text][ref]`,
// which are already links.
const CITE_RE = /\[([^\]\s:()[]+?\.[\w]+|[^\]\s:()[]+?\/[^\]\s:()[]+?)(?::(\d+)(?:-(\d+))?((?:\s*,\s*\d+(?:-\d+)?)*))?\](?![([])/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// A link reference definition: `[label]: destination` with an optional quoted title. Only a
// destination that looks like a URL or path counts, so `[setup.py]: Config` reads as a citation.
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*(?:<[^>]*>|(?:[a-z][\w+.-]*:\/\/|mailto:|\.{0,2}\/|#)\S*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/i;
const INLINE_CODE = /(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2(?!`)/g;

/** Maps a cited path to a file in the repository, or null when it names none (or several). */
export type Resolve = (path: string) => string | null;

const byName = new WeakMap<Set<string>, Map<string, string[]>>();

/**
 * Resolve citations against the repository's files. Models often cite just `App.tsx:12` or a
 * partial path; that resolves to the one file whose path ends with it, or, when several do, to the
 * one whose full path appears elsewhere in the same text. Undefined while the list is unknown.
 */
export function pathResolver(paths: Set<string> | null, md: string): Resolve | undefined {
  if (!paths) return undefined;
  let index = byName.get(paths);
  if (!index) {
    index = new Map();
    for (const f of paths) {
      const name = f.slice(f.lastIndexOf('/') + 1);
      index.set(name, [...(index.get(name) ?? []), f]);
    }
    byName.set(paths, index);
  }
  const names = index;
  return (raw) => {
    const p = raw.replace(/^\.?\//, '');
    if (paths.has(p)) return p;
    const candidates = (names.get(p.slice(p.lastIndexOf('/') + 1)) ?? []).filter((f) => f.endsWith(`/${p}`));
    if (candidates.length === 1) return candidates[0];
    const mentioned = candidates.filter((f) => md.includes(f));
    return mentioned.length === 1 ? mentioned[0] : null;
  };
}

/** The `cite:` link target the renderer turns into a button: file, lines, and the label to show. */
export const citeHref = (path: string, s: string | undefined, e: string | undefined, label: string) =>
  `cite:${encodeURIComponent(path)}:${s ?? ''}:${e ?? s ?? ''}:${encodeURIComponent(label)}`;

/**
 * Turn `[path:1-2]` and `[path]` citations into links the renderer can make clickable. Code (fenced
 * blocks and inline spans), reference links and their definitions are left alone. With `resolve`
 * (the repository's file list), a citation is linked to the file it resolves to and left as text
 * when it resolves to none, so `[Node.js]` or a bare name shared by several files stay text.
 * Before the list is known, only citations with line numbers are linked, as written.
 */
export function linkCitations(md: string, resolve?: Resolve): string {
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
    text.replace(CITE_RE, (m, p: string, s?: string, e?: string, more?: string) => {
      if (!s && labels.has(p.toLowerCase())) return m;
      const target = resolve ? resolve(p) : s ? p : null;
      if (!target) return m;
      const label = s ? `${p}:${s}${e ? `-${e}` : ''}${(more ?? '').replace(/\s+/g, ' ')}` : p;
      return `[${label}](${citeHref(target, s, e, label)})`;
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
