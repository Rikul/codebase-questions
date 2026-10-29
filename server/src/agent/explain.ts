import crypto from 'node:crypto';
import type { AgentStep, AgentStreamEvent, Explanation, ExplainEvent, ExplainRequest, ExplainTarget } from '@cq/shared';
import { ExplanationSchema } from '@cq/shared';
import type { DB } from '../db/index.js';
import type { AgentEvent, ToolCaller } from '../llm/agent.js';
import { AGENT_GUIDANCE } from '../llm/agent.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/index.js';
import { agentWithFallback } from '../llm/index.js';
import { RepoIndex, repoTools } from './tools.js';
import type { SymbolRow } from './tools.js';

/** Convert low-level agent events into the UI stream format. */
export function agentEventMapper(emit: (e: AgentStreamEvent) => void) {
  const labels = new Map<string, { label: string; tool: string }>();
  return (e: AgentEvent) => {
    if (e.type === 'tool_call') {
      labels.set(e.id, { label: e.label, tool: e.name });
      emit({ type: 'step', step: { id: e.id, label: e.label, tool: e.name, status: 'running' } });
    } else if (e.type === 'tool_result') {
      const l = labels.get(e.id) ?? { label: e.name, tool: e.name };
      const step: AgentStep = { id: e.id, label: l.label, tool: l.tool, status: e.isError ? 'error' : 'done', summary: e.summary };
      emit({ type: 'step', step });
    } else if (e.type === 'text') emit({ type: 'token', text: e.text });
    else if (e.type === 'reset') emit({ type: 'reset', text: e.text });
  };
}

const SYSTEM = `You are a senior engineer explaining one part of an unfamiliar codebase to a colleague.
${AGENT_GUIDANCE}

Answer five questions and submit them with submit_explanation:
1. what — what it is and its main responsibility.
2. howItFits — its place in the project: component/layer, what depends on it, what it depends on.
3. whenUsed — when it runs or is loaded: at startup, on which HTTP routes, from which jobs/CLI commands, only in tests, at build time. Use importer_chain and file_info, and follow callers upward.
4. contains — its important functions/classes/variables (for a symbol: key parameters, fields or internal steps).
5. callers and callees — who calls/uses it and what it calls. Verify callers with find_references and callees with symbol_calls or by reading the code; do not guess. Include external libraries as callees (path = package name).

Rules: read the target code first. Keep each prose field short (2-5 sentences, markdown allowed) and cite code as [path:start-end]. Put each caller/callee in its list, not in the prose. If something cannot be determined (dynamic dispatch, reflection, string-based routing), say so.`;

function cacheKey(t: ExplainTarget, snippet?: string) {
  if (t.kind === 'file') return `file:${t.path}`;
  if (t.kind === 'symbol') return `sym:${t.path}#${t.name}@${t.line}`;
  return `snip:${t.path}:${t.line}-${t.endLine}:${crypto.createHash('sha1').update(snippet ?? '').digest('hex').slice(0, 12)}`;
}

export function resolveTarget(ix: RepoIndex, req: ExplainRequest): { target: ExplainTarget; symbol?: SymbolRow } {
  const path = ix.requireFile(req.path);
  if (req.snippet?.text) {
    return { target: { kind: 'snippet', path, line: req.snippet.startLine, endLine: req.snippet.endLine ?? req.snippet.startLine }, symbol: req.snippet.startLine ? ix.findSymbol(path, undefined, req.snippet.startLine) : undefined };
  }
  if (req.symbol?.name || req.symbol?.line) {
    const s = ix.findSymbol(path, req.symbol.name, req.symbol.line);
    if (s) return { target: { kind: 'symbol', path, name: s.parent ? `${s.parent}.${s.name}` : s.name, symbolKind: s.kind, line: s.line, endLine: s.endLine }, symbol: s };
    if (req.symbol.name) {
      // Not defined in this file: maybe an imported or local name. Explain where it is defined, if indexed.
      const def = ix.db.prepare('SELECT path FROM symbols WHERE repo_id=? AND name=? LIMIT 1').get(ix.repoId, req.symbol.name.split('.').pop()) as { path: string } | undefined;
      if (def && def.path !== path) return resolveTarget(ix, { ...req, path: def.path });
      return { target: { kind: 'symbol', path, name: req.symbol.name, symbolKind: 'identifier', line: req.symbol.line } };
    }
  }
  return { target: { kind: 'file', path } };
}

