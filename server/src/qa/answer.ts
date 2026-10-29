import type { AskEvent, AskRequest, Category, Citation } from '@cq/shared';
import { CATEGORIES, CATEGORY_LABELS } from '@cq/shared';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/index.js';
import type { ChatTurn } from '../llm/provider.js';
import type { RetrievedChunk } from './retrieve.js';
import { retrieve } from './retrieve.js';

const KEYWORDS: Record<Category, RegExp> = {
  architecture: /\b(architect\w*|design|component|module|layer|structure|interact\w*|flow|depend\w*|coupl\w*|diagram|system|microservice|data ?flow|talks? to|communicat\w*|pattern)\b/gi,
  onboarding: /\b(start|setup|set up|install|run|build|onboard\w*|new (engineer|developer)|where (do|should) i|read first|getting started|convention|test(s|ing)?|debug|contribut\w*|local(ly)?|overview|what does|explain)\b/gi,
  security: /\b(secur\w*|vuln\w*|attack|exploit|auth\w*|permission|xss|csrf|sql ?injection|injection|sanitiz\w*|secret|token|password|crypt\w*|cve|threat|ssrf|rce|cors|privilege|leak)\b/gi,
  api: /\b(api|sdk|library|libraries|endpoint|interface|integrat\w*|call|client|import|usage|example|parameter|signature|runtime|behaviou?r|retry|async|return|exception|hook)\b/gi,
};

export function classifyHeuristic(q: string): { category: Category; confident: boolean } {
  const scores = CATEGORIES.map((c) => ({ c, n: q.match(KEYWORDS[c])?.length ?? 0 })).sort((a, b) => b.n - a.n);
  if (scores[0].n === 0) return { category: 'onboarding', confident: false };
  return { category: scores[0].c, confident: scores[0].n > scores[1].n };
}

async function classify(llm: LLMProvider, q: string): Promise<Category> {
  const h = classifyHeuristic(q);
  if (h.confident || llm.name === 'mock') return h.category;
  try {
    const out = await llm.complete({
      fast: true,
      maxTokens: 10,
      system: `Classify the developer question into exactly one category id: architecture (system structure/interactions), onboarding (getting oriented, running, conventions), security (attack surface, vulnerabilities), api (using interfaces/libraries, runtime behavior). Reply with only the id.`,
      messages: [{ role: 'user', content: q }],
    });
    const id = out.trim().toLowerCase().replace(/[^a-z]/g, '') as Category;
    return CATEGORIES.includes(id) ? id : h.category;
  } catch {
    return h.category;
  }
}

const PERSONAS: Record<Category, string> = {
  architecture: 'Explain structure and interactions between components. Name the components, the direction of calls/data, and the protocols involved. A short step-by-step flow or an ASCII/mermaid-free bullet diagram helps.',
  onboarding: 'Answer like a helpful senior teammate onboarding a new engineer: practical, concrete, with exact commands, file paths and a suggested next step.',
  security: 'Answer as an application security reviewer. Identify attack surfaces, trust boundaries and vulnerable patterns. Distinguish confirmed issues (with cited code) from things to verify. Suggest concrete mitigations.',
  api: 'Explain how to use the interfaces and libraries: signatures, required setup, a minimal code example, runtime behavior (sync/async, errors, retries, side effects) and gotchas.',
};

export function extractCitations(text: string, known: Set<string>): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\[([^\]\s:]+?):(\d+)(?:-(\d+))?\]/g)) {
    const path = m[1].replace(/^\.?\//, '');
    if (!known.has(path)) continue;
    const c = { path, startLine: Number(m[2]), endLine: Number(m[3] ?? m[2]) };
    const k = `${c.path}:${c.startLine}-${c.endLine}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

function numbered(c: RetrievedChunk, max = 4000) {
  const lines = c.content.split('\n');
  const body = lines.map((l, i) => `${String(c.startLine + i).padStart(5)}| ${l}`).join('\n');
  return body.length > max ? body.slice(0, max) + '\n…' : body;
}

interface Focus {
  paths: string[];
  text: string;
}

function resolveFocus(db: DB, repoId: string, focus: AskRequest['focus']): Focus {
  if (!focus) return { paths: [], text: '' };
  if (focus.componentId) {
    const c = db.prepare('SELECT * FROM components WHERE repo_id=? AND id=?').get(repoId, focus.componentId) as any;
    if (c) return { paths: json<string[]>(c.paths, []), text: `The user is asking about the component "${c.name}" (${c.type}): ${c.description}` };
  }
  if (focus.connectionId) {
    const e = db.prepare('SELECT * FROM connections WHERE repo_id=? AND id=?').get(repoId, focus.connectionId) as any;
    if (e) {
      const ev = json<{ path: string }[]>(e.evidence, []);
      return { paths: [...new Set(ev.map((x) => x.path))], text: `The user is asking about the connection ${e.src} → ${e.dst} (${e.kind}, "${e.label}"): ${e.description}` };
    }
  }
  if (focus.path) return { paths: [focus.path], text: `The user is looking at \`${focus.path}\`.` };
  return { paths: [], text: '' };
}

