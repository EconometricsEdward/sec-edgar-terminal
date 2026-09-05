'use client';
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, Search, Star } from 'lucide-react';
import { MARKET_METRICS, formatMarket, isNumber, metricStats, isOlderReport, baselineChanges } from '../../utils/marketResearch.js';
import type { Basis, Company, MarketData, MarketView, Saved } from './marketTypes';
import s from './market.module.css';

export function Briefing({ companies, data, basis, onScreen }: { companies: Company[]; data: MarketData; basis: Basis; onScreen: (screen: string) => void }) {
  const growth = metricStats(companies, basis, 'revenueGrowth');
  const profit = metricStats(companies, basis, 'netIncome');
  const cash = metricStats(companies, basis, 'cashFlowMargin');
  const older = companies.filter((c) => isOlderReport(c, basis, data.generatedAt)).length;
  const cards = [
    { title: 'Growing revenue', value: formatMarket(growth.positivePct, 'pct', 0), note: `${growth.positive} of ${growth.count} with comparable revenue`, screen: 'growth', color: 'good' },
    { title: 'Profitable companies', value: formatMarket(profit.positivePct, 'pct', 0), note: `${profit.positive} of ${profit.count} reporting positive net income`, screen: 'profitable', color: 'accent' },
    { title: 'Positive operating cash flow', value: formatMarket(cash.positivePct, 'pct', 0), note: `${cash.positive} of ${cash.count} with cash flow / revenue`, screen: 'positiveCash', color: 'blue' },
    { title: 'Older or missing reports', value: String(older), note: `Report end >${basis === 'annual' ? 550 : 200} days old, or unavailable`, screen: 'older', color: 'warm' },
  ];
  return <>
    <div className={s.cards}>{cards.map((card, i) => <button key={card.title} className={s.stat} onClick={() => onScreen(card.screen)}>
      <span>{card.title}<ArrowUpRight size={15} /></span><strong className={s[card.color]}>{card.value}</strong><small>{card.note}</small>
      {i === 0 && <span className={s.breadthTrack}><i style={{ width: `${growth.positivePct || 0}%` }} /></span>}
    </button>)}</div>
    <div className={s.briefGrid}>
      <section className={s.panel}><div className={s.sectionHeading}><div><span className={s.eyebrow}>Research priorities</span><h2>Where to look next</h2></div><span className={s.badge}>{companies.length} companies</span></div>
        <p className={s.muted}>Descriptive screens from reported financials. Each count opens the underlying companies.</p>
        <div className={s.priorityList}>
          {[['contraction', growth.negative, 'Revenue contraction', 'Compare demand, pricing, and the prior-year base.'], ['losses', profit.negative, 'Reported net losses', 'Review recurring profitability and unusual items.'], ['negativeCash', cash.negative, 'Negative operating cash flow', 'Inspect working capital and sector-specific cash movements.']].map(([id, count, label, note]) => <button key={id} onClick={() => onScreen(String(id))}><strong>{count}</strong><span><b>{label}</b><small>{note}</small></span><ArrowUpRight size={17} /></button>)}
        </div>
      </section>
      <section className={s.panel}><div className={s.sectionHeading}><div><span className={s.eyebrow}>Coverage & timing</span><h2>Know the universe</h2></div></div>
        <dl className={s.coverageList}><div><dt>Curated companies loaded</dt><dd>{data.companies.length} / {data.requested}</dd></div><div><dt>Research cohorts</dt><dd>{data.cohorts.length}</dd></div><div><dt>Growth coverage in this scope</dt><dd>{growth.count} / {companies.length}</dd></div><div><dt>Snapshot calculated (UTC)</dt><dd>{data.generatedAt.slice(0, 16).replace('T', ' ')}</dd></div></dl>
        <p className={s.note}>Latest available {basis === 'ttm' ? 'quarter-end balances and trailing-twelve-month flows' : 'annual statements'}. Fiscal ends vary. Companies count once here and may belong to several cohorts. This is a filing universe, not a price index.</p>
        {data.failures.length > 0 && <details className={s.details}><summary>{data.failures.length} companies unavailable</summary><ul>{data.failures.map((f) => <li key={f.ticker}><b>{f.ticker}</b> — {f.reason}</li>)}</ul></details>}
      </section>
    </div>
  </>;
}

