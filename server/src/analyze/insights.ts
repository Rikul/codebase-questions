import { z } from 'zod';
import type { Architecture, Category, Insight, SuggestedQuestion } from '@cq/shared';
import { CATEGORY_LABELS, componentTitle } from '@cq/shared';
import { jsonWithFallback } from '../llm/index.js';
import type { RepoContext } from './context.js';
import { allRoutes, cleanRefs, dirTree, entryPoints, isCode, packageScripts, readmeIntro, truncate } from './context.js';

// Optional pieces default instead of failing: rejecting a whole category's write-up because one
// section left out its refs (or used an odd severity) would throw away an otherwise good answer.
const InsightsOut = z.object({
  insights: z.array(
    z.object({
      kind: z.string().describe('section kind, e.g. overview, setup, entry-points, attack-surface, finding, public-api, library-usage'),
      title: z.string(),
      bodyMd: z.string().describe('GitHub-flavored markdown; cite code as [path/to/file.ts:12-20], or as `path/to/file.ts` when no line numbers are known'),
      severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional().catch(undefined).describe('security findings only'),
      refs: z
        .array(z.object({ path: z.string(), startLine: z.number().optional(), endLine: z.number().optional(), note: z.string().optional() }))
        .default([])
        .describe('files this section is about (path plus line numbers when known)'),
    }),
  ),
  questions: z.array(z.string()).default([]).describe('6-8 specific questions a user might ask next about this repository'),
});
type InsightsOut = z.infer<typeof InsightsOut>;

const GUIDES: Record<Category, string> = {
  repository:
    'Describe the repository as a project, from its facts and git history. Write sections: "At a glance" (what it is, size, languages, maturity and how active it is), "Activity over time" (trends from the monthly activity: busy and quiet periods, recent pace), "Contributors" (who works on it and on what, from authors and lines changed), "How the codebase evolved" (main phases, inferred from commit types and subjects over time; cite commits by short sha), "Hotspots & churn" (most-changed files and what that suggests), and "Recent changes" (what the latest commits did). Use only the facts given; if history is shallow or capped, say the picture covers only the indexed commits. Skip history sections when there is no git history.',
  architecture:
    'Write sections: "System overview", "Request / data flow" (trace one representative flow end to end, step by step with file refs), "Key design decisions & patterns", "Deployment & runtime" (containers, processes, config), and "Extension points".',
  onboarding:
    'Write a practical guide for a new engineer: "What this project is", "Getting set up" (exact commands from scripts/manifests), "Entry points", "Suggested reading order" (6-10 files with why), "Core concepts & vocabulary", "Conventions" (structure, naming, error handling, testing), "Where to make common changes".',
  security:
    'Act as an application security reviewer. Write: "Attack surface" (every externally reachable entry: routes, CLIs, message consumers, file inputs), "Authentication & authorization", "Input handling & injection risks", "Secrets & configuration", "Dependency risk", then one "finding" insight per concrete issue with severity, evidence refs, impact and a recommended fix. Do not invent issues; tie each finding to cited code. If a signal is a false positive, say so.',
  api:
    'Explain how to integrate with and use this codebase as a library/service: "Public API surface" (exported functions/classes with signatures and usage examples), "HTTP / RPC API" (endpoints table with method, path, handler), then one "library-usage" insight for each of the 4-8 most important third-party libraries: how this code uses it, where, lifecycle/runtime behavior (initialization, async, errors, retries) and gotchas. End with "Integration recipes" showing example code.',
};

