import { z } from 'zod';

const WRAPPER_KEYS = ['markdown', 'md', 'text', 'content', 'value'];

/**
 * Models sometimes return a markdown field wrapped as `{"markdown": "..."}`, either as an object
 * or as that JSON in a string. Returns the markdown inside, or the value unchanged.
 */
export function unwrapMarkdown(v: unknown): unknown {
  const inner = (o: unknown): string | undefined => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const entries = Object.entries(o as Record<string, unknown>);
    const hit = entries.find(([k, x]) => WRAPPER_KEYS.includes(k.toLowerCase()) && typeof x === 'string') ?? (entries.length === 1 && typeof entries[0][1] === 'string' ? entries[0] : undefined);
    return hit?.[1] as string | undefined;
  };
  if (typeof v !== 'string') return inner(v) ?? v;
  const t = v.trim();
  if (!t.startsWith('{')) return v;
  try {
    return inner(JSON.parse(t)) ?? v;
  } catch {
    // Truncated or not quite JSON: take the text after a known wrapper key.
    const m = /^\{\s*"(?:markdown|md|text|content|value)"\s*:\s*"([\s\S]*?)(?:(?<!\\)"\s*\}?)?$/i.exec(t);
    if (!m) return v;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
  }
}

/** A markdown string field filled by a model (unwraps `{"markdown": ...}`). */
export const markdownField = (description?: string) => {
  const s = z.preprocess(unwrapMarkdown, z.string());
  return description ? s.describe(description) : s;
};

export * from './archView';

/** Paths never analyzed (gitignore syntax). Shared so the browser can skip them when uploading a folder. */
export const DEFAULT_IGNORES = [
  '.git', 'node_modules', 'vendor', 'third_party', 'bower_components', 'dist', 'build', 'out', 'target', 'obj',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache',
  '.pytest_cache', '.gradle', '.idea', '.vscode', 'Pods', 'DerivedData', '*.min.js', '*.min.css', '*.map', '*.lock',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.ico', '*.icns', '*.pdf', '*.zip', '*.gz', '*.tgz', '*.jar', '*.war',
  '*.so', '*.dylib', '*.dll', '*.exe', '*.wasm', '*.woff', '*.woff2', '*.ttf', '*.eot', '*.otf', '*.mp3', '*.mp4', '*.mov',
  '*.svg', '*.pyc', '*.class', '*.o', '*.a', '*.bin', '*.dat', '*.db', '*.sqlite', '*.pkl', '*.parquet', '*.onnx', '*.pt',
];

/**
 * Repositories uploaded as a ZIP or folder have a url like `upload:name.zip`. They have no remote;
 * they have git history when the upload includes the project's top-level `.git` folder.
 */
export const UPLOAD_URL_PREFIX = 'upload:';
export const isUploadUrl = (url: string) => url.startsWith(UPLOAD_URL_PREFIX);

const UPLOAD_GIT_PATHS = [
  /^(HEAD|packed-refs|shallow)$/,
  /^refs\/[\w.\-/]+$/,
  /^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/,
  /^objects\/pack\/(pack-[0-9a-f]{40}\.(pack|idx|rev|bitmap)|multi-pack-index)$/,
  /^objects\/info\/(commit-graph|commit-graphs\/(commit-graph-chain|graph-[0-9a-f]{40}\.graph))$/,
];

/**
 * Whether a path inside an uploaded top-level `.git` folder is kept. Only what git needs to read
 * history is kept: HEAD, refs and objects. Config, hooks, info/ (attributes, grafts), alternates,
 * worktrees and modules are dropped, because they can make git run commands or read outside the
 * checkout. The server writes its own minimal config.
 */
export function isUploadGitPath(inner: string): boolean {
  return !inner.split('/').some((s) => s === '..' || s === '.' || !s) && UPLOAD_GIT_PATHS.some((re) => re.test(inner));
}

