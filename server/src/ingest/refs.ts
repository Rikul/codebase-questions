import path from 'node:path';
import type { ImportGraph } from './graph.js';
import type { FileFacts, SymbolRef } from './parse.js';
import { enclosingSymbol } from './parse.js';

/** One occurrence of a known name, resolved (when possible) to its definition. */
export interface RefRow {
  name: string;
  path: string;
  line: number;
  kind: 'call' | 'import' | 'ref';
  /** Enclosing symbol at the reference site ("Class.method", a route, or null for top level). */
  fromSymbol: string | null;
  /** Definition file, or `pkg:<name>` for an external package. */
  targetPath: string | null;
  targetLine: number | null;
  confidence: 'local' | 'import' | 'unique' | 'name-only' | 'external';
}

interface Binding {
  local: string;
  imported: string; // 'default' | '*' | exported name
  spec: string;
  line: number;
}

const JS = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro']);
const COMMON = new Set(
  'get set id data value key name type args self this props state error err res req next ctx app main init run handle item items result results options config index list map then call apply bind log push length string number boolean object default module exports require import from return new'.split(' '),
);
const MAX_PER_FILE = 300;

/** Blank out strings and comments (keeping line structure) so identifiers in them are ignored. */
export function stripNonCode(src: string, lang: string | null): string {
  const out: string[] = [];
  const hashComments = lang === 'python' || lang === 'ruby' || lang === 'shellscript' || lang === 'perl' || lang === 'r';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (!hashComments && c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') out.push(' '), i++;
    } else if (!hashComments && c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) out.push(src[i] === '\n' ? '\n' : ' '), i++;
      out.push('  ');
      i += 2;
    } else if (hashComments && c === '#') {
      while (i < n && src[i] !== '\n') out.push(' '), i++;
    } else if (c === '"' || c === "'" || c === '`') {
      const triple = lang === 'python' && src.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      out.push(' '.repeat(close.length));
      i += close.length;
      while (i < n && !src.startsWith(close, i)) {
        if (src[i] === '\\') {
          out.push(' ');
          i++;
        }
        if (!triple && c !== '`' && src[i] === '\n') break; // unterminated string
        out.push(src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      out.push(' '.repeat(close.length));
      i += close.length;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

function jsBindings(src: string): Binding[] {
  const out: Binding[] = [];
  const lineOf = (idx: number) => src.slice(0, idx).split('\n').length;
  for (const m of src.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1];
    const line = lineOf(m.index!);
    const def = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (def && def[1] !== 'type') out.push({ local: def[1], imported: 'default', spec: m[2], line });
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) out.push({ local: ns[1], imported: '*', spec: m[2], line });
    const named = clause.match(/\{([^}]*)\}/);
    if (named)
      for (const part of named[1].split(',')) {
        const [imp, loc] = part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/);
        if (imp) out.push({ local: (loc ?? imp).trim(), imported: imp.trim(), spec: m[2], line });
      }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const line = lineOf(m.index!);
    if (m[1].startsWith('{')) {
      for (const part of m[1].slice(1, -1).split(',')) {
        const [imp, loc] = part.trim().split(/\s*:\s*/);
        if (imp) out.push({ local: (loc ?? imp).trim(), imported: imp.trim(), spec: m[2], line });
      }
    } else out.push({ local: m[1], imported: 'default', spec: m[2], line });
  }
  return out;
}

