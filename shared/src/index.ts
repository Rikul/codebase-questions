import { z } from 'zod';

export const CATEGORIES = ['architecture', 'onboarding', 'security', 'api'] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const CATEGORY_LABELS: Record<Category, string> = {
  architecture: 'Architecture & system design',
  onboarding: 'Code onboarding',
  security: 'Security',
  api: 'API & library integration',
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
export type CodeRef = z.infer<typeof CodeRefSchema>;

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
  // Richer, LLM-derived fields (optional so older exports still load).
  layer: LayerSchema.optional(),
  group: z.string().optional(),
  parentId: z.string().optional(),
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
  bodyMd: z.string(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  refs: z.array(CodeRefSchema).default([]),
});
export type Insight = z.infer<typeof InsightSchema>;

export const SuggestedQuestionSchema = z.object({
  category: CategorySchema,
  question: z.string(),
});
export type SuggestedQuestion = z.infer<typeof SuggestedQuestionSchema>;

export type RepoStatus = 'queued' | 'running' | 'ready' | 'failed' | 'imported';

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

export interface FileEdge {
  from: string;
  to: string;
  kind: string;
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
  what: z.string().describe('What it is and its single main responsibility (markdown, 2-4 sentences, cite [path:start-end])'),
  howItFits: z.string().describe('How it fits with the rest of the project: component, layer, who depends on it and what it depends on (markdown)'),
  whenUsed: z.string().describe('When it is used at runtime: startup, per HTTP request (which routes), from a job, in tests, build time... Trace the chain (markdown)'),
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
      created: z.string().describe('When and by whom it was created/introduced, with commit sha (markdown). Say "on or before" if history is truncated.'),
      evolution: z.string().describe('How and why it changed over time, citing short commit shas (markdown, 2-5 sentences)'),
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

// ---------- Flows (sequence diagrams) ----------

export const FlowSchema = z.object({
  id: z.string(),
  title: z.string().describe('e.g. "Handle GET /users/:id"'),
  trigger: z.string().describe('What starts it: an HTTP route, CLI command, job, startup, user action'),
  summary: z.string().describe('2-3 sentence markdown summary'),
  participants: z
    .array(z.object({ id: z.string(), label: z.string(), componentId: z.string().optional().describe('architecture component id, if any') }))
    .describe('Ordered left-to-right lifelines: caller first'),
  steps: z
    .array(
      z.object({
        from: z.string().describe('participant id'),
        to: z.string().describe('participant id'),
        label: z.string().describe('function call or message, e.g. "getUser(id)" or "SELECT users"'),
        kind: z.enum(['call', 'return', 'async', 'db', 'http', 'event']),
        ref: CodeRefSchema.optional().describe('where this step happens in code'),
        note: z.string().optional(),
      }),
    )
    .describe('Messages in time order'),
});
export type Flow = z.infer<typeof FlowSchema>;

export type FlowEvent = AgentStreamEvent | { type: 'result'; flow: Flow };

// ---------- "Ask the diagram" ----------

export const DiagramAnswerSchema = z.object({
  answerMd: z.string().describe('Concise markdown answer with [path:start-end] citations'),
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
  flows: z.array(FlowSchema).optional(),
  explanations: z.array(z.object({ key: z.string(), fileHash: z.string(), content: z.string(), createdAt: z.string() })).optional(),
  history: z
    .object({
      commits: z.array(z.object({ sha: z.string(), seq: z.number(), author: z.string(), date: z.string(), subject: z.string(), body: z.string().nullable() })),
      fileCommits: z.array(z.object({ path: z.string(), sha: z.string(), status: z.string(), oldPath: z.string().nullable(), added: z.number().nullable(), deleted: z.number().nullable() })),
      shallow: z.boolean(),
      root: z.string().nullable(),
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
