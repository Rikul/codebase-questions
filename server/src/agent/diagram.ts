import type { Architecture, DiagramAnswer, DiagramEvent } from '@cq/shared';
import { DiagramAnswerSchema } from '@cq/shared';
import type { DB } from '../db/index.js';
import { AGENT_GUIDANCE } from '../llm/agent.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/index.js';
import { agentWithFallback } from '../llm/index.js';
import { getArchitecture } from '../routes/queries.js';
import { agentEventMapper } from './explain.js';
import { RepoIndex, repoTools } from './tools.js';

/** Answer a question by highlighting a path through the architecture diagram, with a guided tour. */
export async function answerOnDiagram(
  db: DB,
  llm: LLMProvider,
  embeddings: EmbeddingProvider | null,
  repoId: string,
  question: string,
  refresh: boolean,
  emit: (e: DiagramEvent) => void,
): Promise<void> {
  const q = question.trim().slice(0, 1000);
  if (!refresh) {
    const hit = db.prepare('SELECT content FROM diagram_answers WHERE repo_id=? AND question=?').get(repoId, q.toLowerCase()) as any;
    if (hit) return void emit({ type: 'result', answer: JSON.parse(hit.content), cached: true });
  }
  const ix = new RepoIndex(db, repoId, embeddings);
  const arch = getArchitecture(db, repoId);
  const res = await agentWithFallback(llm, {
    system: `You answer questions about a codebase by pointing at its architecture diagram. ${AGENT_GUIDANCE}
Investigate as needed, then submit_diagram_answer with: a concise markdown answer, the component and connection ids involved (ONLY ids from the diagram below), and an ordered tour (3-8 stops) that walks the path step by step with a caption per stop and a code ref where useful.`,
    messages: [
      {
        role: 'user',
        content: [
          `# Diagram components\n${arch.components.map((c) => `- ${c.id}: ${c.name} [${c.type}] ${c.paths.join(', ')} — ${c.description.slice(0, 160)}`).join('\n')}`,
          `# Diagram connections\n${arch.connections.map((e) => `- ${e.id}: ${e.from} → ${e.to} [${e.kind}] ${e.label}`).join('\n')}`,
          `Question: ${q}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    tools: repoTools(ix),
    maxSteps: 10,
    maxTokens: 6000,
    final: { name: 'diagram_answer', schema: DiagramAnswerSchema },
    onEvent: agentEventMapper(emit),
    scripted: async (call) => {
      // Offline: match the question to components by keyword.
      await call('search_code', { query: q, limit: 4 });
      const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const score = (t: string) => words.filter((w) => t.toLowerCase().includes(w)).length;
      const comps = arch.components.filter((c) => score(`${c.name} ${c.description} ${c.paths.join(' ')}`) > 0).map((c) => c.id);
      return {
        final: {
          answerMd: comps.length ? `Components related to the question: ${comps.map((c) => `**${arch.components.find((x) => x.id === c)!.name}**`).join(', ')}.` : 'No matching part of the diagram was found by keyword. Configure an LLM for investigated answers.',
          highlight: { componentIds: comps, connectionIds: arch.connections.filter((e) => comps.includes(e.from) && comps.includes(e.to)).map((e) => e.id) },
          tour: comps.map((c) => ({ componentId: c, caption: arch.components.find((x) => x.id === c)!.description.slice(0, 160) })),
        },
      };
    },
  });
  const raw = res.final as DiagramAnswer;
  // Background synthesis may have replaced the diagram during the run: validate against the current
  // one, and only cache answers built from the diagram that is still published.
  const current = getArchitecture(db, repoId);
  const stale = diagramSignature(current) !== diagramSignature(arch);
  const compIds = new Set(current.components.map((c) => c.id));
  const connIds = new Set(current.connections.map((c) => c.id));
  const answer: DiagramAnswer = {
    answerMd: raw.answerMd,
    highlight: { componentIds: raw.highlight.componentIds.filter((id) => compIds.has(id)), connectionIds: raw.highlight.connectionIds.filter((id) => connIds.has(id)) },
    tour: raw.tour.filter((t) => (t.componentId && compIds.has(t.componentId)) || (t.connectionId && connIds.has(t.connectionId))),
  };
  // Connections on the tour imply their endpoints are highlighted too.
  for (const t of answer.tour) {
    const e = t.connectionId ? current.connections.find((x) => x.id === t.connectionId) : undefined;
    if (e) {
      for (const id of [e.from, e.to]) if (!answer.highlight.componentIds.includes(id)) answer.highlight.componentIds.push(id);
      if (!answer.highlight.connectionIds.includes(e.id)) answer.highlight.connectionIds.push(e.id);
    }
    if (t.componentId && !answer.highlight.componentIds.includes(t.componentId)) answer.highlight.componentIds.push(t.componentId);
  }
  if (!stale) db.prepare(`INSERT INTO diagram_answers (repo_id, question, content) VALUES (?, ?, ?) ON CONFLICT(repo_id, question) DO UPDATE SET content=excluded.content, created_at=datetime('now')`).run(repoId, q.toLowerCase(), JSON.stringify(answer));
  emit({ type: 'result', answer, cached: false });
}

function diagramSignature(arch: Architecture): string {
  return JSON.stringify([arch.components.map((c) => c.id).sort(), arch.connections.map((e) => `${e.id}:${e.from}>${e.to}`).sort()]);
}