export const CATEGORIES = ['architecture', 'onboarding', 'security', 'api', 'repository'] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const CATEGORY_LABELS: Record<Category, string> = {
  architecture: 'Architecture & system design',
  onboarding: 'Code onboarding',
  security: 'Security',
  api: 'API & library integration',
  repository: 'Repository & history',
};

export const COMPONENT_TYPES = [
  'frontend',
  'service',
  'api',
  'library',
  'database',
  'queue',
  'worker',
  'cli',
  'config',
  'external',
  'test',
  'other',
] as const;
export const ComponentTypeSchema = z.enum(COMPONENT_TYPES);
export type ComponentType = z.infer<typeof ComponentTypeSchema>;

export const CONNECTION_KINDS = ['calls', 'http', 'db', 'queue', 'event', 'import', 'config', 'other'] as const;
export const ConnectionKindSchema = z.enum(CONNECTION_KINDS);
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>;

export const CodeRefSchema = z.object({
  path: z.string(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  note: z.string().optional(),
});

export const LAYERS = ['entry', 'interface', 'core', 'data', 'infra', 'external'] as const;
export const LayerSchema = z.enum(LAYERS);
export type Layer = z.infer<typeof LayerSchema>;

export const ComponentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: ComponentTypeSchema,
  description: z.string(),
  responsibilities: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  // Optional so older exports still load.
  layer: LayerSchema.optional(),
  group: z.string().optional(),
  /** Enclosing component (package → module → directory). */
  parentId: z.string().optional(),
  /** Shown opened up (as a container of its children) when the diagram first loads. */
  expandByDefault: z.boolean().optional(),
  /** Readable name written by the LLM (the static `name` stays as the identifier shown beside it). */
  label: z.string().optional(),
  /** One-sentence LLM summary of what the component does. */
  summary: z.string().optional(),
  keyFiles: z.array(z.string()).optional(),
  entryPoints: z.array(z.string()).optional(),
  techStack: z.array(z.string()).optional(),
});
export type Component = z.infer<typeof ComponentSchema>;

