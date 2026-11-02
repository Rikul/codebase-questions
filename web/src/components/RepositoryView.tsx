import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CommitList, CommitListItem, CommitType, Insight, RepoStats, SizeBucket } from '@cq/shared';
import { COMMIT_TYPES, isUploadUrl, SIZE_BUCKETS } from '@cq/shared';
import { api } from '../lib/api';
import { useRepo } from '../lib/repoContext';
import { InsightCard, SuggestedQuestions } from './InsightsView';

/** Fixed categorical slots (validated palette in styles.css); 'other' is neutral. Labels always accompany the color. */
export const TYPE_COLOR: Record<CommitType, string> = {
  feat: 'var(--cat-1)', fix: 'var(--cat-2)', refactor: 'var(--cat-3)', chore: 'var(--cat-4)', docs: 'var(--cat-5)', test: 'var(--cat-6)', other: 'var(--cat-other)',
};
const LANG_SLOTS = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)'];
const fmt = (n: number) => n.toLocaleString();
const PAGE = 50;

/** Repository tab: statistics, the LLM-written overview, and the commit explorer. */
export function RepositoryView() {
  const { repo, askAbout } = useRepo();
  const [params, setParams] = useSearchParams();
  const [stats, setStats] = useState<RepoStats | null>(null);
  const [overview, setOverview] = useState<{ insights: Insight[]; questions: { question: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = params.get('rview') === 'commits' ? 'commits' : 'overview';
  const setView = (v: string) => setParams((p) => { p.set('rview', v); return p; });

  useEffect(() => {
    setStats(null);
    api<RepoStats>(`/repos/${repo.id}/repository/stats`).then(setStats, (e) => setError(e.message));
    api<any>(`/repos/${repo.id}/insights?category=repository`).then(setOverview, () => setOverview({ insights: [], questions: [] }));
  }, [repo.id, repo.updatedAt]);

  if (error) return <div className="empty">{error}</div>;
  if (!stats) return <div className="empty"><span className="spinner" /></div>;
  const h = stats.history;
  return (
    <div className="insights-main">
      <div className="insights-inner">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="grow">
            <div className="muted small" style={{ fontWeight: 600 }}>⎇ Repository</div>
            <h2 style={{ fontSize: 22, letterSpacing: '-0.01em' }}>{repo.name}</h2>
          </div>
          <button className="btn primary" onClick={() => askAbout({ category: 'repository' })}>Ask a repository question</button>
        </div>

        <div className="stat-row">
          <Stat label="Files" value={fmt(stats.files)} />
          <Stat label="Lines" value={fmt(stats.lines)} />
          {h && <Stat label="Commits" value={fmt(h.commits)} note={h.total > h.commits ? `of ${fmt(h.total)}` : h.shallow ? 'shallow clone' : undefined} />}
          {h && <Stat label="Contributors" value={fmt(h.authors.length)} note={h.authors.length >= 12 ? 'top 12 shown' : undefined} />}
          {h && <Stat label="Active" value={`${h.first?.slice(0, 7) ?? '?'} → ${h.last?.slice(0, 7) ?? '?'}`} />}
        </div>

        {stats.languages.length > 0 && <LanguageBar languages={stats.languages} total={stats.lines} />}
        {h && h.months.length > 1 && (
          <ActivityChart
            months={h.months}
            selected={params.get('cmonth')}
            onSelect={(m) => setParams((p) => { m ? p.set('cmonth', m) : p.delete('cmonth'); p.set('rview', 'commits'); return p; })}
          />
        )}

        <div className="seg-tabs">
          <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}>Overview</button>
          <button className={view === 'commits' ? 'active' : ''} onClick={() => setView('commits')}>Commits{h ? ` (${fmt(h.commits)})` : ''}</button>
        </div>

        {view === 'overview' && (
          <>
            {!overview && <div className="empty"><span className="spinner" /></div>}
            {overview && <SuggestedQuestions category="repository" questions={overview.questions} />}
            {overview?.insights.map((ins, i) => <InsightCard key={ins.id ?? i} ins={ins} category="repository" />)}
            {overview && !overview.insights.length && <div className="empty">No repository overview yet. Re-analyze to generate it.</div>}
          </>
        )}
        {view === 'commits' &&
          (h ? (
            <CommitExplorer stats={h} />
          ) : (
            <div className="card insight">
              {isUploadUrl(repo.url)
                ? <>This project was uploaded as a ZIP or folder, which carries no git history (any <code>.git</code> folder is left out), so there is no commit list. Add it by Git URL to explore its history.</>
                : <>No git history is available for this repository, so there is no commit list. Set <code>HISTORY_DEPTH</code> to 0 (full history) or a commit count, then re-analyze.</>}
            </div>
          ))}
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

/** Share of lines per language: top six in fixed slots, the rest folded into "Other". */
function LanguageBar({ languages, total }: { languages: RepoStats['languages']; total: number }) {
  const top = languages.slice(0, 6);
  const rest = Math.max(0, total - top.reduce((n, l) => n + l.lines, 0));
  const parts = [...top.map((l, i) => ({ name: l.lang, lines: l.lines, color: LANG_SLOTS[i] })), ...(rest > 0 ? [{ name: 'Other', lines: rest, color: 'var(--cat-other)' }] : [])].filter((p) => p.lines > 0);
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  return (
    <div className="card insight">
      <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>Languages (by lines)</div>
      <div className="lang-bar" role="img" aria-label={parts.map((p) => `${p.name} ${pct(p.lines).toFixed(1)}%`).join(', ')}>
        {parts.map((p) => (
          <span key={p.name} style={{ width: `${pct(p.lines)}%`, background: p.color }} title={`${p.name}: ${fmt(p.lines)} lines (${pct(p.lines).toFixed(1)}%)`} />
        ))}
      </div>
      <div className="lang-legend">
        {parts.map((p) => (
          <span key={p.name}><i style={{ background: p.color }} />{p.name} <span className="muted">{pct(p.lines).toFixed(1)}%</span></span>
        ))}
      </div>
    </div>
  );
}

/** Commits per month (one series, one hue). Hover for details; click a month to filter the commit list. */
function ActivityChart({ months, selected, onSelect }: { months: { month: string; commits: number; added: number; deleted: number }[]; selected: string | null; onSelect: (m: string | null) => void }) {
  // Fill gaps so quiet months show as empty slots, and keep the last 36 months.
  const series = useMemo(() => {
    const all: typeof months = [];
    const byMonth = new Map(months.map((m) => [m.month, m]));
    let [y, mo] = months[0].month.split('-').map(Number);
    const [ly, lm] = months[months.length - 1].month.split('-').map(Number);
    while (y < ly || (y === ly && mo <= lm)) {
      const key = `${y}-${String(mo).padStart(2, '0')}`;
      all.push(byMonth.get(key) ?? { month: key, commits: 0, added: 0, deleted: 0 });
      mo++;
      if (mo > 12) (mo = 1), y++;
    }
    return all.slice(-36);
  }, [months]);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((m) => m.commits));
  const W = 760;
  const H = 120;
  const slot = W / series.length;
  const bw = Math.max(2, slot - 2); // 2px surface gap between bars
  const hv = hover !== null ? series[hover] : null;
  return (
    <div className="card insight activity">
      <div className="row small" style={{ marginBottom: 6 }}>
        <b className="grow">Commits per month{series.length < months.length ? ' (last 36 months)' : ''}</b>
        {selected && <button className="btn sm ghost" onClick={() => onSelect(null)}>Clear month {selected} ✕</button>}
      </div>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H + 18}`} width="100%" preserveAspectRatio="none" style={{ height: H + 18, display: 'block' }} onMouseLeave={() => setHover(null)}>
          <line x1="0" x2={W} y1={H} y2={H} stroke="var(--border)" strokeWidth="1" />
          {series.map((m, i) => {
            const bh = m.commits ? Math.max(2, (m.commits / max) * (H - 6)) : 0;
            const x = i * slot + (slot - bw) / 2;
            const dim = selected && selected !== m.month;
            return (
              <g key={m.month} onMouseEnter={() => setHover(i)} onClick={() => m.commits && onSelect(selected === m.month ? null : m.month)} style={{ cursor: m.commits ? 'pointer' : 'default' }}>
                {/* Hit target is the whole column, larger than the bar. */}
                <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
                {bh > 0 && <path d={roundedTop(x, H - bh, bw, bh, Math.min(4, bw / 2))} fill="var(--cat-1)" opacity={dim ? 0.3 : hover === i ? 1 : 0.85} />}
              </g>
            );
          })}
          {series.map((m, i) => (i === 0 || m.month.endsWith('-01') || i === series.length - 1 ? (
            <text key={m.month} x={i * slot + slot / 2} y={H + 13} fontSize="10" textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'} fill="var(--text-3)">{m.month.endsWith('-01') && i !== 0 && i !== series.length - 1 ? m.month.slice(0, 4) : m.month}</text>
          ) : null))}
        </svg>
        {hv && (
          <div className="chart-tip" style={{ left: `${((hover! + 0.5) / series.length) * 100}%` }}>
            <b>{hv.month}</b>
            <div>{hv.commits} commit{hv.commits === 1 ? '' : 's'}</div>
            <div className="muted">+{fmt(hv.added)} / −{fmt(hv.deleted)} lines</div>
            {hv.commits > 0 && <div className="muted">Click to list them</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Bar with 4px rounded top corners, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

function CommitExplorer({ stats }: { stats: NonNullable<RepoStats['history']> }) {
  const { repo, openCommit } = useRepo();
  const [params, setParams] = useSearchParams();
  const types = (params.get('ctype') ?? '').split(',').filter(Boolean) as CommitType[];
  const sizes = (params.get('csize') ?? '').split(',').filter(Boolean) as SizeBucket[];
  const [min, max, q, author, month, sort] = ['cmin', 'cmax', 'cq', 'cauthor', 'cmonth', 'csort'].map((k) => params.get(k) ?? '');
  const [text, setText] = useState(q);
  const [list, setList] = useState<CommitList | null>(null);
  const [more, setMore] = useState<CommitListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const set = (k: string, v: string) => setParams((p) => { v ? p.set(k, v) : p.delete(k); return p; }, { replace: k === 'cq' || k === 'cmin' || k === 'cmax' });
  const toggle = (k: string, cur: string[], v: string) => set(k, (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]).join(','));

  // Debounce typing in the search box into the URL.
  useEffect(() => {
    if (text === q) return;
    const t = window.setTimeout(() => set('cq', text.trim()), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const query = useMemo(() => {
    const u = new URLSearchParams();
    if (types.length) u.set('type', types.join(','));
    if (sizes.length) u.set('size', sizes.join(','));
    if (min) u.set('min', min);
    if (max) u.set('max', max);
    if (q) u.set('q', q);
    if (author) u.set('author', author);
    if (sort) u.set('sort', sort);
    if (month) {
      u.set('since', `${month}-01`);
      u.set('until', `${month}-31T23:59:59Z`);
    }
    return u.toString();
  }, [types.join(), sizes.join(), min, max, q, author, month, sort]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setMore([]);
    api<CommitList>(`/repos/${repo.id}/commits?${query}&limit=${PAGE}`)
      .then((r) => active && setList(r))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [repo.id, query]);

  const shown = [...(list?.commits ?? []), ...more];
  const loadMore = () => api<CommitList>(`/repos/${repo.id}/commits?${query}&limit=${PAGE}&offset=${shown.length}`).then((r) => setMore((m) => [...m, ...r.commits]));
  const filtered = types.length || sizes.length || min || max || q || author || month;
  const maxLines = Math.max(1, ...shown.map((c) => c.added + c.deleted));

  return (
    <div className="card insight commits">
      <div className="filter-row">
        <span className="muted small filter-label">Type</span>
        {COMMIT_TYPES.map((t) => (
          <button key={t} className={`chip type-chip ${types.includes(t) ? 'on' : ''}`} style={{ ['--type-color' as string]: TYPE_COLOR[t] }} onClick={() => toggle('ctype', types, t)} disabled={!stats.types[t] && !types.includes(t)}>
            <i /> {t} <span className="muted">{fmt(stats.types[t])}</span>
          </button>
        ))}
      </div>
      <div className="filter-row">
        <span className="muted small filter-label">Size</span>
        {SIZE_BUCKETS.map((b) => (
          <button key={b.id} className={`chip ${sizes.includes(b.id) ? 'on' : ''}`} onClick={() => toggle('csize', sizes, b.id)} title={`${b.label} lines changed`} disabled={!stats.sizes[b.id] && !sizes.includes(b.id)}>
            {b.label} <span className="muted">{fmt(stats.sizes[b.id])}</span>
          </button>
        ))}
        <input className="input sm-input" type="number" min={0} placeholder="min lines" value={min} onChange={(e) => set('cmin', e.target.value)} aria-label="Minimum lines changed" />
        <input className="input sm-input" type="number" min={0} placeholder="max lines" value={max} onChange={(e) => set('cmax', e.target.value)} aria-label="Maximum lines changed" />
      </div>
      <div className="filter-row">
        <input className="input grow" placeholder="Search commit messages…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search commit messages" />
        <select className="input" value={author} onChange={(e) => set('cauthor', e.target.value)} aria-label="Author" style={{ maxWidth: 220 }}>
          <option value="">All authors</option>
          {stats.authors.map((a) => <option key={a.author} value={a.author}>{a.author} ({a.commits})</option>)}
        </select>
        <select className="input" value={sort} onChange={(e) => set('csort', e.target.value)} aria-label="Sort commits" style={{ maxWidth: 170 }}>
          <option value="">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="largest">Largest first</option>
        </select>
        {filtered && (
          <button className="btn sm ghost" onClick={() => { setText(''); setParams((p) => { for (const k of ['ctype', 'csize', 'cmin', 'cmax', 'cq', 'cauthor', 'cmonth']) p.delete(k); return p; }); }}>Clear filters</button>
        )}
      </div>
      <div className="muted small" style={{ margin: '8px 0' }}>
        {loading ? <span className="spinner" /> : `${fmt(list?.total ?? 0)} commit${list?.total === 1 ? '' : 's'}${month ? ` in ${month}` : ''}${filtered ? ' match' : ''}`}
      </div>
      <div className="commit-list">
        {shown.map((c) => (
          <button key={c.sha} className="commit-row" onClick={() => openCommit(c.sha)} title={`${c.sha}\n${c.subject}`}>
            <span className="chip type-chip on" style={{ ['--type-color' as string]: TYPE_COLOR[c.type] }}><i /> {c.type}</span>
            <span className="grow commit-subject">{c.subject}</span>
            <span className="commit-size" title={`+${fmt(c.added)} / −${fmt(c.deleted)} lines in ${c.files} file${c.files === 1 ? '' : 's'}`}>
              <span className="add">+{fmt(c.added)}</span> <span className="del">−{fmt(c.deleted)}</span>
              <span className="size-bar"><span style={{ width: `${Math.max(2, ((c.added + c.deleted) / maxLines) * 100)}%` }} /></span>
            </span>
            <span className="muted small commit-meta">{c.author} · {c.date.slice(0, 10)} · <code>{c.sha.slice(0, 7)}</code></span>
          </button>
        ))}
        {!loading && !shown.length && <div className="empty">No commits match these filters.</div>}
      </div>
      {list && shown.length < list.total && (
        <button className="btn" style={{ marginTop: 10 }} onClick={loadMore}>Load more ({fmt(list.total - shown.length)} left)</button>
      )}
    </div>
  );
}