function pyBindings(src: string): Binding[] {
  const out: Binding[] = [];
  src.split('\n').forEach((l, i) => {
    let m = l.match(/^\s*from\s+([.\w]+)\s+import\s+\(?([^)#]+)/);
    if (m) {
      for (const part of m[2].split(',')) {
        const [imp, loc] = part.trim().split(/\s+as\s+/);
        if (imp && imp !== '*') out.push({ local: (loc ?? imp).trim(), imported: imp.trim(), spec: m[1], line: i + 1 });
      }
      return;
    }
    m = l.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
    if (m) out.push({ local: m[2] ?? m[1].split('.')[0], imported: '*', spec: m[1], line: i + 1 });
  });
  return out;
}

const qualified = (s: SymbolRef) => (s.parent ? `${s.parent}.${s.name}` : s.name);

export function buildRefs(
  files: { path: string; lang: string | null; content: string }[],
  facts: Map<string, FileFacts>,
  graph: ImportGraph,
): RefRow[] {
  // Repo-wide definitions by name.
  const defs = new Map<string, { path: string; sym: SymbolRef }[]>();
  for (const f of files) {
    for (const s of facts.get(f.path)?.symbols ?? []) {
      if (s.kind === 'route') continue;
      (defs.get(s.name) ?? defs.set(s.name, []).get(s.name)!).push({ path: f.path, sym: s });
    }
  }
  const tooCommon = (name: string) => COMMON.has(name) || name.length < 3 || (defs.get(name)?.length ?? 0) > 15;
  // Import edge lookup: file + line -> resolved target file.
  const edgeAt = new Map<string, string>();
  for (const e of graph.edges) edgeAt.set(`${e.from}:${e.line}`, e.to);

  const rows: RefRow[] = [];
  for (const f of files) {
    const fx = facts.get(f.path);
    if (!fx || !f.lang || !(JS.has(f.lang) || ['python', 'go', 'rust', 'java', 'kotlin', 'ruby', 'php', 'csharp', 'c', 'cpp', 'scala', 'swift'].includes(f.lang))) continue;
    const bindings = JS.has(f.lang) ? jsBindings(f.content) : f.lang === 'python' ? pyBindings(f.content) : [];
    const byLocal = new Map(bindings.map((b) => [b.local, b]));
    const importLines = new Set([...fx.imports.map((i) => i.line), ...bindings.map((b) => b.line)]);
    const ownDefs = new Map<string, SymbolRef>();
    for (const s of fx.symbols) if (s.kind !== 'route' && !ownDefs.has(s.name)) ownDefs.set(s.name, s);
    const defLines = new Set(fx.symbols.map((s) => `${s.name}:${s.line}`));

    const resolve = (name: string, viaDot: boolean): Pick<RefRow, 'targetPath' | 'targetLine' | 'confidence'> | null => {
      if (!viaDot) {
        const own = ownDefs.get(name);
        if (own) return { targetPath: f.path, targetLine: own.line, confidence: 'local' };
        const b = byLocal.get(name);
        if (b) {
          const target = edgeAt.get(`${f.path}:${b.line}`);
          if (target) {
            const syms = facts.get(target)?.symbols ?? [];
            const want = b.imported === 'default' || b.imported === '*' ? null : b.imported;
            const hit = want ? syms.find((s) => s.name === want) : syms.find((s) => s.exported) ?? null;
            return { targetPath: target, targetLine: hit?.line ?? 1, confidence: 'import' };
          }
          if (!b.spec.startsWith('.')) return { targetPath: `pkg:${b.spec}`, targetLine: null, confidence: 'external' };
        }
      }
      if (tooCommon(name)) return null;
      const cands = defs.get(name);
      if (!cands?.length) return null;
      if (viaDot && !cands.some((c) => c.sym.kind === 'method' || c.sym.kind === 'function')) return null;
      if (cands.length === 1) return { targetPath: cands[0].path, targetLine: cands[0].sym.line, confidence: viaDot ? 'name-only' : 'unique' };
      // Prefer the definition closest in the directory tree.
      const dir = path.posix.dirname(f.path);
      const best = [...cands].sort((a, b) => common(b.path, dir) - common(a.path, dir))[0];
      return { targetPath: best.path, targetLine: best.sym.line, confidence: 'name-only' };
    };

    const code = stripNonCode(f.content, f.lang).split('\n');
    let count = 0;
    for (let i = 0; i < code.length && count < MAX_PER_FILE; i++) {
      const l = code[i];
      if (l.length > 1500) continue;
      for (const m of l.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const name = m[0];
        const line = i + 1;
        if (defLines.has(`${name}:${line}`)) continue;
        const before = l.slice(0, m.index!);
        const after = l.slice(m.index! + name.length);
        const viaDot = /\.\s*$/.test(before) && !/\.\.\.\s*$/.test(before);
        if (viaDot && tooCommon(name)) continue;
        const known = ownDefs.has(name) || byLocal.has(name) || defs.has(name);
        if (!known) continue;
        const r = resolve(name, viaDot);
        if (!r) continue;
        const isImport = importLines.has(line);
        const kind: RefRow['kind'] = isImport ? 'import' : /^\s*\(/.test(after) || /\bnew\s+$/.test(before) || /^\s*`/.test(after) ? 'call' : 'ref';
        const enc = enclosingSymbol(fx.symbols, line);
        rows.push({ name, path: f.path, line, kind, fromSymbol: enc && !(enc.name === name && enc.line === line) ? qualified(enc) : null, ...r });
        if (++count >= MAX_PER_FILE) break;
      }
    }
  }
  return rows;
}

function common(a: string, dir: string): number {
  const x = a.split('/');
  const y = dir.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}
