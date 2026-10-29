import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStep, AskEvent, Category, ChatMessage, Citation } from '@cq/shared';
import { AgentTrace, upsertStep } from './AgentTrace';
import { CATEGORIES } from '@cq/shared';
import { api, ask } from '../lib/api';
import { CATEGORY_META } from '../lib/format';
import type { AskIntent } from '../lib/repoContext';
import { useRepo } from '../lib/repoContext';
import { Markdown } from './Markdown';

interface UiMsg {
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

export function Chat({ intent, onIntentConsumed }: { intent: AskIntent | null; onIntentConsumed: () => void }) {
  const { repo, openCode } = useRepo();
  const [convs, setConvs] = useState<{ id: number; title: string }[]>([]);
  const [convId, setConvId] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [input, setInput] = useState('');
  const [category, setCategory] = useState<Category | null>(null);
  const [focus, setFocus] = useState<AskIntent['focus'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggested, setSuggested] = useState<{ category: Category; question: string }[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadConvs = useCallback(() => api<any[]>(`/repos/${repo.id}/conversations`).then(setConvs).catch(() => undefined), [repo.id]);
  useEffect(() => {
    loadConvs();
    api<any>(`/repos/${repo.id}/insights`).then((r) => setSuggested(r.questions)).catch(() => undefined);
  }, [repo.id, loadConvs]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  const openConv = async (id: number) => {
    abortRef.current?.abort();
    setConvId(id);
    const m = await api<ChatMessage[]>(`/repos/${repo.id}/conversations/${id}`);
    setMsgs(m.map((x) => ({ key: String(x.id), role: x.role, content: x.content, category: x.category, citations: x.citations })));
  };

  const newChat = () => {
    abortRef.current?.abort();
    setConvId(null);
    setMsgs([]);
    setFocus(null);
  };

  const send = useCallback(
    async (text: string, cat: Category | null, foc: AskIntent['focus'] | null, cid: number | null) => {
      const q = text.trim();
      if (!q) return;
      setBusy(true);
      setInput('');
      const userKey = `u${Date.now()}`;
      const aKey = `a${Date.now()}`;
      setMsgs((m) => [...m, { key: userKey, role: 'user', content: q, category: cat, citations: [] }, { key: aKey, role: 'assistant', content: '', category: cat, citations: [], streaming: true }]);
      const update = (fn: (m: UiMsg) => UiMsg) => setMsgs((ms) => ms.map((m) => (m.key === aKey ? fn(m) : m)));
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await ask(
          repo.id,
          { question: q, category: cat ?? undefined, conversationId: cid ?? undefined, focus: foc ? { componentId: foc.componentId, connectionId: foc.connectionId, path: foc.path, symbol: foc.symbol, snippet: foc.snippet } : undefined },
          (ev: AskEvent) => {
            if (ev.type === 'meta') {
              setConvId(ev.conversationId);
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
        if ((err as Error).name !== 'AbortError') update((m) => ({ ...m, content: `**Error:** ${(err as Error).message}`, streaming: false }));
      } finally {
        update((m) => ({ ...m, streaming: false }));
        setBusy(false);
        loadConvs();
      }
    },
    [repo.id, loadConvs],
  );

  // Handle intents from other views ("Ask about this component", suggested questions, ...).
  useEffect(() => {
    if (!intent) return;
    onIntentConsumed();
    if (intent.category) setCategory(intent.category);
    if (intent.focus) {
      setFocus(intent.focus);
      setConvId(null);
      setMsgs([]);
    }
    if (intent.question && intent.autoSend) {
      setConvId(null);
      setMsgs([]);
      void send(intent.question, intent.category ?? null, intent.focus ?? null, null);
    } else if (intent.question) setInput(intent.question);
  }, [intent, onIntentConsumed, send]);

  const shownSuggestions = suggested.filter((s) => !category || s.category === category).slice(0, 8);

  return (
    <div className="chat">
      <nav className="chat-side">
        <button className="btn sm" style={{ marginBottom: 8, textAlign: 'center' }} onClick={newChat}>+ New chat</button>
        {convs.map((c) => (
          <button key={c.id} className={c.id === convId ? 'active' : ''} onClick={() => openConv(c.id)} title={c.title}>{c.title}</button>
        ))}
        {!convs.length && <div className="muted small" style={{ padding: 8 }}>No conversations yet.</div>}
      </nav>
      <div className="chat-main">
        <div className="messages">
          <div className="messages-inner">
            {!msgs.length && (
              <div style={{ padding: '24px 0' }}>
                <h2 style={{ fontSize: 20 }}>Ask anything about {repo.name}</h2>
                <p className="muted">Answers draw on the generated knowledge base and the relevant source code, with clickable citations.</p>
                <div className="suggest" style={{ marginTop: 14 }}>
                  {shownSuggestions.map((s, i) => (
                    <button key={i} onClick={() => send(s.question, s.category, focus, null)}>
                      <span className="muted">{CATEGORY_META[s.category].icon}</span> {s.question}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m) =>
              m.role === 'user' ? (
                <div key={m.key} className="msg user">{m.content}</div>
              ) : (
                <div key={m.key} className="msg assistant card">
                  {m.category && <div className="chip" style={{ marginBottom: 8 }}>{CATEGORY_META[m.category].icon} {CATEGORY_META[m.category].short}</div>}
                  {(m.steps?.length ?? 0) > 0 && <AgentTrace steps={m.steps!} running={Boolean(m.streaming) && !m.content} notes={m.notes} />}
                  {m.content ? <Markdown>{m.content}</Markdown> : m.streaming && !(m.steps?.length) ? <span className="spinner" /> : null}
                  {!m.streaming && (m.citations.length > 0 || (m.sources?.length ?? 0) > 0) && (
                    <div className="refs">
                      <span className="muted small">Sources:</span>
                      {(m.citations.length ? m.citations : m.sources!).slice(0, 10).map((c, i) => (
                        <button key={i} className="cite" onClick={() => openCode(c.path, c.startLine, c.endLine)}>{c.path}:{c.startLine}</button>
                      ))}
                    </div>
                  )}
                </div>
              ),
            )}
            <div ref={endRef} />
          </div>
        </div>
        <div className="composer">
          <form
            className="composer-inner"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input, category, focus, convId);
            }}
          >
            {focus && (
              <div className="focus-bar">
                <span className="grow">Focused on <b>{focus.label}</b></span>
                <button type="button" className="btn sm ghost" onClick={() => setFocus(null)}>✕</button>
              </div>
            )}
            <div className="cat-pills">
              <button type="button" className={!category ? 'active' : ''} onClick={() => setCategory(null)}>Auto-detect</button>
              {CATEGORIES.map((c) => (
                <button type="button" key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>
                  {CATEGORY_META[c].icon} {CATEGORY_META[c].short}
                </button>
              ))}
            </div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <textarea
                className="input grow"
                rows={2}
                placeholder={category ? `Ask a ${CATEGORY_META[category].short.toLowerCase()} question…` : 'Ask about architecture, onboarding, security or APIs…'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(input, category, focus, convId);
                  }
                }}
              />
              {busy ? (
                <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>Stop</button>
              ) : (
                <button className="btn primary" disabled={!input.trim()}>Ask</button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
