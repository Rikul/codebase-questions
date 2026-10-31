import type { AskEvent, AskRequest, Category, Citation } from '@cq/shared';
import { CATEGORIES, CATEGORY_LABELS } from '@cq/shared';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/index.js';
import type { ChatTurn } from '../llm/provider.js';
import type { RetrievedChunk } from './retrieve.js';
import { retrieve } from './retrieve.js';
import { agentEventMapper, resolveTarget } from '../agent/explain.js';
import { RepoIndex, repoTools } from '../agent/tools.js';
import { AGENT_GUIDANCE } from '../llm/agent.js';
import { agentWithFallback } from '../llm/index.js';

/** Minimal async queue bridging callback events into an async generator. */
class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((v: IteratorResult<T>) => void) | null = null;
  private closed = false;
  push(v: T) {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: v, done: false });
    } else this.items.push(v);
  }
  close() {
    this.closed = true;
    if (this.waiting) this.waiting({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => (this.waiting = r));
      },
    };
  }
}

const KEYWORDS: Record<Category, RegExp> = {
  architecture: /\b(architect\w*|design|component|module|layer|structure|interact\w*|flow|depend\w*|coupl\w*|diagram|system|microservice|data ?flow|talks? to|communicat\w*|pattern)\b/gi,
  onboarding: /\b(history|introduced|added|created|changed|who wrote|blame|commit\w*|when was|start|setup|set up|install|run|build|onboard\w*|new (engineer|developer)|where (do|should) i|read first|getting started|convention|test(s|ing)?|debug|contribut\w*|local(ly)?|overview|what does|explain)\b/gi,
  security: /\b(secur\w*|vuln\w*|attack|exploit|auth\w*|permission|xss|csrf|sql ?injection|injection|sanitiz\w*|secrets?|tokens?|passwords?|hash\w*|crypt\w*|cve|threat|ssrf|rce|cors|privilege|leak)\b/gi,
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
      maxTokens: 512, // room for models that reason before replying
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
  architecture: 'Explain structure and interactions between components. Name the components, the direction of calls/data, and the protocols involved. A short step-by-step flow as bullets helps.',
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
  if (focus.path) {
    try {
      const ix = new RepoIndex(db, repoId);
      const { target } = resolveTarget(ix, { path: focus.path, symbol: focus.symbol, snippet: focus.snippet });
      let text = `The user is looking at \`${target.path}\`.`;
      if (target.kind === 'symbol') text = `The question is about \`${target.name}\` (${target.symbolKind}) in \`${target.path}\`${target.line ? ` lines ${target.line}-${target.endLine}` : ''}. Use find_references / symbol_calls to answer caller/callee questions.`;
      if (focus.snippet?.text) text = `The question is about this selected code from \`${target.path}\` (lines ${focus.snippet.startLine ?? '?'}-${focus.snippet.endLine ?? '?'}):\n\`\`\`\n${focus.snippet.text.slice(0, 4000)}\n\`\`\``;
      return { paths: [target.path], text };
    } catch {
      return { paths: [focus.path], text: `The user is looking at \`${focus.path}\`.` };
    }
  }
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
    'Ground every claim in the provided context or in code you read with tools; if you still cannot answer, say what is missing and where to look. Cite code inline using the exact format [path/to/file.ext:START-END] with line numbers from code you have seen. Use GitHub-flavored markdown. Be concise and specific.',
    focus.text,
  ]
    .filter(Boolean)
    .join('\n\n');

  const mock = () => mockAnswer(category, question, chunks, sums, insights);
  // Agent mode: the model may inspect the code with tools before answering.
  const ix = new RepoIndex(db, repoId, embeddings);
  const queue = new Channel<AskEvent>();
  let full = '';
  const mapper = agentEventMapper((e) => {
    if (e.type === 'token') full += e.text;
    if (e.type === 'reset') full = full.slice(0, Math.max(0, full.length - e.text.length));
    queue.push(e as AskEvent);
  });
  const run = agentWithFallback(llm, {
    system: `${system}\n\n${AGENT_GUIDANCE} The context below is a starting point; use tools when it does not fully answer the question.`,
    maxTokens: 4000,
    maxSteps: 10,
    messages: [...history, { role: 'user', content: `${context}\n\n---\n\nQuestion: ${question}` }],
    tools: repoTools(ix),
    onEvent: mapper,
    scripted: async (call, emitText) => {
      const hist = HISTORY_Q.test(question) ? await historyAnswer(db, repoId, question, req.focus, call).catch(() => null) : null;
      emitText(hist ?? mock());
      return {};
    },
  })
    .catch((err) => {
      const msg = `\n\n_Model call failed: ${(err as Error).message}_`;
      full += msg;
      queue.push({ type: 'token', text: msg });
    })
    .finally(() => queue.close());
  for await (const ev of queue) yield ev;
  await run;
  const known = new Set((db.prepare('SELECT path FROM files WHERE repo_id=?').all(repoId) as { path: string }[]).map((r) => r.path));
  let citations = extractCitations(full, known);
  if (!citations.length) citations = sources.slice(0, 6);
  const messageId = Number(
    db.prepare('INSERT INTO messages (conversation_id, role, content, category, citations) VALUES (?, ?, ?, ?, ?)').run(conversationId, 'assistant', full, category, JSON.stringify(citations)).lastInsertRowid,
  );
  yield { type: 'done', messageId, citations };
}