function startingContext(ix: RepoIndex, target: ExplainTarget, symbol: SymbolRow | undefined, snippet?: string): string {
  const info = ix.fileInfo(target.path);
  const outline = ix
    .symbols(target.path)
    .slice(0, 80)
    .map((s) => `- ${s.parent ? s.parent + '.' : ''}${s.name} (${s.kind}${s.exported ? ', exported' : ''}) lines ${s.line}-${s.endLine}`)
    .join('\n');
  const parts = [
    `# File facts (from static analysis)\n${JSON.stringify({ ...info, imports: info.imports.slice(0, 30), importedBy: info.importedBy.slice(0, 30) }, null, 1)}`,
    outline ? `# Symbols in ${target.path}\n${outline}` : '',
  ];
  if (target.kind === 'file') {
    const r = ix.read(target.path, 1, 250);
    parts.push(`# ${target.path} (first ${r.endLine} of ${r.totalLines} lines)\n${r.text}`);
    parts.push(`Explain the FILE ${target.path}.`);
  } else if (target.kind === 'symbol') {
    if (target.line) {
      const r = ix.read(target.path, Math.max(1, target.line - 3), Math.min((target.endLine ?? target.line) + 2, target.line + 150));
      parts.push(`# Definition\n${r.text}`);
    }
    parts.push(`Explain the ${target.symbolKind ?? 'symbol'} \`${target.name}\` defined in ${target.path}${target.line ? ` at line ${target.line}` : ''}.`);
  } else {
    parts.push(`# Selected code (${target.path}:${target.line ?? '?'}-${target.endLine ?? '?'})\n\`\`\`\n${(snippet ?? '').slice(0, 6000)}\n\`\`\``);
    if (symbol) parts.push(`The selection is inside \`${symbol.parent ? symbol.parent + '.' : ''}${symbol.name}\` (lines ${symbol.line}-${symbol.endLine}).`);
    parts.push('Explain the SELECTED CODE: what it does, how it fits, when it runs, what it contains, and who reaches it / what it calls.');
  }
  return parts.filter(Boolean).join('\n\n');
}

