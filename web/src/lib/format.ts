import type { Category, ComponentType, ConnectionKind } from '@cq/shared';
import { isUploadUrl, UPLOAD_URL_PREFIX } from '@cq/shared';

export const CATEGORY_META: Record<Category, { label: string; short: string; icon: string }> = {
  architecture: { label: 'Architecture & system design', short: 'Architecture', icon: '◇' },
  onboarding: { label: 'Code onboarding', short: 'Onboarding', icon: '➜' },
  security: { label: 'Security', short: 'Security', icon: '⛨' },
  api: { label: 'API & library integration', short: 'API & Libraries', icon: '⚙' },
  repository: { label: 'Repository & history', short: 'Repository', icon: '⎇' },
};

export const TYPE_COLORS: Record<ComponentType, string> = {
  frontend: 'var(--c-frontend)',
  api: 'var(--c-api)',
  service: 'var(--c-service)',
  library: 'var(--c-library)',
  database: 'var(--c-database)',
  queue: 'var(--c-queue)',
  worker: 'var(--c-worker)',
  cli: 'var(--c-cli)',
  config: 'var(--c-config)',
  external: 'var(--c-external)',
  test: 'var(--c-test)',
  other: 'var(--c-other)',
};

export const KIND_STYLE: Record<ConnectionKind, { dash?: string; color: string }> = {
  calls: { color: 'var(--edge-calls)' },
  http: { color: 'var(--edge-http)', dash: '6 4' },
  db: { color: 'var(--edge-db)' },
  queue: { color: 'var(--edge-queue)', dash: '2 4' },
  event: { color: 'var(--edge-queue)', dash: '2 4' },
  import: { color: 'var(--edge-calls)' },
  config: { color: 'var(--edge-config)', dash: '1 3' },
  other: { color: 'var(--edge-calls)' },
};

export function timeAgo(iso: string): string {
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp', swift: 'swift', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', hpp: 'cpp', scala: 'scala', sh: 'shellscript', bash: 'shellscript', sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', md: 'markdown', html: 'html', css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte', graphql: 'graphql', proto: 'proto',
};
export function langFromPath(p: string): string | undefined {
  const base = p.split('/').pop()!.toLowerCase();
  if (base.startsWith('dockerfile')) return 'docker';
  return EXT[base.split('.').pop() ?? ''];
}

/** Literal colors for SVG attributes (the minimap cannot resolve CSS variables). */

/** Human-readable source of a repository: its URL, or "Uploaded <name>" for ZIP/folder uploads. */
export const sourceLabel = (url: string) => (isUploadUrl(url) ? `Uploaded ${url.slice(UPLOAD_URL_PREFIX.length)}` : url);