export const ConnectionSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: ConnectionKindSchema,
  label: z.string(),
  description: z.string(),
  evidence: z.array(CodeRefSchema).default([]),
  sync: z.enum(['sync', 'async']).optional(),
  protocol: z.string().optional(),
  dataExchanged: z.string().optional(),
  direction: z.enum(['request', 'response', 'bidirectional']).optional(),
  confidence: z.enum(['verified', 'inferred']).optional(),
  /** How many links (imports, API calls) this connection stands for. */
  weight: z.number().optional(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ArchitectureSchema = z.object({
  overview: z.string(),
  components: z.array(ComponentSchema),
  connections: z.array(ConnectionSchema),
});
export type Architecture = z.infer<typeof ArchitectureSchema>;

export const InsightSchema = z.object({
  id: z.number().optional(),
  category: CategorySchema,
  kind: z.string(),
  title: z.string(),
  bodyMd: markdownField(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  refs: z.array(CodeRefSchema).default([]),
});
export type Insight = z.infer<typeof InsightSchema>;

export const SuggestedQuestionSchema = z.object({
  category: CategorySchema,
  question: z.string(),
});
export type SuggestedQuestion = z.infer<typeof SuggestedQuestionSchema>;

export type RepoStatus = 'queued' | 'running' | 'enriching' | 'ready' | 'failed' | 'imported';

export interface RepoSummary {
  id: string;
  name: string;
  url: string;
  commit: string | null;
  status: RepoStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  hasSource: boolean;
  currentJobId: string | null;
}

export interface JobEvent {
  jobId: string;
  stage: string;
  message: string;
  progress: number; // 0..1
  done?: boolean;
  error?: string;
}

export interface FileNode {
  path: string;
  type: 'file' | 'dir';
  lang?: string;
  size?: number;
  summary?: string | null;
  children?: FileNode[];
}


export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  category: Category | null;
  citations: Citation[];
  createdAt: string;
}

export interface AskFocus {
  componentId?: string;
  connectionId?: string;
  path?: string;
  symbol?: { name?: string; line?: number };
  snippet?: { text: string; startLine?: number; endLine?: number };
}

export interface AskRequest {
  question: string;
  category?: Category;
  conversationId?: number;
  focus?: AskFocus;
}

/** One investigation step the agent took (shown as a live trace in the UI). */
export interface AgentStep {
  id: string;
  label: string;
  tool: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
}

/** Events shared by every agent-backed SSE stream. */
export type AgentStreamEvent =
  | { type: 'step'; step: AgentStep }
  | { type: 'token'; text: string }
  | { type: 'reset'; text: string }
  | { type: 'error'; message: string };

/** Streaming events sent by POST /api/repos/:id/ask (SSE). */
export type AskEvent =
  | { type: 'meta'; conversationId: number; category: Category }
  | { type: 'sources'; citations: Citation[] }
  | { type: 'token'; text: string }
  | { type: 'step'; step: AgentStep }
  | { type: 'reset'; text: string }
  | { type: 'done'; messageId: number; citations: Citation[] }
  | { type: 'error'; message: string };

// ---------- Explanations ----------

const LinkSchema = z.object({
  path: z.string(),
  line: z.number().int().optional(),
  symbol: z.string().optional().describe('enclosing function/class at that location'),
  why: z.string().describe('one sentence: what happens there and why'),
});

export const ExplanationSchema = z.object({
  what: markdownField('What it is and its single main responsibility (markdown, 2-4 sentences, cite [path:start-end])'),
  howItFits: markdownField('How it fits with the rest of the project: component, layer, who depends on it and what it depends on (markdown)'),
  whenUsed: markdownField('When it is used at runtime: startup, per HTTP request (which routes), from a job, in tests, build time... Trace the chain (markdown)'),
  contains: z
    .array(z.object({ name: z.string(), kind: z.string(), line: z.number().int().optional(), description: z.string() }))
    .describe('Important functions/classes/variables it contains (for a symbol: its key parameters, fields, or inner steps)'),
  callers: z.array(LinkSchema).describe('Who calls/uses it, verified with find_references'),
  callees: z.array(LinkSchema.extend({ path: z.string().describe('file path, or package name for external libraries') })).describe('What it calls/depends on'),
  signature: z.string().optional().describe('For symbols: the signature'),
  examples: z.array(z.object({ path: z.string(), line: z.number().int().optional(), note: z.string() })).optional().describe('Representative usage examples'),
  gotchas: z.array(z.string()).optional().describe('Pitfalls, side effects, error handling or security notes worth knowing'),
  history: z
    .object({
      created: markdownField('When and by whom it was created/introduced, with commit sha (markdown). Say "on or before" if history is truncated.'),
      evolution: markdownField('How and why it changed over time, citing short commit shas (markdown, 2-5 sentences)'),
      keyCommits: z.array(z.object({ sha: z.string(), date: z.string().optional(), why: z.string() })).describe('The most important commits in its history'),
    })
    .optional()
    .describe('Git history: only when history tools return data'),
});
export type Explanation = z.infer<typeof ExplanationSchema>;

export interface ExplainRequest {
  path: string;
  symbol?: { name?: string; line?: number };
  snippet?: { text: string; startLine?: number; endLine?: number };
  refresh?: boolean;
}

export interface ExplainTarget {
  kind: 'file' | 'symbol' | 'snippet';
  path: string;
  name?: string;
  symbolKind?: string;
  line?: number;
  endLine?: number;
}

export type ExplainEvent =
  | AgentStreamEvent
  | { type: 'target'; target: ExplainTarget }
  | { type: 'result'; explanation: Explanation; cached: boolean; createdAt: string };

// ---------- "Ask the diagram" ----------

export const DiagramAnswerSchema = z.object({
  answerMd: markdownField('Concise markdown answer with [path:start-end] citations'),
  highlight: z.object({ componentIds: z.array(z.string()), connectionIds: z.array(z.string()) }),
  tour: z
    .array(
      z.object({
        componentId: z.string().optional(),
        connectionId: z.string().optional(),
        caption: z.string().describe('One or two sentences for this stop'),
        ref: CodeRefSchema.optional(),
      }),
    )
    .describe('Ordered walkthrough of the answer across the diagram'),
});
export type DiagramAnswer = z.infer<typeof DiagramAnswerSchema>;
export type DiagramEvent = AgentStreamEvent | { type: 'result'; answer: DiagramAnswer; cached: boolean };

// ---------- Code review ----------

export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
export const REVIEW_KINDS = ['bug', 'security', 'performance', 'reliability', 'maintainability', 'design', 'testing'] as const;

export const ReviewFindingSchema = z.object({
  severity: z.enum(REVIEW_SEVERITIES).catch('low'),
  kind: z.enum(REVIEW_KINDS).catch('maintainability'),
  title: z.string().describe('One line naming the problem'),
  path: z.string().optional().describe('File the problem is in'),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
  detail: z.string().describe('Markdown: what is wrong, why it matters, and the evidence (cite [path:start-end])'),
  suggestion: z.string().optional().describe('Markdown: a concrete fix'),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewSchema = z.object({
  summaryMd: markdownField('Markdown overview: overall quality, the main risks, and what to fix first'),
  strengths: z.array(z.string()).optional().describe('A few things the code does well'),
  findings: z.array(ReviewFindingSchema).describe('Concrete problems, most severe first'),
});
export type Review = z.infer<typeof ReviewSchema>;

/** Sidebar entry for a stored review: the full codebase review has no path. */
export interface ReviewEntry {
  path: string | null;
  createdAt: string;
  findings: number;
  worst: ReviewSeverity | null;
  /** File reviews only: the file changed since it was reviewed. */
  stale?: boolean;
}

/** GET /api/repos/:id/reviews: stored reviews plus the ones running now. */
export interface ReviewList {
  reviews: ReviewEntry[];
  running: { full: boolean; files: string[] };
}

export interface ReviewRequest {
  /** File to review; omit for the full codebase review. */
  path?: string;
  refresh?: boolean;
}

export type ReviewEvent = AgentStreamEvent | { type: 'result'; path: string | null; review: Review; cached: boolean; createdAt: string };

// ---------- Repository: commit types, sizes and stats ----------

export const COMMIT_TYPES = ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'other'] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

/** Commit size by lines changed (added + deleted); max is exclusive. */
export const SIZE_BUCKETS = [
  { id: 'XS', label: 'XS · <10', min: 0, max: 10 },
  { id: 'S', label: 'S · 10–49', min: 10, max: 50 },
  { id: 'M', label: 'M · 50–249', min: 50, max: 250 },
  { id: 'L', label: 'L · 250–999', min: 250, max: 1000 },
  { id: 'XL', label: 'XL · 1000+', min: 1000, max: Infinity },
] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number]['id'];

export interface CommitListItem {
  sha: string;
  author: string;
  date: string;
  subject: string;
  type: CommitType;
  added: number;
  deleted: number;
  files: number;
}

export interface CommitList {
  total: number;
  commits: CommitListItem[];
}

export interface RepoStats {
  files: number;
  lines: number;
  languages: { lang: string; files: number; lines: number }[];
  history: null | {
    commits: number;
    total: number;
    shallow: boolean;
    capped: boolean;
    first: string | null;
    last: string | null;
    authors: { author: string; commits: number; added: number; deleted: number }[];
    months: { month: string; commits: number; added: number; deleted: number }[];
    types: Record<CommitType, number>;
    sizes: Record<SizeBucket, number>;
    biggest: CommitListItem[];
  };
}

// ---------- Export format ----------

export const EXPORT_FORMAT = 'codebase-questions/v1';

export const ExportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  exportedAt: z.string(),
  repo: z.object({ name: z.string(), url: z.string(), commit: z.string().nullable() }),
  files: z.array(
    z.object({
      path: z.string(),
      lang: z.string().nullable(),
      size: z.number(),
      hash: z.string(),
      summary: z.string().nullable(),
    }),
  ),
  fileEdges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })),
  architecture: ArchitectureSchema.nullable(),
  insights: z.array(InsightSchema),
  suggestedQuestions: z.array(SuggestedQuestionSchema),
  conversations: z.array(
    z.object({
      title: z.string(),
      createdAt: z.string(),
      messages: z.array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string(),
          category: CategorySchema.nullable(),
          citations: z.array(z.object({ path: z.string(), startLine: z.number(), endLine: z.number() })),
          createdAt: z.string(),
        }),
      ),
    }),
  ),
  chunks: z
    .array(z.object({ path: z.string(), startLine: z.number(), endLine: z.number(), content: z.string() }))
    .optional(),
  /** Flows (sequence diagrams) were removed; still accepted so older exports import, but ignored. */
  flows: z.array(z.unknown()).optional(),
  explanations: z.array(z.object({ key: z.string(), fileHash: z.string(), content: z.string(), createdAt: z.string() })).optional(),
  reviews: z.array(z.object({ key: z.string(), version: z.string(), content: z.string(), createdAt: z.string() })).optional(),
  history: z
    .object({
      commits: z.array(
        z.object({
          sha: z.string(), seq: z.number(), author: z.string(), date: z.string(), subject: z.string(), body: z.string().nullable(),
          type: z.string().nullable().optional(), typeSource: z.string().nullable().optional(), added: z.number().nullable().optional(), deleted: z.number().nullable().optional(), files: z.number().nullable().optional(),
        }),
      ),
      fileCommits: z.array(z.object({ path: z.string(), sha: z.string(), status: z.string(), oldPath: z.string().nullable(), added: z.number().nullable(), deleted: z.number().nullable() })),
      shallow: z.boolean(),
      root: z.string().nullable(),
      boundaries: z.array(z.string()).optional(),
      total: z.number().optional(),
    })
    .optional(),
  refs: z
    .array(z.object({ name: z.string(), path: z.string(), line: z.number(), kind: z.string(), fromSymbol: z.string().nullable(), targetPath: z.string().nullable(), targetLine: z.number().nullable(), confidence: z.string() }))
    .optional(),
  symbols: z
    .array(z.object({ path: z.string(), name: z.string(), kind: z.string(), line: z.number(), endLine: z.number(), exported: z.boolean(), parent: z.string().nullable(), signature: z.string().nullable() }))
    .optional(),
});
export type ProjectExport = z.infer<typeof ExportSchema>;

/** Ordered analysis stages shared by job reporting and the progress UI. */
export const ANALYSIS_STEPS = [
  { id: 'clone', label: 'Clone or update repository' },
  { id: 'scan', label: 'Scan files' },
  { id: 'parse', label: 'Parse imports, routes and signals' },
  { id: 'index', label: 'Build search index' },
  { id: 'history', label: 'Index git history' },
  { id: 'summarize', label: 'Summarize key files with the LLM' },
  { id: 'insights', label: 'Write architecture, onboarding, security and API insights' },
  { id: 'store', label: 'Save insights and architecture diagram' },
  { id: 'review', label: 'Review the codebase in background' },
] as const;

export function analysisProgress(stage: string, fraction = 0): number {
  if (stage === 'done') return 1;
  const index = ANALYSIS_STEPS.findIndex((step) => step.id === (stage === 'embed' ? 'index' : stage));
  return index < 0 ? 0 : (index + Math.max(0, Math.min(1, fraction))) / ANALYSIS_STEPS.length;
}
