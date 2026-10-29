import pLimit from 'p-limit';
import { z } from 'zod';
import { jsonWithFallback } from '../llm/index.js';
import type { RepoContext } from './context.js';
import { isCode, truncate } from './context.js';
import type { ScannedFile } from '../ingest/scan.js';

const SummariesSchema = z.object({
  files: z.array(z.object({ path: z.string(), summary: z.string() })),
});

/** Static one-paragraph description of a file, used offline and for low-priority files. */
export function heuristicSummary(ctx: RepoContext, f: ScannedFile): string {
  const fx = ctx.facts.get(f.path);
  const parts: string[] = [];
  const role = fx?.isTest ? 'Test file' : fx?.isEntry ? 'Entry point' : `${f.lang ?? 'Text'} file`;
  parts.push(`${role} (${f.lines} lines).`);
  const firstComment = f.content.match(/^\s*(?:\/\*\*?([\s\S]{10,400}?)\*\/|(?:(?:\/\/|#)\s?[^\n]{5,}\n){1,4}|"""([\s\S]{10,400}?)""")/);
  if (firstComment) {
    const txt = (firstComment[1] ?? firstComment[2] ?? firstComment[0]).replace(/^\s*(\*|\/\/|#)\s?/gm, '').replace(/\s+/g, ' ').trim();
    if (txt && !/copyright|license/i.test(txt)) parts.push(txt.slice(0, 240));
  }
  if (fx?.symbols.length) {
    const exp = fx.symbols.filter((s) => s.exported);
    const list = (exp.length ? exp : fx.symbols).slice(0, 8).map((s) => `${s.name} (${s.kind})`);
    parts.push(`${exp.length ? 'Exports' : 'Defines'}: ${list.join(', ')}${fx.symbols.length > 8 ? ', …' : ''}.`);
  }
  if (fx?.routes.length) parts.push(`HTTP routes: ${fx.routes.slice(0, 6).map((r) => `${r.method} ${r.path}`).join(', ')}.`);
  const ext = ctx.graph.external.get(f.path);
  if (ext?.size) parts.push(`Uses ${[...ext].slice(0, 6).join(', ')}.`);
  const infra = fx?.infra.map((i) => i.kind).filter((k) => k !== 'http-client');
  if (infra?.length) parts.push(`Touches ${[...new Set(infra)].join(', ')}.`);
  return parts.join(' ');
}

export function pickFilesForLlm(ctx: RepoContext, max: number): ScannedFile[] {
  const score = (f: ScannedFile) => {
    const fx = ctx.facts.get(f.path);
    let s = ctx.centrality.get(f.path) ?? 0;
    if (fx?.isEntry) s += 8;
    if (fx?.routes.length) s += 4 + fx.routes.length;
    if (fx?.security.length) s += 2;
    if (fx?.infra.length) s += 2;
    if (fx?.isTest) s -= 6;
    s += Math.min(4, f.lines / 100);
    if (/(^|\/)(examples?|docs?|scripts?|benchmarks?)\//.test(f.path)) s -= 2;
    return s;
  };
  return ctx.files
    .filter((f) => isCode(f) && f.lines >= 5)
    .map((f) => ({ f, s: score(f) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.f);
}

/**
 * Summarize the most important files with the LLM (batched, cached by content hash);
 * everything else gets a heuristic summary.
 */
export async function summarizeFiles(
  ctx: RepoContext,
  opts: { max: number; concurrency: number; cached: Map<string, { hash: string; summary: string }> },
): Promise<Set<string>> {
  for (const f of ctx.files) ctx.summaries.set(f.path, heuristicSummary(ctx, f));
  const picked = pickFilesForLlm(ctx, ctx.llm.name === 'mock' ? 0 : opts.max);
  /** Paths whose summary came from the model (fresh or cached). */
  const fromModel = new Set<string>();
  const todo: ScannedFile[] = [];
  for (const f of picked) {
    const c = opts.cached.get(f.path);
    if (c && c.hash === f.hash) {
      ctx.summaries.set(f.path, c.summary);
      fromModel.add(f.path);
    } else todo.push(f);
  }
  if (!todo.length) return fromModel;

  // Batch files up to ~28k characters per request.
  const batches: ScannedFile[][] = [];
  let cur: ScannedFile[] = [];
  let size = 0;
  for (const f of todo) {
    const len = Math.min(f.content.length, 12_000);
    if (cur.length && (size + len > 28_000 || cur.length >= 8)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += len;
  }
  if (cur.length) batches.push(cur);

  const limit = pLimit(opts.concurrency);
  let done = 0;
  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        const body = batch
          .map((f) => `=== FILE: ${f.path} (${f.lines} lines) ===\n${truncate(f.content, 12_000)}`)
          .join('\n\n');
        let failed = false;
        const res = await jsonWithFallback(
          ctx.llm,
          {
            name: 'file_summaries',
            fast: true,
            maxTokens: 400 * batch.length + 500,
            system:
              'You are a senior engineer documenting an unfamiliar codebase. For each file, write a dense 2-4 sentence summary: its responsibility, the key functions/classes it defines, what it depends on, and anything notable for security or integration (I/O, network, auth, persistence). Be specific; do not speculate beyond the code.',
            messages: [{ role: 'user', content: `Repository: ${ctx.repoName}\n\n${body}` }],
            schema: SummariesSchema,
            heuristic: () => ({ files: batch.map((f) => ({ path: f.path, summary: heuristicSummary(ctx, f) })) }),
          },
          (w) => {
            failed = true;
            ctx.warn(w);
          },
        );
        for (const s of res.files) {
          if (!ctx.fileByPath.has(s.path)) continue;
          ctx.summaries.set(s.path, s.summary);
          if (!failed) fromModel.add(s.path);
        }
        done += batch.length;
        ctx.progress(`Summarized ${done}/${todo.length} key files`, done / todo.length);
      }),
    ),
  );
  return fromModel;
}
