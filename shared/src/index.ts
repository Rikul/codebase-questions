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

export const ComponentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: ComponentTypeSchema,
  description: z.string(),
  responsibilities: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
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

export interface AskRequest {
  question: string;
  category?: Category;
  conversationId?: number;
  focus?: { componentId?: string; connectionId?: string; path?: string };
}

/** Streaming events sent by POST /api/repos/:id/ask (SSE). */
export type AskEvent =
  | { type: 'meta'; conversationId: number; category: Category }
  | { type: 'sources'; citations: Citation[] }
  | { type: 'token'; text: string }
  | { type: 'done'; messageId: number; citations: Citation[] }
  | { type: 'error'; message: string };

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
});
export type ProjectExport = z.infer<typeof ExportSchema>;
