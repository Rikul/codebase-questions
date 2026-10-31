import { z } from 'zod';
import { defaultView } from '@cq/shared';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import type { AgentTool } from '../llm/agent.js';
import type { EmbeddingProvider } from '../llm/index.js';
import { retrieve } from '../qa/retrieve.js';
import { fileContent, getArchitecture } from '../routes/queries.js';
import { fileHistory } from '../history/index.js';
import { safeGitPath } from '../history/git.js';
import { blame, commitDetails, searchHistory, symbolHistory } from '../history/symbol.js';

const MAX_READ_LINES = 400;

export interface SymbolRow {
  path: string;
  name: string;
  kind: string;
  line: number;
  endLine: number;
  exported: boolean;
  parent: string | null;
  signature: string | null;
}

/** Repo-scoped, read-only data access shared by tools, explainers and diagrams. */
export class RepoIndex {
  constructor(readonly db: DB, readonly repoId: string, readonly embeddings: EmbeddingProvider | null = null) {}

  hasFile(path: string) {
    return Boolean(this.db.prepare('SELECT 1 FROM files WHERE repo_id=? AND path=?').get(this.repoId, path));
  }

  normalize(path: string): string {
    const p = String(path ?? '').replace(/^\.?\//, '').replace(/:(\d+)(-\d+)?$/, '');
    if (p.includes('..')) throw new Error('Paths must be relative to the repository root and may not contain ".."');
    return p;
  }

  requireFile(path: string): string {
    const p = this.normalize(path);
    if (this.hasFile(p)) return p;
    const hit = this.db.prepare(`SELECT path FROM files WHERE repo_id=? AND path LIKE ? ORDER BY length(path) LIMIT 1`).get(this.repoId, `%/${p}`) as { path: string } | undefined;
    if (hit) return hit.path;
    throw new Error(`No such file: ${p}. Use list_dir or search_code to find the right path.`);
  }

  content(path: string): string {
    const c = fileContent(this.db, this.repoId, this.requireFile(path));
    if (c == null) throw new Error(`Content unavailable for ${path}`);
    return c;
  }

  fileRow(path: string): any {
    return this.db.prepare('SELECT path, lang, lines, summary, hash, meta FROM files WHERE repo_id=? AND path=?').get(this.repoId, path);
  }

  symbols(path: string): SymbolRow[] {
    return (this.db.prepare('SELECT * FROM symbols WHERE repo_id=? AND path=? ORDER BY line').all(this.repoId, path) as any[]).map((s) => ({
      path: s.path,
      name: s.name,
      kind: s.kind,
      line: s.line,
      endLine: s.end_line ?? s.line,
      exported: Boolean(s.exported),
      parent: s.parent,
      signature: s.signature,
    }));
  }

  /** Innermost symbol in a file by name and/or containing line. */
  findSymbol(path: string, name?: string, line?: number): SymbolRow | undefined {
    const syms = this.symbols(path);
    const base = name?.split('.').pop();
    const byName = base ? syms.filter((s) => s.name === base || `${s.parent}.${s.name}` === name) : [];
    if (byName.length) return line ? byName.sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0] : byName[0];
    if (line) {
      let best: SymbolRow | undefined;
      for (const s of syms) if (s.line <= line && s.endLine >= line && (!best || s.line >= best.line)) best = s;
      return best;
    }
    return undefined;
  }

  read(path: string, start?: number, end?: number) {
    const p = this.requireFile(path);
    const lines = this.content(p).split('\n');
    const s = Math.max(1, start ?? 1);
    const e = Math.min(lines.length, end ?? s + MAX_READ_LINES - 1, s + MAX_READ_LINES - 1);
    const body = lines
      .slice(s - 1, e)
      .map((l, i) => `${String(s + i).padStart(5)}| ${l}`)
      .join('\n');
    return { path: p, startLine: s, endLine: e, totalLines: lines.length, text: body };
  }