export async function* answerQuestion(
  db: DB,
  llm: LLMProvider,
  embeddings: EmbeddingProvider | null,
  repoId: string,
  req: AskRequest,
): AsyncGenerator<AskEvent> {
  const repo = db.prepare('SELECT * FROM repos WHERE id=?').get(repoId) as any;
  const question = req.question.trim().slice(0, 4000);
  const category = req.category ?? (await classify(llm, question));

  let conversationId = req.conversationId;
  if (!conversationId || !db.prepare('SELECT 1 FROM conversations WHERE id=? AND repo_id=?').get(conversationId, repoId)) {
    conversationId = Number(db.prepare('INSERT INTO conversations (repo_id, title) VALUES (?, ?)').run(repoId, question.slice(0, 120)).lastInsertRowid);
  }
  yield { type: 'meta', conversationId, category };

  const history = (db.prepare('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 6').all(conversationId) as ChatTurn[]).reverse();
  db.prepare('INSERT INTO messages (conversation_id, role, content, category) VALUES (?, ?, ?, ?)').run(conversationId, 'user', question, category);

  const focus = resolveFocus(db, repoId, req.focus);
  const chunks = await retrieve(db, repoId, question, { category, focusPaths: focus.paths, embeddings });
  const sources: Citation[] = chunks.map((c) => ({ path: c.path, startLine: c.startLine, endLine: c.endLine }));
  yield { type: 'sources', citations: sources };

  const comps = db.prepare('SELECT id, name, type, description, paths FROM components WHERE repo_id=?').all(repoId) as any[];
  const conns = db.prepare('SELECT src, dst, kind, label FROM connections WHERE repo_id=?').all(repoId) as any[];
  const insights = db.prepare('SELECT title, body_md, severity FROM insights WHERE repo_id=? AND category=? ORDER BY position').all(repoId, category) as any[];
  const paths = [...new Set(chunks.map((c) => c.path))];
  const sums = paths.length
    ? (db.prepare(`SELECT path, summary FROM files WHERE repo_id=? AND path IN (${paths.map(() => '?').join(',')})`).all(repoId, ...paths) as any[])
    : [];

  const context = [
    `# Repository: ${repo.name} (${repo.url}${repo.commit_sha ? ` @ ${repo.commit_sha.slice(0, 10)}` : ''})`,
    repo.overview ? `## Architecture overview\n${String(repo.overview).slice(0, 3000)}` : '',
    comps.length ? `## Components\n${comps.map((c) => `- ${c.id}: ${c.name} [${c.type}] (${json<string[]>(c.paths, []).join(', ') || 'external'}) — ${c.description}`).join('\n')}` : '',
    conns.length ? `## Connections\n${conns.map((e) => `- ${e.src} → ${e.dst} [${e.kind}] ${e.label}`).join('\n')}` : '',
    insights.length ? `## Knowledge base: ${CATEGORY_LABELS[category]}\n${insights.map((i) => `### ${i.title}${i.severity ? ` (${i.severity})` : ''}\n${String(i.body_md).slice(0, 1500)}`).join('\n\n').slice(0, 9000)}` : '',
    sums.length ? `## File summaries\n${sums.map((s) => `- ${s.path}: ${s.summary ?? ''}`).join('\n')}` : '',
    `## Retrieved code\n${chunks.map((c) => `### [${c.path}:${c.startLine}-${c.endLine}]\n${numbered(c)}`).join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const system = [
    `You are an expert on the ${repo.name} codebase, answering a question in the category "${CATEGORY_LABELS[category]}".`,
    PERSONAS[category],
    'Use ONLY the provided context; if it is insufficient, say what is missing and where to look. Cite code inline using the exact format [path/to/file.ext:START-END] with line numbers from the retrieved code. Use GitHub-flavored markdown. Be concise and specific.',
    focus.text,
  ]
    .filter(Boolean)
    .join('\n\n');

  const mock = () => mockAnswer(category, question, chunks, sums, insights);
  let full = '';
  try {
    for await (const t of llm.stream({ system, maxTokens: 3000, messages: [...history, { role: 'user', content: `${context}\n\n---\n\nQuestion: ${question}` }], mock })) {
      full += t;
      yield { type: 'token', text: t };
    }
  } catch (err) {
    const msg = `\n\n_Model call failed: ${(err as Error).message}_`;
    full += msg;
    yield { type: 'token', text: msg };
  }
  const known = new Set((db.prepare('SELECT path FROM files WHERE repo_id=?').all(repoId) as { path: string }[]).map((r) => r.path));
  let citations = extractCitations(full, known);
  if (!citations.length) citations = sources.slice(0, 6);
  const messageId = Number(
    db.prepare('INSERT INTO messages (conversation_id, role, content, category, citations) VALUES (?, ?, ?, ?, ?)').run(conversationId, 'assistant', full, category, JSON.stringify(citations)).lastInsertRowid,
  );
  yield { type: 'done', messageId, citations };
}

function mockAnswer(category: Category, question: string, chunks: RetrievedChunk[], sums: any[], insights: any[]): string {
  const sumMap = new Map(sums.map((s) => [s.path, s.summary]));
  const lines = [
    `> _Offline mode: no LLM API key is configured, so this answer is assembled from static analysis and search. Set \`ANTHROPIC_API_KEY\` or \`OPENAI_API_KEY\` for generated answers._`,
    '',
    `**Category:** ${CATEGORY_LABELS[category]}`,
    '',
  ];
  const rel = insights.filter((i) => question.toLowerCase().split(/\W+/).some((w) => w.length > 3 && `${i.title} ${i.body_md}`.toLowerCase().includes(w))).slice(0, 2);
  for (const i of rel.length ? rel : insights.slice(0, 1)) lines.push(`### ${i.title}`, String(i.body_md).slice(0, 1200), '');
  if (chunks.length) {
    lines.push('### Most relevant code');
    for (const c of chunks.slice(0, 6)) {
      lines.push(`- [${c.path}:${c.startLine}-${c.endLine}] — ${String(sumMap.get(c.path) ?? '').slice(0, 200)}`);
    }
  }
  return lines.join('\n');
}