const HISTORY_Q = /\b(when (was|were|did)|who (wrote|added|created|changed)|introduced|history|first (added|appeared)|created|last changed|blame)\b/i;

/** Offline answer to "when was X added / who changed Y" using the git history tools. */
async function historyAnswer(db: DB, repoId: string, question: string, focus: AskRequest['focus'], call: (n: string, i: Record<string, unknown>) => Promise<any>): Promise<string | null> {
  const day = (d: string) => String(d).slice(0, 10);
  const short = (s: string) => String(s).slice(0, 7);
  // Which symbol or file is the question about? Prefer the focus, then names mentioned in the question.
  let target: { path: string; name?: string } | null = focus?.path ? { path: focus.path, name: focus.symbol?.name } : null;
  if (!target?.name) {
    const words = [...new Set(question.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])];
    // With a focused file, only consider symbols in that file; otherwise search the repository.
    const scope = target?.path ? ' AND path = ?' : '';
    const hits = words.length
      ? (db
          .prepare(`SELECT path, name, kind FROM symbols WHERE repo_id=? AND name IN (${words.map(() => '?').join(',')}) AND kind != 'route'${scope}`)
          .all(repoId, ...words, ...(target?.path ? [target.path] : [])) as any[])
      : [];
    const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec|e2e)\//.test(p) || /\.(test|spec)\./.test(p);
    const hit = hits.sort((a, b) => Number(isTest(a.path)) - Number(isTest(b.path)) || (a.kind === 'function' ? -1 : 1))[0];
    if (hit) target = { path: hit.path, name: hit.name };
    else if (!target) {
      const file = words.length ? (db.prepare(`SELECT path FROM files WHERE repo_id=? AND (${words.map(() => 'path LIKE ?').join(' OR ')}) ORDER BY length(path) LIMIT 1`).get(repoId, ...words.map((w) => `%${w}%`)) as any) : null;
      if (file) target = { path: file.path };
    }
  }
  if (!target) return null;
  const head = '> _Offline mode: answered from git history without an LLM._\n\n';
  if (target.name) {
    const h = await call('symbol_history', { path: target.path, name: target.name });
    if (typeof h === 'string' || !h.introduced) return null;
    const i = h.introduced;
    return (
      head +
      `**\`${h.name ?? target.name}\`** in \`${target.path}\` was ${i.how === 'pickaxe' ? 'first added' : 'introduced'} ${i.uncertain ? 'on or before' : 'on'} **${day(i.date)}** by **${i.author}** in \`${short(i.sha)}\` — “${i.subject}”.` +
      (h.commits.length > 1
        ? `\n\nIt has changed in ${h.commits.length - 1} later commit(s):\n\n${h.commits.slice(0, -1).slice(0, 8).map((c: any) => `- ${day(c.date)} · ${c.author} · \`${short(c.sha)}\` — ${c.subject} (+${c.added}/−${c.deleted})`).join('\n')}`
        : '\n\nIt has not changed since.') +
      (i.uncertain ? '\n\n_History is truncated, so it may be older. Set HISTORY_DEPTH=0 for full history._' : '') +
      (h.range ? `\n\nCode: [${target.path}:${h.range.start}-${h.range.end}]` : '')
    );
  }
  const h = await call('file_history', { path: target.path });
  if (typeof h === 'string' || !h.created) return null;
  return (
    head +
    `**\`${target.path}\`** was ${h.created.uncertain ? 'created on or before' : 'created on'} **${day(h.created.date)}** by **${h.created.author}** in \`${short(h.created.sha)}\` — “${h.created.subject}”. ` +
    `It has ${h.commitCount} commit(s); the last change was ${day(h.lastChanged.date)} by ${h.lastChanged.author} (“${h.lastChanged.subject}”).` +
    (h.renames.length ? `\n\nRenames: ${h.renames.map((r: any) => `\`${r.from}\` → \`${r.to}\``).join(', ')}.` : '')
  );
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