function categoryFacts(ctx: RepoContext, cat: Category, arch: Architecture): string {
  const routes = allRoutes(ctx);
  const comps = arch.components.map((c) => `- ${componentTitle(c)} [${c.type}] (${c.paths.join(', ') || 'external'}): ${c.summary ?? c.description}`).join('\n');
  const conns = arch.connections.map((e) => `- ${e.from} -> ${e.to} [${e.kind}] ${e.label}: ${e.description}`).join('\n');
  const keyFiles = [...ctx.summaries.entries()]
    .filter(([p]) => isCode(ctx.fileByPath.get(p)!))
    .sort(([a], [b]) => (ctx.centrality.get(b) ?? 0) - (ctx.centrality.get(a) ?? 0))
    .slice(0, 40)
    .map(([p, s]) => `- ${p}: ${truncate(s, 300)}`)
    .join('\n');
  const env = new Map<string, string>();
  for (const f of ctx.files) for (const e of ctx.facts.get(f.path)?.envVars ?? []) if (!env.has(e.detail)) env.set(e.detail, `${f.path}:${e.line}`);
  const base = [
    `Repository: ${ctx.repoName}`,
    `# Architecture overview\n${truncate(arch.overview, 3000)}`,
    `# Components\n${comps}`,
    `# Connections\n${conns}`,
  ];
  const deps = ctx.deps.map((d) => `${d.ecosystem}:${d.name}@${d.version}${d.dev ? ' (dev)' : ''}`).slice(0, 120).join(', ');
  const routesTxt = routes.slice(0, 80).map((r) => `- ${r.method} ${r.route} → ${r.path}:${r.line}`).join('\n');

  if (cat === 'onboarding' || cat === 'architecture') {
    const scripts = packageScripts(ctx);
    const infraFiles = ctx.files
      .filter((f) => /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Makefile|Procfile|\.github\/workflows\/[^/]+|k8s\/[^/]+|helm\/[^/]+|[^/]+\.tf)$/.test(f.path))
      .slice(0, 8)
      .map((f) => `--- ${f.path}\n${truncate(f.content, 1500)}`)
      .join('\n');
    base.push(
      ctx.readme ? `# README\n${truncate(ctx.readme, 6000)}` : '',
      `# Directory tree\n${dirTree(ctx.files)}`,
      `# Entry points\n${entryPoints(ctx).join('\n')}`,
      Object.keys(scripts).length ? `# package.json scripts\n${JSON.stringify(scripts, null, 2)}` : '',
      `# Dependencies\n${deps}`,
      env.size ? `# Environment variables read\n${[...env].map(([k, v]) => `${k} (${v})`).join('\n')}` : '',
      infraFiles ? `# Build / deploy files\n${infraFiles}` : '',
      `# Key files\n${keyFiles}`,
      historyBlock(ctx),
    );
  }
  if (cat === 'security') {
    const signals: string[] = [];
    for (const f of ctx.files) {
      const fx = ctx.facts.get(f.path);
      if (!fx || fx.isTest) continue;
      for (const s of fx.security) if (signals.length < 150) signals.push(`- ${f.path}:${s.line} [${s.kind}] ${s.detail}`);
    }
    base.push(
      routes.length ? `# HTTP routes\n${routesTxt}` : '# HTTP routes\n(none detected)',
      `# Security-relevant code signals (regex; may include false positives)\n${signals.join('\n') || '(none)'}`,
      env.size ? `# Environment variables / config\n${[...env].map(([k, v]) => `${k} (${v})`).join('\n')}` : '',
      `# Dependencies\n${deps}`,
      `# Key files\n${keyFiles}`,
    );
    // Include source for the most security-relevant files so findings can be verified.
    const hot = ctx.files
      .filter((f) => !ctx.facts.get(f.path)?.isTest)
      .map((f) => ({ f, n: (ctx.facts.get(f.path)?.security.length ?? 0) * 2 + (ctx.facts.get(f.path)?.routes.length ?? 0) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
    base.push(`# Source of the most security-relevant files\n${hot.map(({ f }) => `--- ${f.path}\n${numbered(truncate(f.content, 5000))}`).join('\n')}`);
  }
  if (cat === 'api') {
    const exported: string[] = [];
    for (const f of ctx.files) {
      const fx = ctx.facts.get(f.path);
      if (!fx || fx.isTest) continue;
      const ex = fx.symbols.filter((s) => s.exported);
      if (ex.length && exported.length < 150) exported.push(`- ${f.path}: ${ex.slice(0, 12).map((s) => `${s.name}:${s.line} (${s.kind})`).join(', ')}`);
    }
    const usage = externalUsage(ctx)
      .slice(0, 15)
      .map((u) => `- ${u.pkg}: used in ${u.files.length} files, e.g. ${u.files.slice(0, 4).join(', ')}`);
    base.push(
      `# Dependencies\n${deps}`,
      `# Third-party library usage\n${usage.join('\n')}`,
      `# Exported symbols\n${exported.join('\n')}`,
      routes.length ? `# HTTP routes\n${routesTxt}` : '',
      `# Key files\n${keyFiles}`,
    );
  }
  if (cat === 'repository') base.push(...repositoryFacts(ctx));
  return base.filter(Boolean).join('\n\n');
}

const fmt = (n: number) => n.toLocaleString('en-US');

function repositoryFacts(ctx: RepoContext): string[] {
  const r = ctx.repo;
  const out = [
    ctx.readme ? `# README (intro)\n${readmeIntro(ctx.readme, 1500)}` : '',
    r ? `# Size\n${fmt(r.stats.files)} files, ${fmt(r.stats.lines)} lines. Languages: ${r.stats.languages.map((l) => `${l.lang} (${l.files} files, ${fmt(l.lines)} lines)`).join(', ')}` : '',
    `# Dependencies\n${ctx.deps.filter((d) => !d.dev).length} runtime, ${ctx.deps.filter((d) => d.dev).length} dev`,
  ];
  const h = r?.stats.history;
  if (!h) return [...out, '# Git history\n(not available)'];
  out.push(
    historyBlock(ctx),
    `# Commit types\n${Object.entries(h.types).filter(([, n]) => n).map(([t, n]) => `${t}: ${n}`).join(', ')}`,
    `# Commit sizes (lines changed)\n${Object.entries(h.sizes).map(([s, n]) => `${s}: ${n}`).join(', ')}`,
    `# Activity per month (commits, +added/-deleted)\n${h.months.slice(-36).map((m) => `${m.month}: ${m.commits} (+${m.added}/-${m.deleted})`).join('\n')}`,
    `# Authors (commits, lines added/deleted)\n${h.authors.map((a) => `- ${a.author}: ${a.commits} commits, +${fmt(a.added)}/-${fmt(a.deleted)}`).join('\n')}`,
    `# Biggest commits\n${h.biggest.map((c) => `- ${c.sha.slice(0, 8)} ${c.date.slice(0, 10)} [${c.type}] +${c.added}/-${c.deleted} ${c.author}: ${c.subject}`).join('\n')}`,
    `# Last ${r!.recent.length} commits\n${r!.recent.map((c) => `- ${c.sha.slice(0, 8)} ${c.date.slice(0, 10)} [${c.type}] +${c.added}/-${c.deleted} ${c.author}: ${c.subject}`).join('\n')}`,
  );
  return out;
}

function historyBlock(ctx: RepoContext): string {
  const h = ctx.history;
  if (!h) return '';
  return [
    `# Git history (${h.commitCount} of ${h.totalCommits} commits indexed${h.shallow ? ', shallow clone: older history not fetched' : ''}; ${h.firstCommit?.slice(0, 10)} → ${h.lastCommit?.slice(0, 10)})`,
    `Top authors: ${h.authors.map((a: any) => `${a.author} (${a.n})`).join(', ')}`,
    `Most-changed files: ${h.hotspots.map((x: any) => `${x.path} (${x.n} commits)`).join(', ')}`,
    `Recent commits:\n${h.recent.map((c) => `- ${c.sha.slice(0, 8)} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`).join('\n')}`,
  ].join('\n');
}

function numbered(s: string): string {
  return s
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join('\n');
}

export function externalUsage(ctx: RepoContext) {
  const m = new Map<string, string[]>();
  for (const [f, pkgs] of ctx.graph.external) {
    if (ctx.facts.get(f)?.isTest) continue;
    for (const p of pkgs) (m.get(p) ?? m.set(p, []).get(p)!).push(f);
  }
  return [...m.entries()].map(([pkg, files]) => ({ pkg, files })).sort((a, b) => b.files.length - a.files.length);
}

// ---------- Heuristic (offline) insights ----------

function ref(path: string, line?: number) {
  return { path, startLine: line, endLine: line };
}

export function heuristicInsights(ctx: RepoContext, cat: Category, arch: Architecture): InsightsOut {
  const routes = allRoutes(ctx);
  const eps = entryPoints(ctx);
  const out: InsightsOut['insights'] = [];
  const q: string[] = [];

  if (cat === 'architecture') {
    out.push({ kind: 'overview', title: 'System overview', bodyMd: arch.overview, refs: eps.map((e) => ref(e)) });
    out.push({
      kind: 'components',
      title: 'Components',
      bodyMd: arch.components.map((c) => `- **${componentTitle(c)}** (${c.type}) ${c.paths.length ? `— \`${c.paths.join('`, `')}\`` : ''}: ${c.description}`).join('\n'),
      refs: [],
    });
    const top = [...ctx.centrality.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    out.push({
      kind: 'hubs',
      title: 'Most connected files',
      bodyMd: `Files imported most often are usually the core abstractions:\n\n${top.map(([p, n]) => `- \`${p}\` (score ${n}) — ${truncate(ctx.summaries.get(p) ?? '', 160)}`).join('\n')}`,
      refs: top.map(([p]) => ref(p)),
    });
    q.push(
      'What are the main components and how do they depend on each other?',
      'Trace a typical request from entry point to persistence.',
      'Which modules are the most coupled, and why?',
      'How is configuration loaded and passed through the system?',
      'Where would I add a new feature module?',
      'How is the application deployed and run in production?',
    );
  }
  if (cat === 'onboarding') {
    const scripts = packageScripts(ctx);
    out.push({
      kind: 'overview',
      title: 'What this project is',
      bodyMd: ctx.readme ? `${readmeIntro(ctx.readme, 1200)}\n\nThe codebase has ${ctx.files.length} files; the main components are ${arch.components.filter((c) => c.paths.length).map((c) => `**${componentTitle(c)}**`).join(', ')}.` : `No README found. ${arch.overview}`,
      refs: ctx.readme ? [ref(ctx.files.find((f) => /^readme/i.test(f.path))?.path ?? 'README.md')] : [],
    });
    const manifests = [...new Set(ctx.deps.map((d) => d.manifest))];
    out.push({
      kind: 'setup',
      title: 'Getting set up',
      bodyMd: [
        manifests.length ? `Dependency manifests: ${manifests.map((m) => `\`${m}\``).join(', ')}.` : 'No dependency manifest detected.',
        Object.keys(scripts).length ? `\n\nAvailable scripts:\n\n${Object.entries(scripts).map(([k, v]) => `- \`npm run ${k}\` → \`${v}\``).join('\n')}` : '',
      ].join(''),
      refs: manifests.map((m) => ref(m)),
    });
    out.push({
      kind: 'entry-points',
      title: 'Entry points',
      bodyMd: eps.length ? eps.map((e) => `- \`${e}\` — ${truncate(ctx.summaries.get(e) ?? '', 200)}`).join('\n') : 'No obvious entry point detected.',
      refs: eps.map((e) => ref(e)),
    });
    const reading = [...new Set([...eps.slice(0, 3), ...[...ctx.centrality.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)])]
      .filter((p) => !ctx.facts.get(p)?.isTest)
      .slice(0, 8);
    out.push({
      kind: 'reading-order',
      title: 'Suggested reading order',
      bodyMd: reading.map((p, i) => `${i + 1}. \`${p}\` — ${truncate(ctx.summaries.get(p) ?? '', 180)}`).join('\n'),
      refs: reading.map((p) => ref(p)),
    });
    if (ctx.history) {
      const h = ctx.history;
      out.push({
        kind: 'history',
        title: 'Project history & hotspots',
        bodyMd: [
          `${h.capped ? `The most recent ${h.commitCount} of ${h.totalCommits} commits` : `${h.commitCount} commits`}${h.shallow ? ' (shallow clone: older history was not fetched)' : ''} from ${h.firstCommit?.slice(0, 10)} to ${h.lastCommit?.slice(0, 10)}.`,
          `\n\n**Top contributors:** ${h.authors.slice(0, 5).map((a: any) => `${a.author} (${a.n})`).join(', ')}.`,
          `\n\n**Most frequently changed files** (often the core or the riskiest code):\n\n${h.hotspots.slice(0, 8).map((x: any) => `- \`${x.path}\` — ${x.n} commits`).join('\n')}`,
          `\n\n**Recent changes:**\n\n${h.recent.slice(0, 6).map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.date.slice(0, 10)} · ${c.author}: ${c.subject}`).join('\n')}`,
        ].join(''),
        refs: h.hotspots.slice(0, 8).map((x: any) => ref(x.path)),
      });
    }
    const tests = ctx.files.filter((f) => ctx.facts.get(f.path)?.isTest);
    out.push({
      kind: 'testing',
      title: 'Tests',
      bodyMd: tests.length ? `${tests.length} test files, e.g. ${tests.slice(0, 6).map((t) => `\`${t.path}\``).join(', ')}.` : 'No tests detected.',
      refs: tests.slice(0, 6).map((t) => ref(t.path)),
    });
    q.push(
      'How do I run this project locally?',
      'What should I read first to understand the codebase?',
      'What are the core concepts and domain terms?',
      'How are tests organized and how do I run them?',
      'What coding conventions does this project follow?',
      'Where would I make a change to add a new endpoint/command?',
    );
  }
  if (cat === 'security') {
    out.push({
      kind: 'attack-surface',
      title: 'Attack surface',
      bodyMd: routes.length
        ? `${routes.length} HTTP route(s) detected:\n\n| Method | Path | Handler |\n|---|---|---|\n${routes.slice(0, 40).map((r) => `| ${r.method} | \`${r.route}\` | \`${r.path}:${r.line}\` |`).join('\n')}`
        : `No HTTP routes detected. Entry points: ${eps.map((e) => `\`${e}\``).join(', ') || 'none'}.`,
      refs: routes.slice(0, 20).map((r) => ref(r.path, r.line)),
    });
    const byKind = new Map<string, { path: string; line: number; detail: string }[]>();
    for (const f of ctx.files) {
      const fx = ctx.facts.get(f.path);
      if (!fx || fx.isTest) continue;
      for (const s of fx.security) (byKind.get(s.kind) ?? byKind.set(s.kind, []).get(s.kind)!).push({ path: f.path, line: s.line, detail: s.detail });
    }
    const auth = byKind.get('auth') ?? [];
    out.push({
      kind: 'authn-authz',
      title: 'Authentication & authorization',
      bodyMd: auth.length ? `Auth-related code found in ${new Set(auth.map((a) => a.path)).size} files:\n\n${auth.slice(0, 10).map((a) => `- \`${a.path}:${a.line}\` — \`${truncate(a.detail, 100)}\``).join('\n')}` : 'No authentication code detected. If this service is network-facing, verify how access is controlled.',
      refs: auth.slice(0, 10).map((a) => ref(a.path, a.line)),
    });
    const SEV: Record<string, 'low' | 'medium' | 'high'> = {
      'code-exec': 'high', 'command-exec': 'medium', 'shell-true': 'high', 'sql-concat': 'high', 'xss-sink': 'medium', deserialization: 'high',
      'weak-crypto': 'low', 'hardcoded-secret': 'high', 'tls-disabled': 'medium', 'cors-wildcard': 'medium', 'path-traversal': 'medium', ssrf: 'medium', redirect: 'low',
    };
    const TITLES: Record<string, string> = {
      'code-exec': 'Dynamic code execution', 'command-exec': 'OS command execution', 'shell-true': 'Shell invocation with shell=true', 'sql-concat': 'SQL built by string concatenation',
      'xss-sink': 'Raw HTML rendering (XSS sink)', deserialization: 'Unsafe deserialization', 'weak-crypto': 'Weak cryptography / non-crypto randomness', 'hardcoded-secret': 'Possible hard-coded secret',
      'tls-disabled': 'TLS verification disabled', 'cors-wildcard': 'Permissive CORS', 'path-traversal': 'File access from request input', ssrf: 'Outbound request from user input', redirect: 'Open redirect',
    };
    for (const [kind, hits] of byKind) {
      if (kind === 'auth') continue;
      out.push({
        kind: 'finding',
        title: TITLES[kind] ?? kind,
        severity: SEV[kind] ?? 'info',
        bodyMd: `Pattern-based detection (verify manually):\n\n${hits.slice(0, 8).map((h) => `- \`${h.path}:${h.line}\` — \`${truncate(h.detail, 120)}\``).join('\n')}`,
        refs: hits.slice(0, 8).map((h) => ref(h.path, h.line)),
      });
    }
    const env = new Set<string>();
    for (const f of ctx.files) for (const e of ctx.facts.get(f.path)?.envVars ?? []) env.add(e.detail);
    out.push({
      kind: 'secrets',
      title: 'Secrets & configuration',
      bodyMd: env.size ? `Environment variables read by the code:\n\n${[...env].slice(0, 40).map((e) => `- \`${e}\``).join('\n')}` : 'No environment variable reads detected.',
      refs: [],
    });
    out.push({
      kind: 'dependencies',
      title: 'Dependencies',
      bodyMd: `${ctx.deps.filter((d) => !d.dev).length} runtime and ${ctx.deps.filter((d) => d.dev).length} dev dependencies. Run your ecosystem's audit tool (npm audit, pip-audit, govulncheck, cargo audit) for known CVEs.`,
      refs: [...new Set(ctx.deps.map((d) => d.manifest))].map((m) => ref(m)),
    });
    q.push(
      'What are the externally reachable entry points and how are they protected?',
      'How is user input validated before reaching the database or shell?',
      'Where are secrets loaded and could any leak into logs or responses?',
      'Are there injection risks (SQL, command, template, XSS)?',
      'How are sessions or tokens issued and verified?',
      'Which dependencies carry the most security risk?',
    );
  }
  if (cat === 'api') {
    const exported: string[] = [];
    const exRefs: ReturnType<typeof ref>[] = [];
    for (const f of ctx.files) {
      const fx = ctx.facts.get(f.path);
      if (!fx || fx.isTest) continue;
      const ex = fx.symbols.filter((s) => s.exported);
      if (ex.length && exported.length < 30) {
        exported.push(`- \`${f.path}\`: ${ex.slice(0, 8).map((s) => `\`${s.name}\``).join(', ')}`);
        exRefs.push(ref(f.path, ex[0].line));
      }
    }
    out.push({ kind: 'public-api', title: 'Public API surface', bodyMd: exported.join('\n') || 'No exported symbols detected.', refs: exRefs.slice(0, 12) });
    if (routes.length)
      out.push({
        kind: 'http-api',
        title: 'HTTP API',
        bodyMd: `| Method | Path | Handler |\n|---|---|---|\n${routes.slice(0, 50).map((r) => `| ${r.method} | \`${r.route}\` | \`${r.path}:${r.line}\` |`).join('\n')}`,
        refs: routes.slice(0, 12).map((r) => ref(r.path, r.line)),
      });
    for (const u of externalUsage(ctx).slice(0, 6)) {
      const dep = ctx.deps.find((d) => d.name === u.pkg);
      out.push({
        kind: 'library-usage',
        title: `Using ${u.pkg}`,
        bodyMd: `${dep ? `Declared as \`${dep.name}@${dep.version}\` in \`${dep.manifest}\`. ` : ''}Imported by ${u.files.length} file(s):\n\n${u.files.slice(0, 8).map((f) => `- \`${f}\``).join('\n')}`,
        refs: u.files.slice(0, 6).map((f) => ref(f)),
      });
    }
    q.push(
      'What is the public API of this project and how do I call it?',
      'Which third-party libraries are central and how are they used?',
      'How are errors and retries handled when calling external services?',
      'Show me an example of integrating with the main entry point.',
      'What does the HTTP API look like (endpoints, payloads, auth)?',
      'How are clients for external libraries initialized and shared?',
    );
  }
  if (cat === 'repository') {
    const r = ctx.repo;
    const h = r?.stats.history;
    const langs = r?.stats.languages.slice(0, 5).map((l) => `${l.lang} (${fmt(l.lines)} lines)`).join(', ');
    out.push({
      kind: 'overview',
      title: 'At a glance',
      bodyMd: [
        ctx.readme ? readmeIntro(ctx.readme, 600) : '',
        r ? `${fmt(r.stats.files)} files and ${fmt(r.stats.lines)} lines${langs ? `, mostly ${langs}` : ''}.` : '',
        h ? `${fmt(h.commits)} commits indexed${h.total > h.commits ? ` of ${fmt(h.total)}` : ''} from ${h.first?.slice(0, 10)} to ${h.last?.slice(0, 10)} by ${h.authors.length} author${h.authors.length === 1 ? '' : 's'}${h.shallow ? ' (shallow clone: older history was not fetched)' : ''}.` : 'No git history is available for this repository.',
      ].filter(Boolean).join('\n\n'),
      refs: [],
    });
    if (h) {
      const recentMonths = h.months.slice(-6);
      out.push({
        kind: 'activity',
        title: 'Activity over time',
        bodyMd: `| Month | Commits | Lines +/− |\n|---|---|---|\n${recentMonths.map((m) => `| ${m.month} | ${m.commits} | +${fmt(m.added)} / −${fmt(m.deleted)} |`).join('\n')}\n\nCommit types: ${Object.entries(h.types).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ')}.`,
        refs: [],
      });
      out.push({ kind: 'contributors', title: 'Contributors', bodyMd: h.authors.map((a) => `- **${a.author}**: ${a.commits} commits, +${fmt(a.added)} / −${fmt(a.deleted)} lines`).join('\n'), refs: [] });
      const hot = ctx.history?.hotspots ?? [];
      if (hot.length) out.push({ kind: 'hotspots', title: 'Hotspots & churn', bodyMd: hot.map((x: any) => `- \`${x.path}\`: ${x.n} commits, ${fmt(x.churn ?? 0)} lines changed`).join('\n'), refs: hot.slice(0, 6).map((x: any) => ref(x.path)) });
      out.push({ kind: 'recent', title: 'Recent changes', bodyMd: (r?.recent ?? []).slice(0, 12).map((c) => `- \`${c.sha.slice(0, 8)}\` ${c.date.slice(0, 10)} **${c.type}** ${c.subject} (${c.author})`).join('\n'), refs: [] });
    }
    q.push(
      ...(h
        ? ['What changed in the last month?', 'Who are the main contributors and what do they work on?', 'What were the biggest refactors?', 'Which files change most often, and why?', 'What bugs were fixed recently?', 'How has the project evolved over time?']
        : ['What is this project and how big is it?', 'Which languages and dependencies does it use?']),
    );
  }
  return { insights: out, questions: q };
}