const HEAT_KEYS = ['revenueGrowth', 'netMargin', 'cashFlowMargin', 'capexIntensity', 'equityToAssets'];
export function SectorMap({ data, basis, statistic, selectedCohort, onStatistic, onCohort }: { data: MarketData; basis: Basis; statistic: string; selectedCohort: string; onStatistic: (stat: string) => void; onCohort: (id: string, metric?: string) => void }) {
  return <section className={s.panel}>
    <div className={s.sectionHeading}><div><span className={s.eyebrow}>Sector comparison</span><h2>Find the dispersion</h2></div><div className={s.segmented} aria-label="Sector statistic">{['median', 'mean'].map((stat) => <button key={stat} aria-pressed={statistic === stat} onClick={() => onStatistic(stat)}>{stat === 'median' ? 'Median' : 'Mean'}</button>)}</div></div>
    <p className={s.muted}>Equal company weights; each cell shows its own coverage. Select a cohort to screen its companies. Colors show numeric levels, not risk ratings.</p>
    <div className={s.tableScroll}><table className={s.heatmap}><caption className={s.srOnly}>Sector financial metrics with coverage counts</caption><thead><tr><th scope="col">Research cohort</th>{HEAT_KEYS.map((key) => <th key={key} scope="col">{MARKET_METRICS.find((m) => m.key === key)?.label}</th>)}<th scope="col">Loaded</th></tr></thead><tbody>
      {data.cohorts.map((cohort) => {
        const rows = data.companies.filter((c) => c.cohorts.includes(cohort.id));
        return <tr key={cohort.id} data-selected={cohort.id === selectedCohort}><th scope="row"><button onClick={() => onCohort(cohort.id)}><b>{cohort.label}</b><small>{cohort.title}</small></button></th>
          {HEAT_KEYS.map((key) => { const stat = metricStats(rows, basis, key); const value = statistic === 'mean' ? stat.mean : stat.median; return <td key={key}><button onClick={() => onCohort(cohort.id, key)} aria-label={`${cohort.label}, ${MARKET_METRICS.find((m) => m.key === key)?.label}: ${formatMarket(value)}, ${stat.count} of ${rows.length} companies`} className={value == null ? s.heatMissing : value < 0 ? s.heatNegative : s.heatPositive} style={value == null ? undefined : { backgroundColor: `color-mix(in srgb, var(${value < 0 ? '--m-bad' : '--m-good'}) ${Math.min(28, 6 + Math.abs(value) * .4)}%, var(--m-panel))` }}><b>{formatMarket(value)}</b><small>{stat.count}/{rows.length}</small></button></td>; })}
          <td>{rows.length}/{cohort.tickers.length}</td></tr>;
      })}
    </tbody></table></div>
    <p className={s.note}>Cohorts overlap and are not additive. Net margins, cash flows, and capital structures differ by industry; bank and insurer ratios are not directly comparable with industrial companies. Missing or incompatible metrics remain unavailable.</p>
  </section>;
}

