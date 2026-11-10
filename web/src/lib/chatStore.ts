import { useSyncExternalStore } from 'react';
import type { AgentStep, AskEvent, Category, ChatMessage, Citation } from '@cq/shared';
import { upsertStep } from '../components/AgentTrace';
import { api, ask } from './api';
import type { AskIntent } from './repoContext';

export interface UiMsg {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  category: Category | null;
  citations: Citation[];
  sources?: Citation[];
  streaming?: boolean;
  steps?: AgentStep[];
  notes?: string[];
}

export interface ChatState {
  convId: number | null;
  msgs: UiMsg[];
  busy: boolean;
  input: string;
  category: Category | null;
  focus: AskIntent['focus'] | null;
  /** Bumped whenever the conversation list may have changed. */
  convsVersion: number;
}

const initial = (): ChatState => ({ convId: null, msgs: [], busy: false, input: '', category: null, focus: null, convsVersion: 0 });

/**
 * Chat state and the in-flight answer for one repository. It lives outside the Ask tab's component,
 * so switching tabs (which unmounts the chat) neither loses the conversation nor the streaming answer.
 */
export class ChatStore {
  private state: ChatState = initial();
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;

  constructor(private repoId: string) {}

  get = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  set(patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    for (const fn of this.listeners) fn();
  }

  stop() {
    this.controller?.abort();
  }

  newChat() {
    this.stop();
    this.set({ convId: null, msgs: [], focus: null });
  }

  async openConv(id: number) {
    this.stop();
    this.set({ convId: id });
    const m = await api<ChatMessage[]>(`/repos/${this.repoId}/conversations/${id}`);
    if (this.state.convId !== id) return; // another conversation was opened meanwhile
    this.set({ msgs: m.map((x) => ({ key: String(x.id), role: x.role, content: x.content, category: x.category, citations: x.citations })) });
  }

  async send(text: string, cat: Category | null, foc: AskIntent['focus'] | null, cid: number | null) {
    const q = text.trim();
    if (!q || this.state.busy) return;
    const stamp = Date.now();
    const aKey = `a${stamp}`;
    this.set((s) => ({
      busy: true,
      input: '',
      msgs: [...s.msgs, { key: `u${stamp}`, role: 'user', content: q, category: cat, citations: [] }, { key: aKey, role: 'assistant', content: '', category: cat, citations: [], streaming: true }],
    }));
    const update = (fn: (m: UiMsg) => UiMsg) => this.set((s) => ({ msgs: s.msgs.map((m) => (m.key === aKey ? fn(m) : m)) }));
    const ctrl = new AbortController();
    this.controller = ctrl;
    try {
      await ask(
        this.repoId,
        { question: q, category: cat ?? undefined, conversationId: cid ?? undefined, focus: foc ? { componentId: foc.componentId, connectionId: foc.connectionId, path: foc.path, symbol: foc.symbol, snippet: foc.snippet } : undefined },
        (ev: AskEvent) => {
          if (ev.type === 'meta') {
            this.set((s) => ({ convId: ev.conversationId, convsVersion: s.convsVersion + 1 }));
            update((m) => ({ ...m, category: ev.category }));
          } else if (ev.type === 'sources') update((m) => ({ ...m, sources: ev.citations }));
          else if (ev.type === 'token') update((m) => ({ ...m, content: m.content + ev.text }));
          else if (ev.type === 'step') update((m) => ({ ...m, steps: upsertStep(m.steps ?? [], ev.step) }));
          else if (ev.type === 'reset') update((m) => ({ ...m, notes: [...(m.notes ?? []), ev.text.trim()].filter(Boolean), content: '' }));
          else if (ev.type === 'done') update((m) => ({ ...m, citations: ev.citations, streaming: false }));
          else if (ev.type === 'error') update((m) => ({ ...m, content: m.content + `\n\n**Error:** ${ev.message}`, streaming: false }));
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') update((m) => ({ ...m, content: m.content ? `${m.content}\n\n_(Stopped before the answer finished.)_` : '_(Stopped.)_' }));
      else update((m) => ({ ...m, content: `**Error:** ${(err as Error).message}` }));
    } finally {
      if (this.controller === ctrl) this.controller = null;
      update((m) => ({ ...m, streaming: false }));
      this.set((s) => ({ busy: false, convsVersion: s.convsVersion + 1 }));
    }
  }
}

const stores = new Map<string, ChatStore>();

export function chatStore(repoId: string): ChatStore {
  let s = stores.get(repoId);
  if (!s) stores.set(repoId, (s = new ChatStore(repoId)));
  return s;
}

/** Subscribe a component to a repository's chat store. */
export function useChat(repoId: string): [ChatState, ChatStore] {
  const store = chatStore(repoId);
  return [useSyncExternalStore(store.subscribe, store.get), store];
}
