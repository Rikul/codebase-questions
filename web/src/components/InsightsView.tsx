import { useEffect, useState } from 'react';
import type { Category, Insight } from '@cq/shared';
import { api } from '../lib/api';
import { CATEGORY_META } from '../lib/format';
import { useRepo } from '../lib/repoContext';
import { Markdown } from './Markdown';

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

export function InsightsView({ category }: { category: Category }) {
  const { repo, askAbout } = useRepo();
  const [data, setData] = useState<{ insights: Insight[]; questions: { question: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api<any>(`/repos/${repo.id}/insights?category=${category}`).then(setData, (e) => setError(e.message));
  }, [repo.id, category, repo.updatedAt]);

  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="empty"><span className="spinner" /></div>;

  let insights = data.insights;
  const findings = insights.filter((i) => i.kind === 'finding');
  if (category === 'security') {
    insights = [...insights.filter((i) => i.kind !== 'finding'), ...findings.sort((a, b) => SEV_ORDER.indexOf(a.severity ?? 'info') - SEV_ORDER.indexOf(b.severity ?? 'info'))];
  }
  const meta = CATEGORY_META[category];
  return (
    <div className="insights-main">
      <div className="insights-inner">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow">
            <div className="muted small" style={{ fontWeight: 600 }}>{meta.icon} Knowledge base</div>
            <h2 style={{ fontSize: 22, letterSpacing: '-0.01em' }}>{meta.label}</h2>
          </div>
          <button className="btn primary" onClick={() => askAbout({ category })}>Ask a {meta.short.toLowerCase()} question</button>
        </div>
        {category === 'security' && findings.length > 0 && (
          <div className="card insight">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <b className="grow">{findings.length} potential finding{findings.length > 1 ? 's' : ''}</b>
              <div className="sev-summary">
                {SEV_ORDER.map((s) => {
                  const n = findings.filter((f) => (f.severity ?? 'info') === s).length;
                  return n ? <span key={s} className={`sev ${s}`}>{n} {s}</span> : null;
                })}
              </div>
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>Findings come from code-pattern detection plus model review. Check each one against the cited code before acting on it.</div>
          </div>
        )}
        <SuggestedQuestions category={category} questions={data.questions} />
        {insights.map((ins, i) => (
          <InsightCard key={ins.id ?? i} ins={ins} category={category} />
        ))}
        {!insights.length && <div className="empty">No insights for this category.</div>}
      </div>
    </div>
  );
}

/** Suggested questions for a category; each one opens Ask and sends it. */
export function SuggestedQuestions({ category, questions }: { category: Category; questions: { question: string }[] }) {
  const { askAbout } = useRepo();
  if (!questions.length) return null;
  return (
    <div className="card insight">
      <h4 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Suggested questions</h4>
      <div className="suggest">
        {questions.map((q, i) => (
          <button key={i} onClick={() => askAbout({ category, question: q.question, autoSend: true })}>{q.question}</button>
        ))}
      </div>
    </div>
  );
}

/** One knowledge-base section: title, markdown body, code references and an "Ask more" button. */
export function InsightCard({ ins, category }: { ins: Insight; category: Category }) {
  const { askAbout, openCode } = useRepo();
  return (
    <article className="card insight">
      <div className="insight-head">
        {ins.severity && ins.kind === 'finding' && <span className={`sev ${ins.severity}`}>{ins.severity}</span>}
        <h3 className="grow">{ins.title}</h3>
        <button className="btn sm ghost" onClick={() => askAbout({ category, question: `Tell me more about "${ins.title}".`, autoSend: true })}>Ask more</button>
      </div>
      <Markdown>{ins.bodyMd}</Markdown>
      {ins.refs.length > 0 && (
        <div className="refs">
          {ins.refs.slice(0, 12).map((r, j) => (
            <button key={j} className="cite" onClick={() => openCode(r.path, r.startLine, r.endLine)} title={r.note}>
              {r.path}{r.startLine ? `:${r.startLine}` : ''}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