export function CompanyTable({ rows, view, watchlist, page, onPage, onView, onInspect, onWatch, onPeer }: { rows: Company[]; view: MarketView; watchlist: string[]; page: number; onPage: (page: number) => void; onView: (patch: Partial<MarketView>) => void; onInspect: (ticker: string) => void; onWatch: (company: Company) => void; onPeer: (ticker: string) => void }) {
  const pageCount = Math.max(1, Math.ceil(rows.length / 20));
  const effectivePage = Math.min(page, pageCount - 1);
  const columns = [...new Set(['revenueGrowth', 'netMargin', 'cashFlowMargin', MARKET_METRICS.some((m) => m.key === view.sort) && !['revenueGrowth', 'netMargin', 'cashFlowMargin'].includes(view.sort) ? view.sort : 'equityToAssets'])];
  const sort = (key: string) => onView({ sort: key, direction: view.sort === key && view.direction === 'desc' ? 'asc' : 'desc' });
  const SortArrow = view.direction === 'desc' ? ArrowDown : ArrowUp;
  return <section className={s.panel}>
    <div className={s.sectionHeading}><div><span className={s.eyebrow}>Company screener</span><h2>{rows.length} research {rows.length === 1 ? 'candidate' : 'candidates'}</h2></div><span className={s.badge}>{view.basis === 'ttm' ? 'Latest TTM' : 'Latest annual'}</span></div>
    <div className={s.filters}><label className={s.search}><Search size={16} /><span className={s.srOnly}>Search Market companies</span><input value={view.query} onChange={(e) => onView({ query: e.target.value })} placeholder="Search ticker or company…" /></label>
      <label>Research screen<select value={view.screen} onChange={(e) => onView({ screen: e.target.value })}><option value="all">All companies</option><option value="growth">Growing revenue</option><option value="contraction">Revenue contraction</option><option value="profitable">Profitable companies</option><option value="positiveCash">Positive operating cash flow</option><option value="losses">Net losses</option><option value="negativeCash">Negative operating cash flow</option><option value="older">Older / missing reports</option><option value="watchlist">My watchlist</option></select></label>
      <label>Sort by<select value={view.sort} onChange={(e) => onView({ sort: e.target.value })}><option value="ticker">Ticker</option><option value="filed">Filing date</option>{MARKET_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label>
      <button className={s.button} onClick={() => onView({ direction: view.direction === 'desc' ? 'asc' : 'desc' })} aria-label={`Sort ${view.direction === 'desc' ? 'ascending' : 'descending'}`}><SortArrow size={16} /></button>
    </div>
    <div className={s.tableScroll}><table className={s.companyTable}><caption className={s.srOnly}>Screened companies. Select up to five peers for comparison or open company evidence.</caption><thead><tr><th scope="col">Peer</th><th scope="col" aria-sort={view.sort === 'ticker' ? (view.direction === 'asc' ? 'ascending' : 'descending') : 'none'}><button onClick={() => sort('ticker')}>Company</button></th>{columns.map((key) => <th scope="col" key={key} aria-sort={view.sort === key ? (view.direction === 'asc' ? 'ascending' : 'descending') : 'none'}><button onClick={() => sort(key)}>{MARKET_METRICS.find((m) => m.key === key)?.label}{view.sort === key && <SortArrow size={12} />}</button></th>)}<th scope="col">Report end</th><th scope="col">Save</th></tr></thead><tbody>
      {rows.slice(effectivePage * 20, effectivePage * 20 + 20).map((c) => <tr key={c.ticker}><td><input type="checkbox" aria-label={`Compare ${c.ticker}`} checked={view.selected.includes(c.ticker)} disabled={view.selected.length >= 5 && !view.selected.includes(c.ticker)} onChange={() => onPeer(c.ticker)} /></td><th scope="row"><button className={s.companyLink} onClick={() => onInspect(c.ticker)}><b>{c.ticker}<ArrowUpRight size={12} /></b><small>{c.name}</small></button></th>{columns.map((key) => <td key={key} className={isNumber(c.metrics[view.basis]?.[key]) && Number(c.metrics[view.basis][key]) < 0 ? s.bad : ''}>{formatMarket(c.metrics[view.basis]?.[key], MARKET_METRICS.find((m) => m.key === key)?.unit)}</td>)}<td><span>{c.reports[view.basis]?.end || 'Unavailable'}</span><small>{c.reports[view.basis]?.form || ''}</small></td><td><button className={s.iconButton} aria-label={`${watchlist.includes(c.ticker) ? 'Remove' : 'Save'} ${c.ticker} ${watchlist.includes(c.ticker) ? 'from' : 'to'} watchlist`} aria-pressed={watchlist.includes(c.ticker)} onClick={() => onWatch(c)}><Star size={17} fill={watchlist.includes(c.ticker) ? 'currentColor' : 'none'} /></button></td></tr>)}
    </tbody></table></div>
    {!rows.length && <div className={s.empty}><Search size={25} /><h3>No companies match this view</h3><p>Try another search or reset the research filters.</p><button className={s.button} onClick={() => onView({ query: '', screen: 'all', cohort: 'all' })}>Reset filters</button></div>}
    <div className={s.pagination}><span>{rows.length ? `${effectivePage * 20 + 1}–${Math.min(rows.length, effectivePage * 20 + 20)} of ${rows.length}` : '0 results'} · Missing values sort last</span><div><button className={s.button} disabled={effectivePage === 0} onClick={() => onPage(effectivePage - 1)} aria-label="Previous company page"><ChevronLeft size={15} /></button><span>{effectivePage + 1} / {pageCount}</span><button className={s.button} disabled={effectivePage + 1 >= pageCount} onClick={() => onPage(effectivePage + 1)} aria-label="Next company page"><ChevronRight size={15} /></button></div></div>
  </section>;
}

export function PeerComparison({ companies, basis, onInspect }: { companies: Company[]; basis: Basis; onInspect: (ticker: string) => void }) {
  return <section className={s.panel}><div className={s.sectionHeading}><div><span className={s.eyebrow}>Selected peers</span><h2>Compare the fundamentals</h2></div></div><p className={s.muted}>Same calculation basis, individually reported fiscal ends. Compare peers with similar business models.</p><div className={s.tableScroll}><table className={s.comparison}><thead><tr><th scope="col">Metric</th>{companies.map((c) => <th key={c.ticker} scope="col"><button className={s.companyLink} onClick={() => onInspect(c.ticker)}>{c.ticker}<ArrowUpRight size={13} /></button><small>{c.reports[basis]?.end || 'Unavailable'}</small></th>)}</tr></thead><tbody>{MARKET_METRICS.map((m) => <tr key={m.key}><th scope="row">{m.label}</th>{companies.map((c) => <td key={c.ticker}>{formatMarket(c.metrics[basis]?.[m.key], m.unit)}</td>)}</tr>)}</tbody></table></div></section>;
}

export function SavedResearch({ saved, data, basis, onOpenView, onRemoveView, onInspect, onBaseline }: { saved: Saved; data: MarketData; basis: Basis; onOpenView: (query: string) => void; onRemoveView: (index: number) => void; onInspect: (ticker: string) => void; onBaseline: (company: Company) => void }) {
  const companies = data.companies.filter((c) => saved.watchlist.includes(c.ticker));
  return <div className={s.briefGrid}><section className={s.panel}><div className={s.sectionHeading}><div><span className={s.eyebrow}>Your research</span><h2>Saved views</h2></div></div><p className={s.muted}>Filters and peer selections saved in this browser. Use “Share view” to carry a view to another device.</p>{saved.views.length ? saved.views.map((v, i) => <div className={s.savedView} key={`${v.name}-${i}`}><button onClick={() => onOpenView(v.query)}><b>{v.name}</b><small>Restore filters and peers <ArrowUpRight size={12} /></small></button><button className={s.button} onClick={() => onRemoveView(i)} aria-label={`Delete saved view ${v.name}`}>Delete</button></div>) : <div className={s.empty}><h3>Keep a useful screen</h3><p>Set filters on Companies, then select “Save view.”</p></div>}</section>
    <section className={s.panel}><div className={s.sectionHeading}><div><span className={s.eyebrow}>Review tracking</span><h2>Since you saved</h2></div><span className={s.badge}>{saved.watchlist.length} watched</span></div><p className={s.muted}>Compare current figures with the snapshot saved when you starred a company. A new period and a same-period value change are identified separately.</p>{companies.length ? companies.map((c) => { const before = saved.baselines[c.ticker]; const changes = baselineChanges(before, c, basis); return <div key={c.ticker} className={s.reviewRow}><div><button className={s.companyLink} onClick={() => onInspect(c.ticker)}>{c.ticker}<ArrowUpRight size={13} /></button><small>Saved {before?.observedAt?.slice(0, 10) || 'without a baseline'} · {before?.reports[basis]?.end || '—'} → {c.reports[basis]?.end || '—'}</small></div>{changes.length ? <ul>{changes.slice(0, 3).map((change) => <li key={change.key}>{change.label}: {formatMarket(change.before, change.unit)} → {formatMarket(change.after, change.unit)}<small>{change.reason}</small></li>)}</ul> : <p className={s.note}>{before?.version !== c.version ? 'Calculation definitions changed or a baseline is missing. Update the baseline to track comparable changes.' : before ? 'No changes in comparable available metrics.' : 'Save a baseline to start tracking changes.'}</p>}<button className={s.button} onClick={() => onBaseline(c)}>Update {c.ticker} baseline</button></div>; }) : <div className={s.empty}><Star size={25} /><h3>Build your watchlist</h3><p>Star companies in the screener to revisit them here.</p></div>}
    {saved.watchlist.filter((t) => !data.companies.some((c) => c.ticker === t)).map((t) => <p className={s.note} key={t}>{t}: currently unavailable in this Market snapshot; its saved baseline is retained.</p>)}</section></div>;
}

export function ObservationHistory({ data }: { data: MarketData }) {
  return <details className={`${s.panel} ${s.details}`}><summary>Observed market history · {data.observations.length} calculation dates</summary><p className={s.note}>Actual daily calculation snapshots, using TTM data across the full curated universe. Cohort membership and metric coverage can change. These are observations collected by this version, not reconstructed market history.{!data.historyPersistence && ' Shared history could not be saved; this response still contains the current observation.'}</p><div className={s.tableScroll}><table className={s.comparison}><thead><tr><th>Date (UTC)</th><th>Companies</th><th>Median revenue growth</th><th>Growth coverage</th><th>Membership vs prior date</th></tr></thead><tbody>{data.observations.slice().reverse().map((row, index, rows) => <tr key={row.observedAt}><td>{row.observedAt.slice(0, 10)}</td><td>{row.companies}</td><td>{formatMarket(row.revenueGrowth.median)}</td><td>{row.revenueGrowth.count} / {row.companies}</td><td>{!rows[index + 1] ? 'First observation' : JSON.stringify(row.tickers) === JSON.stringify(rows[index + 1].tickers) ? 'Unchanged membership' : 'Membership changed'}</td></tr>)}</tbody></table></div>{data.observations.length < 2 && <p className={s.note}>History begins with the first calculation. Another observation date is needed before there is a trend to interpret.</p>}</details>;
}