  references(name: string, targetPath?: string, limit = 60) {
    const base = name.split('.').pop()!;
    const rows = (targetPath
      ? this.db.prepare(`SELECT * FROM refs WHERE repo_id=? AND name=? AND (target_path=? OR (target_path IS NULL)) AND kind != 'import' ORDER BY path, line LIMIT ?`).all(this.repoId, base, targetPath, limit)
      : this.db.prepare(`SELECT * FROM refs WHERE repo_id=? AND name=? AND kind != 'import' ORDER BY path, line LIMIT ?`).all(this.repoId, base, limit)) as any[];
    return rows.map((r) => ({ path: r.path, line: r.line, kind: r.kind, inSymbol: r.from_symbol, confidence: r.confidence, code: this.lineAt(r.path, r.line) }));
  }

  /** Callees: references made inside a line range of a file. */
  callsWithin(path: string, start: number, end: number) {
    const rows = this.db
      .prepare(`SELECT name, kind, line, target_path, target_line, confidence FROM refs WHERE repo_id=? AND path=? AND line BETWEEN ? AND ? AND kind != 'import' ORDER BY line`)
      .all(this.repoId, path, start, end) as any[];
    const seen = new Set<string>();
    return rows
      .filter((r) => {
        const k = `${r.name}|${r.target_path}|${r.line}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 80)
      .map((r) => ({ name: r.name, kind: r.kind, line: r.line, target: r.target_path, targetLine: r.target_line, confidence: r.confidence }));
  }

  importers(path: string) {
    return this.db.prepare(`SELECT src AS path, line FROM file_edges WHERE repo_id=? AND dst=? AND kind='import' ORDER BY src`).all(this.repoId, path) as { path: string; line: number }[];
  }

  imports(path: string) {
    return (this.db.prepare(`SELECT dst, line, kind FROM file_edges WHERE repo_id=? AND src=? ORDER BY line`).all(this.repoId, path) as any[]).map((r) =>
      r.kind === 'package' ? { package: r.dst.slice(4) } : { path: r.dst, line: r.line },
    );
  }

  /** Shortest importer chains from the file up to entry points (how it gets loaded). */
  importerChains(path: string, maxChains = 3): string[][] {
    const entries = new Set(
      (this.db.prepare(`SELECT path FROM files WHERE repo_id=? AND json_extract(meta,'$.isEntry')=1 AND coalesce(json_extract(meta,'$.isTest'),0)=0`).all(this.repoId) as any[]).map((r) => r.path),
    );
    const edges = this.db.prepare(`SELECT src, dst FROM file_edges WHERE repo_id=? AND kind='import'`).all(this.repoId) as { src: string; dst: string }[];
    const importersOf = new Map<string, string[]>();
    for (const e of edges) (importersOf.get(e.dst) ?? importersOf.set(e.dst, []).get(e.dst)!).push(e.src);
    const chains: string[][] = [];
    const prev = new Map<string, string | null>([[path, null]]);
    const queue = [path];
    while (queue.length && chains.length < maxChains) {
      const cur = queue.shift()!;
      if (cur !== path && entries.has(cur)) {
        const chain: string[] = [];
        for (let n: string | null = cur; n; n = prev.get(n) ?? null) chain.push(n);
        chains.push(chain); // entry → … → file
        continue;
      }
      for (const imp of importersOf.get(cur) ?? []) {
        if (prev.has(imp)) continue;
        prev.set(imp, cur);
        queue.push(imp);
      }
    }
    return chains;
  }

  lineAt(path: string, line: number): string {
    try {
      return (this.content(path).split('\n')[line - 1] ?? '').trim().slice(0, 200);
    } catch {
      return '';
    }
  }

  grep(pattern: string, prefix?: string, ignoreCase = true, limit = 60) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (e) {
      throw new Error(`Invalid regex: ${(e as Error).message}`);
    }
    const rows = (prefix
      ? this.db.prepare(`SELECT path, start_line, content FROM chunks WHERE repo_id=? AND path LIKE ? ORDER BY path, start_line`).all(this.repoId, `${this.normalize(prefix)}%`)
      : this.db.prepare(`SELECT path, start_line, content FROM chunks WHERE repo_id=? ORDER BY path, start_line`).all(this.repoId)) as any[];
    const out: { path: string; line: number; code: string }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const lines = String(r.content).split('\n');
      for (let i = 0; i < lines.length && out.length < limit; i++) {
        if (!re.test(lines[i])) continue;
        const k = `${r.path}:${r.start_line + i}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ path: r.path, line: r.start_line + i, code: lines[i].trim().slice(0, 200) });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  fileInfo(path: string) {
    const p = this.requireFile(path);
    const f = this.fileRow(p);
    const meta = json<any>(f.meta, {});
    const comp = meta.component ? (this.db.prepare('SELECT id, name, type, description FROM components WHERE repo_id=? AND id=?').get(this.repoId, meta.component) as any) : null;
    return {
      path: p,
      lang: f.lang,
      lines: f.lines,
      summary: f.summary,
      isEntryPoint: Boolean(meta.isEntry),
      isTest: Boolean(meta.isTest),
      component: comp,
      routes: meta.routes ?? [],
      envVars: (meta.env ?? []).map((e: any) => e.detail),
      securitySignals: (meta.security ?? []).slice(0, 10).map((s: any) => ({ kind: s.kind, line: s.line })),
      infra: (meta.infra ?? []).map((s: any) => s.kind),
      imports: this.imports(p),
      importedBy: this.importers(p),
    };
  }
}

/** Tools exposed to the model. All read-only and confined to the repository. */
export function repoTools(ix: RepoIndex): AgentTool[] {
  return [
    {
      name: 'read_file',
      description: `Read a file (or a line range) with line numbers. At most ${MAX_READ_LINES} lines per call; request ranges for large files.`,
      schema: z.object({ path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() }),
      label: (i) => `Reading ${i.path}${i.start_line ? `:${i.start_line}-${i.end_line ?? ''}` : ''}`,
      run: async (i) => {
        const r = ix.read(i.path, i.start_line, i.end_line);
        return `${r.path} (lines ${r.startLine}-${r.endLine} of ${r.totalLines})\n${r.text}`;
      },
    },
    {
      name: 'list_dir',
      description: 'List files and subdirectories under a directory ("" for the root), with file summaries.',
      schema: z.object({ path: z.string().default('') }),
      label: (i) => `Listing ${i.path || '/'}`,
      run: async (i) => {
        const dir = ix.normalize(i.path ?? '').replace(/\/$/, '');
        const rows = ix.db.prepare(`SELECT path, lines, summary FROM files WHERE repo_id=? AND path LIKE ? ORDER BY path`).all(ix.repoId, dir ? `${dir}/%` : '%') as any[];
        const dirs = new Map<string, number>();
        const files: string[] = [];
        for (const r of rows) {
          const rest = dir ? r.path.slice(dir.length + 1) : r.path;
          if (rest.includes('/')) {
            const d = rest.split('/')[0];
            dirs.set(d, (dirs.get(d) ?? 0) + 1);
          } else files.push(`${r.path} (${r.lines} lines) — ${String(r.summary ?? '').slice(0, 160)}`);
        }
        return [...[...dirs].map(([d, n]) => `${dir ? dir + '/' : ''}${d}/ (${n} files)`), ...files].join('\n') || 'Empty or unknown directory';
      },
    },
    {
      name: 'search_code',
      description: 'Semantic/keyword search over the codebase. Returns the most relevant code chunks with line ranges.',
      schema: z.object({ query: z.string(), path_prefix: z.string().optional(), limit: z.number().int().max(12).optional() }),
      label: (i) => `Searching “${i.query}”`,
      run: async (i) => {
        const chunks = await retrieve(ix.db, ix.repoId, i.query, { category: 'onboarding', embeddings: ix.embeddings, limit: i.limit ?? 6, focusPaths: i.path_prefix ? [ix.normalize(i.path_prefix)] : undefined });
        return chunks
          .filter((c) => !i.path_prefix || c.path.startsWith(ix.normalize(i.path_prefix)))
          .map((c) => `### ${c.path}:${c.startLine}-${c.endLine}\n${c.content.split('\n').slice(0, 40).map((l, n) => `${String(c.startLine + n).padStart(5)}| ${l}`).join('\n')}`)
          .join('\n\n');
      },
    },
    {
      name: 'grep',
      description: 'Regex search across all files (line-level). Good for finding string literals, topic names, config keys, or exact identifiers.',
      schema: z.object({ pattern: z.string(), path_prefix: z.string().optional(), case_sensitive: z.boolean().optional() }),
      label: (i) => `Grep /${i.pattern}/${i.path_prefix ? ` in ${i.path_prefix}` : ''}`,
      run: async (i) => ix.grep(i.pattern, i.path_prefix, !i.case_sensitive),
    },
    {
      name: 'file_info',
      description: 'Metadata for a file: summary, component, entry/test flags, HTTP routes, env vars, security signals, imports and importers.',
      schema: z.object({ path: z.string() }),
      label: (i) => `Inspecting ${i.path}`,
      run: async (i) => ix.fileInfo(i.path),
    },
    {
      name: 'list_symbols',
      description: 'Functions, classes, methods, variables and route handlers defined in a file, with line ranges and signatures.',
      schema: z.object({ path: z.string() }),
      label: (i) => `Outlining ${i.path}`,
      run: async (i) => ix.symbols(ix.requireFile(i.path)),
    },
    {
      name: 'find_definition',
      description: 'Find where a name (function, class, variable) is defined in the repository.',
      schema: z.object({ name: z.string() }),
      label: (i) => `Finding definition of ${i.name}`,
      run: async (i) => {
        const base = i.name.split('.').pop();
        const rows = ix.db.prepare('SELECT path, name, kind, line, end_line, parent, signature, exported FROM symbols WHERE repo_id=? AND name=? LIMIT 20').all(ix.repoId, base) as any[];
        return rows.length ? rows : `No definition of ${i.name} indexed. Try grep.`;
      },
    },
    {
      name: 'find_references',
      description: 'Find call sites and other references to a name across the repo, with the enclosing function at each site. Pass path to restrict to references that resolve to the definition in that file.',
      schema: z.object({ name: z.string(), path: z.string().optional() }),
      label: (i) => `Finding references to ${i.name}`,
      run: async (i) => {
        const r = ix.references(i.name, i.path ? ix.requireFile(i.path) : undefined);
        return r.length ? r : `No indexed references to ${i.name}. It may be unused, used dynamically, or only referenced by string; try grep.`;
      },
    },
    {
      name: 'symbol_calls',
      description: 'What a function/class/method calls or references (its callees), resolved to definitions or external packages where possible.',
      schema: z.object({ path: z.string(), name: z.string() }),
      label: (i) => `Tracing calls from ${i.name}`,
      run: async (i) => {
        const p = ix.requireFile(i.path);
        const s = ix.findSymbol(p, i.name);
        if (!s) throw new Error(`${i.name} not found in ${p}; use list_symbols`);
        return { symbol: s, calls: ix.callsWithin(p, s.line, s.endLine) };
      },
    },
    {
      name: 'importer_chain',
      description: 'How a file gets loaded: shortest import chains from entry points down to this file.',
      schema: z.object({ path: z.string() }),
      label: (i) => `Tracing importers of ${i.path}`,
      run: async (i) => {
        const p = ix.requireFile(i.path);
        const chains = ix.importerChains(p);
        return chains.length ? chains.map((c) => c.join(' → ')) : `No import chain from an entry point reaches ${p} (it may be an entry point, a test, loaded dynamically, or unused).`;
      },
    },
    {
      name: 'file_history',
      description: 'Git history of a file (follows renames): when and by whom it was created, last changed, authors, and the commit list with subjects.',
      schema: z.object({ path: z.string() }),
      label: (i) => `Reading history of ${i.path}`,
      run: async (i) => {
        const h = fileHistory(ix.db, ix.repoId, ix.requireFile(i.path));
        if (!h.available) return h.reason;
        const shown = h.commits.slice(0, 40);
        return {
          ...h,
          totalCommits: h.commitCount,
          shownCommits: shown.length,
          note: shown.length < h.commitCount ? `Showing the ${shown.length} most recent of ${h.commitCount} commits; "created" is computed from all of them.` : undefined,
          commits: shown.map((c) => ({ sha: c.sha.slice(0, 10), date: c.date.slice(0, 10), author: c.author, status: c.status, path: c.path, subject: c.subject, added: c.added, deleted: c.deleted })),
        };
      },
    },
    {
      name: 'symbol_history',
      description: 'Git history of a function/class/method (tracks its line range over time) or of lines start_line..end_line. Returns the introducing commit, each change with a diff excerpt, and authors.',
      schema: z.object({ path: z.string(), name: z.string().optional(), start_line: z.number().int().optional(), end_line: z.number().int().optional() }),
      label: (i) => `Reading history of ${i.name ?? `${i.path}:${i.start_line}-${i.end_line ?? ''}`}`,
      run: async (i) => {
        const h = await symbolHistory(ix.db, ix.repoId, { path: i.path, name: i.name, start: i.start_line, end: i.end_line });
        if (!h.available) return h.reason;
        const shown = h.commits.slice(0, 25);
        return {
          ...h,
          shownCommits: shown.length,
          note: shown.length < h.totalCommits ? `Showing the ${shown.length} most recent of ${h.totalCommits} changes; "introduced" is computed from all of them.` : undefined,
          commits: shown.map((c) => ({ ...c, sha: c.sha.slice(0, 10), date: c.date.slice(0, 10), excerpt: c.excerpt.slice(0, 1200) })),
        };
      },
    },
    {
      name: 'blame',
      description: 'Who last changed each line of a range, and in which commit (git blame).',
      schema: z.object({ path: z.string(), start_line: z.number().int(), end_line: z.number().int() }),
      label: (i) => `Blaming ${i.path}:${i.start_line}-${i.end_line}`,
      run: async (i) => {
        const b = await blame(ix.db, ix.repoId, i.path, i.start_line, i.end_line);
        return b.available ? b.ranges.map((r) => ({ lines: `${r.start}-${r.end}`, sha: r.sha.slice(0, 10), author: r.author, date: r.date.slice(0, 10), summary: r.summary })) : b.reason;
      },
    },
    {
      name: 'commit_details',
      description: 'A commit: message, author, date, changed files, and its diff (optionally only for one path). Use to understand WHY something changed.',
      schema: z.object({ sha: z.string(), path: z.string().optional() }),
      label: (i) => `Reading commit ${String(i.sha).slice(0, 8)}`,
      run: async (i) => {
        const c = await commitDetails(ix.db, ix.repoId, i.sha, i.path ? safeGitPath(i.path) : undefined); // may be an old name
        return c.available ? { ...c, patch: c.patch.slice(0, 16_000) } : c.reason;
      },
    },
    {
      name: 'search_history',
      description: 'Find commits that added/removed a term in code (pickaxe) or mention it in their message. Good for "when was X added/removed?".',
      schema: z.object({ term: z.string(), path: z.string().optional() }),
      label: (i) => `Searching history for “${i.term}”`,
      run: async (i) => {
        const r = await searchHistory(ix.db, ix.repoId, i.term, i.path ? safeGitPath(i.path) : undefined);
        return r.available ? r : r.reason;
      },
    },
    {
      name: 'get_architecture',
      description: 'The component diagram as first shown (packages opened up to their modules): components with paths, parent and connections. Imports into widely used helper modules and edges implied by longer paths are left out.',
      schema: z.object({}),
      label: () => 'Reading architecture',
      run: async () => {
        const a = defaultView(getArchitecture(ix.db, ix.repoId));
        return {
          components: a.components.map((c) => ({ id: c.id, name: c.name, type: c.type, paths: c.paths, description: c.description, parentId: c.parentId })),
          connections: a.connections.map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, label: e.label, evidence: e.evidence.slice(0, 3) })),
        };
      },
    },
    {
      name: 'get_insights',
      description: 'Knowledge-base write-ups for a category: architecture, onboarding, security or api.',
      schema: z.object({ category: z.enum(['architecture', 'onboarding', 'security', 'api']) }),
      label: (i) => `Reading ${i.category} notes`,
      run: async (i) =>
        (ix.db.prepare('SELECT title, body_md FROM insights WHERE repo_id=? AND category=? ORDER BY position').all(ix.repoId, i.category) as any[])
          .map((r) => `## ${r.title}\n${String(r.body_md).slice(0, 2500)}`)
          .join('\n\n'),
    },
  ];
}
