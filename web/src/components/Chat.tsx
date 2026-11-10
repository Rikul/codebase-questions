import { useEffect, useRef, useState } from 'react';
import type { Category } from '@cq/shared';
import { AgentTrace } from './AgentTrace';
import { CATEGORIES } from '@cq/shared';
import { api } from '../lib/api';
import { useChat } from '../lib/chatStore';
import { CATEGORY_META } from '../lib/format';
import type { AskIntent } from '../lib/repoContext';
import { useRepo } from '../lib/repoContext';
import { Markdown } from './Markdown';

export function Chat({ intent, onIntentConsumed }: { intent: AskIntent | null; onIntentConsumed: () => void }) {
  const { repo, openCode } = useRepo();
  // The conversation and any answer still streaming live in a store, so they survive tab switches.
  const [{ convId, msgs, input, category, focus, busy, convsVersion }, store] = useChat(repo.id);
  const [convs, setConvs] = useState<{ id: number; title: string }[]>([]);
  const [suggested, setSuggested] = useState<{ category: Category; question: string }[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<any[]>(`/repos/${repo.id}/conversations`).then(setConvs).catch(() => undefined);
  }, [repo.id, convsVersion]);
  useEffect(() => {
    api<any>(`/repos/${repo.id}/insights`).then((r) => setSuggested(r.questions)).catch(() => undefined);
  }, [repo.id]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  const send = (text: string, cat: Category | null, foc: AskIntent['focus'] | null, cid: number | null) => void store.send(text, cat, foc, cid);
  const setInput = (v: string) => store.set({ input: v });
  const setCategory = (c: Category | null) => store.set({ category: c });
  const setFocus = (f: AskIntent['focus'] | null) => store.set({ focus: f });
  const openConv = (id: number) => void store.openConv(id).catch(() => undefined);
  const newChat = () => store.newChat();

  // Handle intents from other views ("Ask about this component", suggested questions, ...).
  useEffect(() => {
    if (!intent) return;
    onIntentConsumed();
    if (store.get().busy) {
      // An answer is still being written: keep it, and leave the new question ready to send after it.
      store.set({ ...(intent.category ? { category: intent.category } : {}), ...(intent.focus ? { focus: intent.focus } : {}), ...(intent.question ? { input: intent.question } : {}) });
      return;
    }
    if (intent.category) store.set({ category: intent.category });
    if (intent.focus || (intent.question && intent.autoSend)) store.newChat();
    if (intent.focus) store.set({ focus: intent.focus });
    if (intent.question && intent.autoSend) void store.send(intent.question, intent.category ?? null, intent.focus ?? null, null);
    else if (intent.question) store.set({ input: intent.question });
  }, [intent, onIntentConsumed, store]);

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
                    <button key={i} disabled={busy} onClick={() => send(s.question, s.category, focus, null)}>
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
              send(input, category, focus, convId);
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
                    send(input, category, focus, convId);
                  }
                }}
              />
              {busy ? (
                <button type="button" className="btn" onClick={() => store.stop()}>Stop</button>
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