/** Offline investigation: the same tools, composed deterministically. */
async function scripted(call: ToolCaller, target: ExplainTarget, symbol: SymbolRow | undefined): Promise<Explanation> {
  const info = await call('file_info', { path: target.path });
  const outline: SymbolRow[] = await call('list_symbols', { path: target.path });
  const chainsRaw = await call('importer_chain', { path: target.path });
  const chains: string[] = Array.isArray(chainsRaw) ? chainsRaw : [];
  const comp = info.component ? `It belongs to the **${info.component.name}** component (${info.component.type}).` : '';
  const routes = (info.routes ?? []) as { method: string; path: string; line: number }[];
  const role = info.isTest ? 'a test file' : info.isEntryPoint ? 'an entry point' : routes.length ? 'a route/handler module' : 'a module';

  const whenParts: string[] = [];
  if (info.isEntryPoint) whenParts.push('It is an entry point, so it runs when the program starts.');
  if (info.isTest) whenParts.push('It runs only under the test runner.');
  if (routes.length) whenParts.push(`It handles HTTP requests: ${routes.slice(0, 8).map((r) => `\`${r.method} ${r.path}\` [${target.path}:${r.line}]`).join(', ')}.`);
  if (chains.length) whenParts.push(`It is loaded through ${chains.slice(0, 3).map((c) => c.split(' → ').map((x) => `\`${x}\``).join(' → ')).join('; ')}.`);
  if (!whenParts.length) whenParts.push(info.importedBy.length ? `It is loaded when ${info.importedBy.slice(0, 5).map((i: any) => `\`${i.path}\``).join(', ')} import it.` : 'No importer or entry point reaches it statically; it may be loaded dynamically, by configuration, or be unused.');

  if (target.kind === 'file') {
    const exported = outline.filter((s) => s.exported || s.kind === 'route').slice(0, 6);
    const callers: Explanation['callers'] = [];
    for (const s of exported) {
      const refs = await call('find_references', { name: s.name, path: target.path });
      if (Array.isArray(refs))
        for (const r of refs.filter((x: any) => x.path !== target.path).slice(0, 4)) callers.push({ path: r.path, line: r.line, symbol: r.inSymbol ?? undefined, why: `uses \`${s.name}\` (${r.kind}): \`${r.code}\`` });
    }
    for (const i of info.importedBy as { path: string; line: number }[]) if (!callers.some((c) => c.path === i.path)) callers.push({ path: i.path, line: i.line, why: 'imports this file' });
    const callees: Explanation['callees'] = (info.imports as any[]).map((i) => (i.package ? { path: i.package, why: 'external package' } : { path: i.path, line: undefined, why: 'imported module' }));
    return {
      what: `\`${target.path}\` is ${role} (${info.lang ?? 'text'}, ${info.lines} lines). ${String(info.summary ?? '').replace(/^[\w-]+ file \(\d+ lines\)\.\s*/i, '').replace(/^(Entry point|Test file) \(\d+ lines\)\.\s*/, '')}`.trim(),
      howItFits: `${comp} ${info.importedBy.length} file(s) import it and it imports ${info.imports.filter((i: any) => i.path).length} internal module(s) and ${info.imports.filter((i: any) => i.package).length} package(s).`.trim(),
      whenUsed: whenParts.join(' '),
      contains: outline.slice(0, 40).map((s) => ({ name: s.parent ? `${s.parent}.${s.name}` : s.name, kind: s.kind, line: s.line, description: s.signature ?? '' })),
      callers: callers.slice(0, 25),
      callees,
      gotchas: (info.securitySignals ?? []).slice(0, 5).map((s: any) => `Security-relevant pattern (${s.kind}) at line ${s.line}; review it.`),
    };
  }

  // Symbol or snippet.
  const name = target.kind === 'symbol' ? target.name! : symbol ? symbol.name : undefined;
  const baseName = name?.split('.').pop();
  const refs = baseName ? await call('find_references', { name: baseName, path: target.path }) : [];
  const calls = baseName && (symbol || target.line) ? await call('symbol_calls', { path: target.path, name: baseName }).catch(() => null) : null;
  const callers: Explanation['callers'] = Array.isArray(refs) ? refs.slice(0, 25).map((r: any) => ({ path: r.path, line: r.line, symbol: r.inSymbol ?? undefined, why: `${r.kind === 'call' ? 'calls' : 'references'} it: \`${r.code}\`` })) : [];
  const callees: Explanation['callees'] = calls?.calls
    ? calls.calls.slice(0, 25).map((c: any) => ({ path: c.target?.startsWith('pkg:') ? c.target.slice(4) : c.target ?? target.path, line: c.targetLine ?? undefined, symbol: c.name, why: `${c.kind === 'call' ? 'calls' : 'uses'} \`${c.name}\` at line ${c.line}` }))
    : [];
  const sym = symbol;
  const routeOf = sym?.kind === 'route' ? `This is the handler for \`${sym.name}\`, so it runs on every matching HTTP request.` : '';
  const callerSyms = [...new Set(callers.map((c) => c.symbol).filter(Boolean))].slice(0, 5);
  return {
    what: target.kind === 'snippet'
      ? `Selected code in \`${target.path}\` (lines ${target.line}-${target.endLine})${sym ? `, inside \`${sym.name}\`` : ''}.`
      : `\`${name}\` is a ${target.symbolKind ?? 'symbol'} in \`${target.path}\`${sym ? ` [${target.path}:${sym.line}-${sym.endLine}]` : ''}${sym?.exported ? ', exported for use by other modules' : ''}.`,
    howItFits: `${comp} ${callers.length ? `It is used in ${new Set(callers.map((c) => c.path)).size} file(s).` : 'No static references were found outside its definition.'}`.trim(),
    whenUsed: [routeOf, callerSyms.length ? `It runs when ${callerSyms.map((s) => `\`${s}\``).join(', ')} run${callerSyms.length === 1 ? 's' : ''}.` : '', ...whenParts].filter(Boolean).join(' '),
    contains: outline
      .filter((s) => sym && s !== undefined && s.line > sym.line && s.endLine <= sym.endLine)
      .slice(0, 20)
      .map((s) => ({ name: s.name, kind: s.kind, line: s.line, description: s.signature ?? '' })),
    callers,
    callees,
    signature: sym?.signature ?? undefined,
  };
}

export async function explain(
  db: DB,
  llm: LLMProvider,
  embeddings: EmbeddingProvider | null,
  repoId: string,
  req: ExplainRequest,
  emit: (e: ExplainEvent) => void,
): Promise<void> {
  const ix = new RepoIndex(db, repoId, embeddings);
  const { target, symbol } = resolveTarget(ix, req);
  emit({ type: 'target', target });
  const file = ix.fileRow(target.path);
  const key = cacheKey(target, req.snippet?.text);
  if (!req.refresh) {
    const hit = db.prepare('SELECT content, file_hash, created_at FROM explanations WHERE repo_id=? AND key=?').get(repoId, key) as any;
    if (hit && hit.file_hash === file.hash) {
      const parsed = ExplanationSchema.safeParse(JSON.parse(hit.content));
      if (parsed.success) return void emit({ type: 'result', explanation: parsed.data, cached: true, createdAt: hit.created_at });
    }
  }
  const run = await agentWithFallback(
    llm,
    {
      system: SYSTEM,
      messages: [{ role: 'user', content: startingContext(ix, target, symbol, req.snippet?.text) }],
      tools: repoTools(ix),
      maxSteps: 12,
      maxTokens: 6000,
      final: { name: 'explanation', schema: ExplanationSchema, description: 'Submit the finished explanation (all five questions).' },
      onEvent: agentEventMapper(emit),
      scripted: async (call) => ({ final: await scripted(call, target, symbol) }),
    },
    (w) => emit({ type: 'step', step: { id: 'fallback', label: w, tool: 'fallback', status: 'error' } }),
  );
  const explanation = cleanExplanation(ix, run.final as Explanation);
  db.prepare(`INSERT INTO explanations (repo_id, key, file_hash, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))
              ON CONFLICT(repo_id, key) DO UPDATE SET file_hash=excluded.file_hash, content=excluded.content, created_at=excluded.created_at`).run(repoId, key, file.hash, JSON.stringify(explanation));
  emit({ type: 'result', explanation, cached: false, createdAt: new Date().toISOString() });
}

/** Keep caller/callee links pointing at real files (or package names). */
function cleanExplanation(ix: RepoIndex, e: Explanation): Explanation {
  const fix = <T extends { path: string; line?: number }>(l: T): T | null => {
    const p = l.path.replace(/^\.?\//, '').replace(/:(\d+)(-\d+)?$/, '');
    if (ix.hasFile(p)) return { ...l, path: p };
    if (!p.includes('/') || p.startsWith('@')) return { ...l, path: p, line: undefined }; // package
    try {
      return { ...l, path: ix.requireFile(p) };
    } catch {
      return null;
    }
  };
  return {
    ...e,
    callers: e.callers.map(fix).filter((x): x is NonNullable<typeof x> => Boolean(x)),
    callees: e.callees.map(fix).filter((x): x is NonNullable<typeof x> => Boolean(x)),
  };
}

/** Identifiers in a file that the viewer should make clickable. */
export function clickableIdentifiers(db: DB, repoId: string, path: string) {
  const defined = db.prepare('SELECT DISTINCT name FROM symbols WHERE repo_id=? AND path=? AND kind != ?').all(repoId, path, 'route') as { name: string }[];
  const referenced = db.prepare('SELECT DISTINCT name FROM refs WHERE repo_id=? AND path=?').all(repoId, path) as { name: string }[];
  return [...new Set([...defined, ...referenced].map((r) => r.name))];
}
