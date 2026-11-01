import type { CommitListItem, RepoStats } from '@cq/shared';
import type { ScannedFile } from '../ingest/scan.js';
import type { Dependency, FileFacts } from '../ingest/parse.js';
import type { ImportGraph, ModuleEdge, ModuleGroup } from '../ingest/graph.js';
import type { LLMProvider } from '../llm/index.js';
import type { repoHistorySummary } from '../history/index.js';

/** Everything the analysis steps know about a repository after static ingestion. */
export interface RepoContext {
  repoName: string;
  files: ScannedFile[];
  fileByPath: Map<string, ScannedFile>;
  facts: Map<string, FileFacts>;
  deps: Dependency[];
  graph: ImportGraph;
  groups: ModuleGroup[];
  fileToModule: Map<string, string>;
  moduleEdges: ModuleEdge[];
  centrality: Map<string, number>;
  readme: string | null;
  summaries: Map<string, string>;
  llm: LLMProvider;
  /** Repo-level git history facts (null without history). */
  history?: ReturnType<typeof repoHistorySummary>;
  /** Size, languages and commit statistics, plus recent commits with their types (Repository insights). */
  repo?: { stats: RepoStats; recent: CommitListItem[] };
  warn: (msg: string) => void;
  progress: (message: string, fraction: number) => void;
}

export const NON_CODE = new Set(['markdown', 'mdx', 'text', 'rst', 'json', 'jsonc', 'yaml', 'toml', 'ini', 'xml', 'dotenv', 'html', 'css', 'scss', 'less', 'svg']);

export function isCode(f: { lang: string | null }): boolean {
  return Boolean(f.lang) && !NON_CODE.has(f.lang!);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '\n…[truncated]';
}

/** Compact directory tree (top levels) for prompts. */
export function dirTree(files: { path: string }[], maxDepth = 3, maxLines = 120): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let d = 1; d <= Math.min(maxDepth, parts.length - 1); d++) {
      const k = parts.slice(0, d).join('/') + '/';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (parts.length <= maxDepth) counts.set(f.path, 0);
  }
  const lines = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => {
      const depth = k.replace(/\/$/, '').split('/').length - 1;
      const name = k.replace(/\/$/, '').split('/').pop()! + (k.endsWith('/') ? `/ (${n} files)` : '');
      return `${'  '.repeat(depth)}${name}`;
    });
  return lines.length > maxLines ? lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more)` : lines.join('\n');
}

export function entryPoints(ctx: RepoContext): string[] {
  const secondary = (p: string) => (/(^|\/)(examples?|samples?|demos?|docs?|benchmarks?|scripts?)\//.test(p) ? 1 : 0);
  return ctx.files
    .filter((f) => ctx.facts.get(f.path)?.isEntry && !ctx.facts.get(f.path)?.isTest)
    .map((f) => f.path)
    .sort((a, b) => secondary(a) - secondary(b) || a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, 15);
}

export function allRoutes(ctx: RepoContext) {
  const out: { path: string; line: number; method: string; route: string }[] = [];
  for (const f of ctx.files) {
    const fx = ctx.facts.get(f.path);
    if (!fx || fx.isTest) continue;
    for (const r of fx.routes) out.push({ path: f.path, line: r.line, method: r.method, route: r.path });
  }
  return out;
}

export function packageScripts(ctx: RepoContext): Record<string, string> {
  const pkg = ctx.fileByPath.get('package.json');
  if (!pkg) return {};
  try {
    return JSON.parse(pkg.content).scripts ?? {};
  } catch {
    return {};
  }
}

/** Validate refs from the model: drop unknown paths, clamp line numbers. */
export function cleanRefs<T extends { path: string; startLine?: number; endLine?: number }>(ctx: RepoContext, refs: T[]): T[] {
  const out: T[] = [];
  for (const r of refs ?? []) {
    let p = r.path?.replace(/^\.?\//, '').replace(/:(\d+)(-\d+)?$/, '');
    if (!p) continue;
    let f = ctx.fileByPath.get(p);
    if (!f) {
      // Tolerate refs that point at a directory or a suffix of a real path.
      const hit = ctx.files.find((x) => x.path.endsWith('/' + p) || x.path.startsWith(p.replace(/\/$/, '') + '/'));
      if (!hit) continue;
      if (hit.path.endsWith('/' + p)) {
        p = hit.path;
        f = hit;
      } else {
        out.push({ ...r, path: p.replace(/\/$/, ''), startLine: undefined, endLine: undefined });
        continue;
      }
    }
    const max = f.lines;
    const s = r.startLine ? Math.min(Math.max(1, r.startLine), max) : undefined;
    const e = r.endLine ? Math.min(Math.max(s ?? 1, r.endLine), max) : s;
    out.push({ ...r, path: p, startLine: s, endLine: e });
  }
  return out;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'x';
}

/** First prose paragraphs of a README, without badges, headings, HTML or link definitions. */
export function readmeIntro(md: string, max = 600): string {
  const cleaned = md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/\[!\[[^\]]*\]\[[^\]]*\]\]\[[^\]]*\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^\[[^\]]+\]:\s*\S+.*$/gm, '');
  const paras = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#') && !p.startsWith('```') && !/^[-*|>]/.test(p) && p.replace(/[^A-Za-z]/g, '').length > 30);
  const text = paras.slice(0, 2).join(' ').replace(/\s+/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  return text.length > max ? text.slice(0, max).replace(/\s\S*$/, '') + '…' : text;
}
