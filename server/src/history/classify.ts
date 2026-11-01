import pLimit from 'p-limit';
import { z } from 'zod';
import { COMMIT_TYPES } from '@cq/shared';
import type { DB } from '../db/index.js';
import { jsonWithFallback } from '../llm/index.js';
import type { LLMProvider } from '../llm/index.js';

// Commits the rules in types.ts could not classify ('other') are sent to the model in batches by
// subject. Offline, or if a call fails, they stay 'other'. Types are kept across re-analysis.

const BATCH = 80;
const MAX = 1500;

const TypesSchema = z.object({
  types: z.array(z.object({ i: z.number().int(), type: z.enum(COMMIT_TYPES).catch('other') })),
});

export async function classifyCommits(db: DB, llm: LLMProvider, repoId: string, opts: { concurrency: number; warn?: (m: string) => void; progress?: (done: number, total: number) => void }): Promise<number> {
  if (llm.name === 'mock') return 0;
  const todo = db
    .prepare(`SELECT sha, subject, body FROM commits WHERE repo_id=? AND coalesce(type,'other')='other' AND coalesce(type_source,'rule')='rule' ORDER BY seq LIMIT ?`)
    .all(repoId, MAX) as { sha: string; subject: string; body: string | null }[];
  if (!todo.length) return 0;
  const upd = db.prepare(`UPDATE commits SET type=?, type_source='llm' WHERE repo_id=? AND sha=?`);
  const limit = pLimit(Math.max(1, opts.concurrency));
  let done = 0;
  let classified = 0;
  const batches: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        const lines = batch.map((c, i) => `${i}. ${c.subject.slice(0, 160)}${c.body ? ` — ${c.body.split('\n')[0].slice(0, 120)}` : ''}`);
        const res = await jsonWithFallback(
          llm,
          {
            name: 'commit_types',
            fast: true,
            maxTokens: 14 * batch.length + 200,
            system: `Classify git commits by their message. Types: feat (new feature or capability), fix (bug fix), refactor (restructuring or performance without new behaviour), chore (build, CI, dependencies, releases, merges, tooling), docs (documentation), test (tests only), other (cannot tell). Return one entry per numbered commit as {i, type}.`,
            messages: [{ role: 'user', content: lines.join('\n') }],
            schema: TypesSchema,
            heuristic: () => ({ types: [] }),
          },
          opts.warn,
        );
        db.transaction(() => {
          for (const r of res.types) {
            const c = batch[r.i];
            if (!c) continue;
            // 'other' answers are stored too, so the same commits are not sent again on re-analysis.
            upd.run(r.type, repoId, c.sha);
            if (r.type !== 'other') classified++;
          }
        })();
        done += batch.length;
        opts.progress?.(done, todo.length);
      }),
    ),
  );
  return classified;
}
