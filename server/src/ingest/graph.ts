import path from 'node:path';
import type { FileFacts } from './parse.js';

export interface ResolvedEdge {
  from: string;
  to: string;
  line: number;
  kind: 'import';
}

export interface ImportGraph {
  edges: ResolvedEdge[];
  /** file -> external package names it imports */
  external: Map<string, Set<string>>;
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.d.ts'];
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'http', 'https', 'crypto', 'url', 'util', 'events', 'stream', 'child_process', 'net', 'tls', 'zlib',
  'buffer', 'process', 'assert', 'readline', 'worker_threads', 'cluster', 'dns', 'querystring', 'timers', 'vm', 'module',
]);

function packageName(spec: string): string {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function buildImportGraph(
  files: { path: string; lang: string | null }[],
  facts: Map<string, FileFacts>,
  manifests: Map<string, string>,
): ImportGraph {
  const all = new Set(files.map((f) => f.path));
  const byBase = new Map<string, string[]>();
  for (const p of all) {
    const b = path.posix.basename(p);
    (byBase.get(b) ?? byBase.set(b, []).get(b)!).push(p);
  }

  // Go module path (from go.mod) lets us resolve in-repo package imports.
  const goModules: { prefix: string; dir: string }[] = [];
  for (const [p, content] of manifests) {
    if (p.endsWith('go.mod')) {
      const m = content.match(/^module\s+(\S+)/m);
      if (m) goModules.push({ prefix: m[1], dir: path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p) });
    }
  }
  const goDirFiles = new Map<string, string[]>();
  for (const p of all) {
    if (p.endsWith('.go') && !p.endsWith('_test.go')) {
      const d = path.posix.dirname(p);
      (goDirFiles.get(d) ?? goDirFiles.set(d, []).get(d)!).push(p);
    }
  }

  // Common JS path aliases: "@/x", "~/x", "src/x".
  const jsRoots = ['', 'src/', 'app/', 'lib/'].filter((r) => r === '' || [...all].some((p) => p.startsWith(r)));

  const tryJs = (base: string): string | null => {
    const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    const cands = [base, ...JS_EXTS.map((e) => stripped + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
    for (const c of cands) if (all.has(c)) return c;
    return null;
  };

  const tryPy = (mod: string, fromDir: string): string | null => {
    let rel: string;
    if (mod.startsWith('.')) {
      const dots = mod.match(/^\.+/)![0].length;
      let dir = fromDir;
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      rel = path.posix.join(dir === '.' ? '' : dir, mod.slice(dots).replace(/\./g, '/'));
    } else rel = mod.replace(/\./g, '/');
    const roots = mod.startsWith('.') ? [''] : ['', 'src/', 'lib/', 'app/'];
    for (const r of roots) {
      for (const c of [`${r}${rel}.py`, `${r}${rel}/__init__.py`]) if (all.has(c.replace(/^\//, ''))) return c.replace(/^\//, '');
    }
    // `from pkg.mod import name` where name is a submodule is handled by the caller; also try parent.
    return null;
  };

  const edges: ResolvedEdge[] = [];
  const external = new Map<string, Set<string>>();
  const addExt = (f: string, pkg: string) => (external.get(f) ?? external.set(f, new Set()).get(f)!).add(pkg);

  for (const f of files) {
    const fx = facts.get(f.path);
    if (!fx) continue;
    const dir = path.posix.dirname(f.path);
    const seen = new Set<string>();
    for (const imp of fx.imports) {
      let target: string | null = null;
      const spec = imp.spec;
      const lang = f.lang ?? '';
      if (['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro'].includes(lang)) {
        if (spec.startsWith('.')) target = tryJs(path.posix.normalize(path.posix.join(dir, spec)));
        else if (/^[@~]\//.test(spec)) {
          for (const r of jsRoots) if ((target = tryJs(r + spec.slice(2)))) break;
        } else {
          for (const r of jsRoots.filter(Boolean)) if ((target = tryJs(r + spec))) break;
          if (!target) {
            const pkg = packageName(spec);
            if (!NODE_BUILTINS.has(pkg) && !pkg.startsWith('node:')) addExt(f.path, pkg);
          }
        }
      } else if (lang === 'python') {
        target = tryPy(spec, dir);
        if (!target && !spec.startsWith('.')) addExt(f.path, spec.split('.')[0]);
      } else if (lang === 'go') {
        const mod = goModules.find((g) => spec === g.prefix || spec.startsWith(g.prefix + '/'));
        if (mod) {
          const d = path.posix.join(mod.dir, spec.slice(mod.prefix.length + 1));
          target = goDirFiles.get(d)?.[0] ?? null;
        } else if (spec.includes('.')) addExt(f.path, spec.split('/').slice(0, 3).join('/'));
      } else if (lang === 'rust') {
        if (/^\w+$/.test(spec)) {
          // `mod foo;`
          for (const c of [`${dir}/${spec}.rs`, `${dir}/${spec}/mod.rs`]) if (all.has(c)) target = c;
        } else if (spec.startsWith('crate::') || spec.startsWith('super::')) {
          const segs = spec.split('::').slice(1);
          const srcRoot = f.path.includes('/src/') ? f.path.slice(0, f.path.indexOf('/src/') + 5) : f.path.startsWith('src/') ? 'src/' : '';
          for (let n = segs.length; n > 0 && !target; n--) {
            const rel = segs.slice(0, n).join('/');
            for (const c of [`${srcRoot}${rel}.rs`, `${srcRoot}${rel}/mod.rs`]) if (all.has(c)) target = c;
          }
        } else if (!['std', 'core', 'alloc', 'self'].includes(spec.split('::')[0])) addExt(f.path, spec.split('::')[0]);
      } else if (lang === 'java' || lang === 'kotlin' || lang === 'scala') {
        const rel = spec.replace(/\./g, '/');
        const base = rel.split('/').pop()!;
        const hit = [...(byBase.get(`${base}.java`) ?? []), ...(byBase.get(`${base}.kt`) ?? [])].find((p) => p.includes(rel));
        if (hit) target = hit;
        else if (!spec.startsWith('java.') && !spec.startsWith('javax.') && !spec.startsWith('kotlin.')) addExt(f.path, spec.split('.').slice(0, 2).join('.'));
      } else if (lang === 'ruby' || lang === 'php' || lang === 'c' || lang === 'cpp') {
        const rel = path.posix.normalize(path.posix.join(dir, spec));
        const cands = [rel, `${rel}.rb`, `${rel}.php`];
        target = cands.find((c) => all.has(c)) ?? byBase.get(path.posix.basename(spec))?.[0] ?? null;
      } else if (lang === 'csharp') {
        // Namespaces do not map to files reliably; skip.
      }
      if (target && target !== f.path && !seen.has(target)) {
        seen.add(target);
        edges.push({ from: f.path, to: target, line: imp.line, kind: 'import' });
      }
    }
  }
  return { edges, external };
}

// ---------- Module grouping ----------

const CONTAINER_DIRS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'services', 'internal', 'pkg', 'cmd', 'modules', 'crates', 'libs', 'source', 'main', 'java', 'kotlin', 'python', 'go']);
const NON_CODE_LANGS = new Set(['markdown', 'mdx', 'text', 'rst', 'json', 'jsonc', 'yaml', 'toml', 'ini', 'xml', 'dotenv', 'html', 'css', 'scss', 'less']);

export interface ModuleGroup {
  id: string; // directory prefix, e.g. "server/src/routes" or "(root)"
  files: string[];
  codeFiles: number;
}

/**
 * Group files into ~8-16 modules by recursively splitting the largest directories.
 * Produces a structure granular enough to diagram but small enough to reason about.
 */
export function groupModules(files: { path: string; lang: string | null }[], target = 14): ModuleGroup[] {
  type G = { prefix: string; files: { path: string; lang: string | null }[] };
  const groupAt = (items: G['files'], prefix: string): G[] => {
    const map = new Map<string, G['files']>();
    for (const f of items) {
      const rest = prefix ? f.path.slice(prefix.length + 1) : f.path;
      const seg = rest.includes('/') ? rest.split('/')[0] : '';
      const key = seg ? (prefix ? `${prefix}/${seg}` : seg) : prefix || '(root)';
      (map.get(key) ?? map.set(key, []).get(key)!).push(f);
    }
    return [...map.entries()].map(([k, v]) => ({ prefix: k, files: v }));
  };
  const code = (g: G) => g.files.filter((f) => f.lang && !NON_CODE_LANGS.has(f.lang) && !/(^|\/)(tests?|__tests__|spec)\//.test(f.path)).length;
  const anyCode = (g: G) => g.files.filter((f) => f.lang && !NON_CODE_LANGS.has(f.lang)).length;

  let groups = groupAt(files, '');
  // Descend through container directories like src/ or packages/.
  let changed = true;
  while (changed) {
    changed = false;
    groups.sort((a, b) => code(b) - code(a));
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const leaf = g.prefix.split('/').pop()!;
      const canSplit = g.prefix !== '(root)' && g.files.some((f) => f.path.slice(g.prefix.length + 1).includes('/'));
      const sub = canSplit ? groupAt(g.files, g.prefix) : [];
      const subCode = sub.filter((s) => code(s) > 0).length;
      const isContainer = CONTAINER_DIRS.has(leaf) && subCode >= 1;
      const tooBig = groups.length < target && subCode >= 2 && code(g) > 3;
      if (canSplit && (isContainer || tooBig) && groups.length - 1 + sub.length <= target + 6) {
        groups.splice(i, 1, ...sub);
        changed = true;
        break;
      }
    }
  }
  // Fold groups with no code into "(root)"-adjacent config/docs buckets.
  const result: ModuleGroup[] = [];
  const misc: string[] = [];
  for (const g of groups) {
    const c = code(g);
    if (anyCode(g) === 0 && g.prefix !== '(root)') misc.push(...g.files.map((f) => f.path));
    else result.push({ id: g.prefix, files: g.files.map((f) => f.path), codeFiles: c || anyCode(g) });
  }
  if (misc.length) {
    const root = result.find((r) => r.id === '(root)');
    if (root) root.files.push(...misc);
    else result.push({ id: '(root)', files: misc, codeFiles: 0 });
  }
  return result.sort((a, b) => b.codeFiles - a.codeFiles);
}

export function moduleOf(groups: ModuleGroup[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of groups) for (const f of g.files) m.set(f, g.id);
  return m;
}

export interface ModuleEdge {
  from: string;
  to: string;
  count: number;
  samples: { path: string; line: number; target: string }[];
}

export function moduleEdges(edges: ResolvedEdge[], fileToModule: Map<string, string>): ModuleEdge[] {
  const map = new Map<string, ModuleEdge>();
  for (const e of edges) {
    const a = fileToModule.get(e.from);
    const b = fileToModule.get(e.to);
    if (!a || !b || a === b) continue;
    const k = `${a}\u0000${b}`;
    const me = map.get(k) ?? map.set(k, { from: a, to: b, count: 0, samples: [] }).get(k)!;
    me.count++;
    if (me.samples.length < 5) me.samples.push({ path: e.from, line: e.line, target: e.to });
  }
  return [...map.values()].sort((x, y) => y.count - x.count);
}

/** In-degree centrality used to prioritize files for LLM summarization. */
export function centrality(edges: ResolvedEdge[]): Map<string, number> {
  const c = new Map<string, number>();
  for (const e of edges) {
    c.set(e.to, (c.get(e.to) ?? 0) + 2);
    c.set(e.from, (c.get(e.from) ?? 0) + 1);
  }
  return c;
}
