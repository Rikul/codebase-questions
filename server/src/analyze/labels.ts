import pLimit from 'p-limit';
import { z } from 'zod';
import type { Architecture } from '@cq/shared';
import { jsonWithFallback } from '../llm/index.js';
import type { RepoContext } from './context.js';

// The diagram's structure and static names come from the code. The model only adds a readable
// label and a one-line summary per component, so "github.com/acme/app/v2" or "Standard" also
// say what they are. Without a model (or if a call fails) components keep just their static names.

const LabelsSchema = z.object({
  components: z.array(
    z.object({
      id: z.string(),
      label: z.string().describe('2-4 word Title Case name for what this component does, e.g. "HTTP Server Core", "Config Loader"'),
      summary: z.string().describe('One sentence: what this component is responsible for'),
    }),
  ),
});

const BATCH = 40;

export async function annotateComponents(ctx: RepoContext, arch: Architecture, concurrency: number): Promise<Architecture> {
  if (ctx.llm.name === 'mock') return arch;
  const byId = new Map(arch.components.map((c) => [c.id, c]));
  const children = new Map<string, string[]>();
  for (const c of arch.components) if (c.parentId) (children.get(c.parentId) ?? children.set(c.parentId, []).get(c.parentId)!).push(c.name);
  // External systems (databases, APIs) already have descriptive names.
  const targets = arch.components.filter((c) => c.paths.length || children.has(c.id));
  if (!targets.length) return arch;

  const describe = (id: string) => {
    const c = byId.get(id)!;
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    const files = (c.keyFiles ?? []).map((f) => `    - ${f}: ${(ctx.summaries.get(f) ?? '').replace(/\s+/g, ' ').slice(0, 220)}`);
    return [
      `- id: ${c.id}`,
      `  static name: ${c.name}`,
      `  path: ${c.paths[0] ?? '(repository root)'} · type: ${c.type}${parent ? ` · inside: ${parent.name}` : ''}`,
      children.has(c.id) ? `  contains: ${children.get(c.id)!.slice(0, 10).join(', ')}` : '',
      c.techStack?.length ? `  uses: ${c.techStack.join(', ')}` : '',
      files.length ? `  key files:\n${files.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const batches: string[][] = [];
  for (let i = 0; i < targets.length; i += BATCH) batches.push(targets.slice(i, i + BATCH).map((c) => c.id));
  const limit = pLimit(Math.max(1, concurrency));
  const found = new Map<string, { label: string; summary: string }>();
  let done = 0;
  await Promise.all(
    batches.map((ids) =>
      limit(async () => {
        const res = await jsonWithFallback(
          ctx.llm,
          {
            name: 'component_labels',
            fast: true,
            maxTokens: 120 * ids.length + 400,
            system:
              'You name the boxes of a codebase architecture diagram. Each component is a package or directory, found by static analysis. For each one, write a short label saying what it does (2-4 words, Title Case, no file paths, no package or module paths, no words like "module" or "package" unless needed) and a one-sentence summary. Base both on the key files and what the component contains; do not invent features. Return every id you were given.',
            messages: [{ role: 'user', content: `Repository: ${ctx.repoName}\n\nComponents:\n${ids.map(describe).join('\n')}` }],
            schema: LabelsSchema,
            heuristic: () => ({ components: [] }),
          },
          ctx.warn,
        );
        for (const r of res.components) {
          const label = r.label.replace(/\s+/g, ' ').trim().slice(0, 40);
          if (byId.has(r.id) && label) found.set(r.id, { label, summary: r.summary.replace(/\s+/g, ' ').trim().slice(0, 300) });
        }
        done += ids.length;
        ctx.progress(`Named ${done}/${targets.length} components`, done / targets.length);
      }),
    ),
  );
  if (!found.size) return arch;
  return {
    ...arch,
    components: arch.components.map((c) => {
      const a = found.get(c.id);
      // Keep the static name visible: a label that only repeats it adds nothing.
      return a && a.label.toLowerCase() !== c.name.toLowerCase() ? { ...c, label: a.label, summary: a.summary } : a ? { ...c, summary: a.summary } : c;
    }),
  };
}
