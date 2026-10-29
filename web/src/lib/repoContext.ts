import { createContext, useContext } from 'react';
import type { Category, RepoSummary } from '@cq/shared';

export interface AskIntent {
  question?: string;
  category?: Category;
  focus?: { componentId?: string; connectionId?: string; path?: string; label: string };
  autoSend?: boolean;
}

export interface RepoCtx {
  repo: RepoSummary;
  openCode: (path: string, startLine?: number, endLine?: number) => void;
  askAbout: (intent: AskIntent) => void;
  openFile: (path: string) => void;
}

export const RepoContext = createContext<RepoCtx | null>(null);

export function useRepo(): RepoCtx {
  const c = useContext(RepoContext);
  if (!c) throw new Error('useRepo outside RepoContext');
  return c;
}