export async function analyzeInsights(
  ctx: RepoContext,
  arch: Architecture,
  cats: Category[] = ['architecture', 'onboarding', 'security', 'api', 'repository'],
): Promise<{ insights: Insight[]; questions: SuggestedQuestion[] }> {
  let completed = 0;
  const results = await Promise.all(
    cats.map(async (cat) => {
      const heuristic = () => heuristicInsights(ctx, cat, arch);
      const res =
        ctx.llm.name === 'mock'
          ? heuristic()
          : await jsonWithFallback(
              ctx.llm,
              {
                name: `insights_${cat}`,
                maxTokens: 16_384,
                system: `You are an expert engineer producing the "${CATEGORY_LABELS[cat]}" section of a codebase knowledge base. ${GUIDES[cat]} Ground every statement in the provided facts and cite files as refs. Give line numbers only when they appear in the facts (routes, signals, symbols, numbered source); never guess them. Be concrete and concise; prefer bullet lists and tables.`,
                messages: [{ role: 'user', content: categoryFacts(ctx, cat, arch) }],
                schema: InsightsOut,
                heuristic,
              },
              ctx.warn,
            );
      ctx.progress(`Wrote ${CATEGORY_LABELS[cat]} insights`, ++completed / cats.length);
      return {
        insights: res.insights.map((i) => ({ ...i, category: cat, refs: cleanRefs(ctx, i.refs) })),
        questions: res.questions.slice(0, 8).map((question) => ({ category: cat, question })),
      };
    }),
  );
  return { insights: results.flatMap((r) => r.insights), questions: results.flatMap((r) => r.questions) };
}
