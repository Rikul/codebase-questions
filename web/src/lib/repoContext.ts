import { createContext, useContext } from 'react';
import type { Category, RepoSummary } from '@cq/shared';

export interface AskIntent {
  question?: string;
  category?: Category;
  focus?: {
    componentId?: string;
    connectionId?: string;
    path?: string;
    symbol?: { name?: string; line?: number };
    snippet?: { text: string; startLine?: number; endLine?: number };
    label: string;
  };
  autoSend?: boolean;
}

export interface RepoCtx {
  repo: RepoSummary;
  openCode: (path: string, startLine?: number, endLine?: number) => void;
  askAbout: (intent: AskIntent) => void;
  /** Open the Files tab on a file, optionally explaining a symbol in it. */
  openFile: (path: string, symbol?: { name?: string; line?: number }) => void;
  /** Open the Review tab on a file's review (starting it if needed), or on the full codebase review. */
  openReview: (path?: string) => void;
  /** Open the commit viewer (optionally focused on one file's diff). */
  openCommit: (sha: string, path?: string) => void;
}

export const RepoContext = createContext<RepoCtx | null>(null);

export function useRepo(): RepoCtx {
  const c = useContext(RepoContext);
  if (!c) throw new Error('useRepo outside RepoContext');
  return c;
}
