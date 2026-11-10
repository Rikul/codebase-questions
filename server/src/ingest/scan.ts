import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { DEFAULT_IGNORES } from '@cq/shared';

export interface ScannedFile {
  path: string; // posix, relative to repo root
  size: number;
  lang: string | null;
  hash: string;
  lines: number;
  content: string;
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', rb: 'ruby', php: 'php', cs: 'csharp', fs: 'fsharp', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', m: 'objective-c',
  dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang', clj: 'clojure', hs: 'haskell', ml: 'ocaml',
  lua: 'lua', r: 'r', jl: 'julia', pl: 'perl', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  ps1: 'powershell', sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  vue: 'vue', svelte: 'svelte', astro: 'astro', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml',
  md: 'markdown', mdx: 'mdx', rst: 'rst', txt: 'text', tf: 'hcl', hcl: 'hcl', gradle: 'groovy', groovy: 'groovy',
  zig: 'zig', nim: 'nim', sol: 'solidity', prisma: 'prisma',
};
const NAME_LANG: Record<string, string> = {
  dockerfile: 'docker', makefile: 'makefile', 'cmakelists.txt': 'cmake', gemfile: 'ruby', rakefile: 'ruby',
  procfile: 'text', jenkinsfile: 'groovy', '.env.example': 'dotenv', '.env.sample': 'dotenv',
};


export function detectLang(rel: string): string | null {
  const base = path.posix.basename(rel).toLowerCase();
  if (NAME_LANG[base]) return NAME_LANG[base];
  if (base.startsWith('dockerfile')) return 'docker';
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  return EXT_LANG[ext] ?? null;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface ScanOptions {
  maxFileBytes: number;
  maxFiles: number;
}

const defaultIgnore = ignore().add(DEFAULT_IGNORES);

/** True for paths the scanner never indexes (vendored, generated, binary or lock files). */
export function isIgnoredPath(rel: string): boolean {
  return defaultIgnore.ignores(rel);
}

export function scanRepo(root: string, opts: ScanOptions): ScannedFile[] {
  const gi = path.join(root, '.gitignore');
  // The repo's .gitignore adds to the defaults, so it needs its own instance.
  const ig = fs.existsSync(gi) ? ignore().add(DEFAULT_IGNORES).add(fs.readFileSync(gi, 'utf8')) : defaultIgnore;

  const out: ScannedFile[] = [];
  const stack: string[] = [''];
  while (stack.length && out.length < opts.maxFiles) {
    const rel = stack.pop()!;
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      // Never follow symlinks: they could point outside the repository.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!ig.ignores(`${childRel}/`)) stack.push(childRel);
        continue;
      }
      if (!e.isFile() || ig.ignores(childRel)) continue;
      const full = path.join(root, childRel);
      const size = fs.statSync(full).size;
      if (size > opts.maxFileBytes || size === 0) continue;
      const buf = fs.readFileSync(full);
      if (looksBinary(buf)) continue;
      const content = buf.toString('utf8');
      out.push({
        path: childRel,
        size,
        lang: detectLang(childRel),
        hash: crypto.createHash('sha1').update(buf).digest('hex'),
        lines: content.split('\n').length,
        content,
      });
      if (out.length >= opts.maxFiles) break;
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Resolve a user-supplied relative path inside root, rejecting traversal. */
export function safeJoin(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  const r = path.resolve(root);
  if (resolved !== r && !resolved.startsWith(r + path.sep)) return null;
  return resolved;
}
