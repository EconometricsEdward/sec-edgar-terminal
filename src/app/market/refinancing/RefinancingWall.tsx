'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowRight, ArrowUpRight, BarChart3, Building2, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Search, SlidersHorizontal, X } from 'lucide-react';
import s from './refinancing.module.css';

export type RefinancingMetric = { value: number | null; tag?: string | null; startDate?: string | null; endDate?: string | null; reason?: string | null; formula?: string; source?: { documentUrl?: string } | null };
export type RefinancingMaturity = { key: string; label: string; value: number | null; startDate?: string | null; endDate?: string | null; calendarYear?: number | null; dateBasis?: string; tag?: string | null; reason?: string | null };
export type RefinancingProfile = {
  status: string; reason?: string | null; asOf: string | null; filedAt?: string | null; accession?: string | null; form?: string | null; currency: string; sourceUrl?: string | null; basis?: string | null;
  buckets: RefinancingMaturity[]; totalScheduled?: number | null; reportedSubtotal?: number | null;
  coverage: { reportedBuckets: number; totalBuckets: number; complete: boolean; reason?: string | null };
  metrics: { cash?: RefinancingMetric; operatingCashFlow?: RefinancingMetric; operatingIncome?: RefinancingMetric; interestExpense?: RefinancingMetric; interestCoverage?: RefinancingMetric; cashToNext12m?: RefinancingMetric };
  warnings?: string[];
};
export type RefinancingCompany = { cik: string; ticker: string; name: string; sector: string; sectorId?: string; checkedAt?: string | null; factsRetrievedAt?: string | null; profile: RefinancingProfile | null };
export type RefinancingWallData = {
  generatedAt: string | null; sourceSnapshotAt?: string | null; companies: RefinancingCompany[];
  coverage?: { totalCandidates?: number; loadedCompanies?: number; checkedCompanies?: number; coveredCompanies?: number; completeCompanies?: number; missingScheduleCompanies?: number; pendingCompanies?: number };
  status?: string; message?: string | null; cache?: { status?: string; checkedAt?: string };
};
type SupportedCompany = RefinancingCompany & { profile: RefinancingProfile };
type Props = { data: RefinancingWallData; cftcEnabled?: boolean };
type Bucket = { key: string; label: string; total: number; values: { sector: string; amount: number }[]; count: number };
type CoverageStatus = 'complete' | 'partial' | 'pending' | 'unavailable';
const STATUS_LABELS: Record<CoverageStatus, string> = { complete: 'Complete schedule', partial: 'Partial schedule', pending: 'Awaiting review', unavailable: 'Schedule unavailable' };
const COVERAGE_STATES: CoverageStatus[] = ['complete', 'partial', 'pending', 'unavailable'];
const PALETTE = ['#79c9be', '#eec36a', '#8dabed', '#cb9bd8', '#ed9e85', '#76b6d7', '#b7c77e', '#d497b4', '#b4bcca', '#bba17b', '#89b58b'];
const BUCKETS = ['next12m', 'year2', 'year3', 'year4', 'year5'];
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const amount = (value: number | null | undefined, digits = 1) => !isAmount(value) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: digits }).format(value);
const exactAmount = (value: number | null) => !isAmount(value) ? 'Not reported' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const date = (value?: string | null) => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unavailable';
const safeSource = (url?: string | null) => { try { const parsed = new URL(url || ''); return parsed.protocol === 'https:' && (parsed.hostname === 'sec.gov' || parsed.hostname.endsWith('.sec.gov')) ? parsed.href : null; } catch { return null; } };
const supported = (c: RefinancingCompany): c is SupportedCompany => Boolean(c.profile?.status === 'ready' && c.profile.currency === 'USD' && c.profile.buckets?.length && c.profile.buckets.every(m => m.value == null || isAmount(m.value) && m.value >= 0) && safeSource(c.profile.sourceUrl));
const coverageStatus = (c: RefinancingCompany): CoverageStatus => supported(c) ? c.profile.coverage.complete ? 'complete' : 'partial' : c.profile == null || c.profile.status === 'pending' ? 'pending' : 'unavailable';
const scheduleReason = (c: RefinancingCompany) => {
  if (coverageStatus(c) === 'pending') return 'This company is in the Market universe, but evaluation of its maturity disclosures has not yet completed in the prepared snapshot.';
  const reason = c.profile?.reason || c.profile?.coverage?.reason;
  if (reason === 'schedule_too_old') return 'The available maturity schedule is outside the supported reporting window. Older amounts are excluded from the wall.';
  if (reason === 'invalid_or_mismatched_cik') return 'The available disclosure could not be matched confidently to this company.';
  if (reason === 'conflicting_facts' || reason === 'ambiguous_schedule') return 'The available maturity disclosures could not be reconciled into a supported schedule.';
  return 'No supported, current USD principal maturity schedule was found in the company’s standard SEC data. Its filing may use custom tags, a different reporting format, or omit this schedule.';
};
const disclosedTotal = (company: SupportedCompany) => company.profile.buckets.reduce((sum, m) => sum + (isAmount(m.value) ? m.value : 0), 0);
const bucketValue = (company: SupportedCompany, key: string) => company.profile.buckets.find(b => b.key === key)?.value ?? null;
const nearTerm = (company: SupportedCompany) => { const first = bucketValue(company, 'next12m'), second = bucketValue(company, 'year2'); return isAmount(first) && isAmount(second) ? first + second : null; };
const metricPeriod = (metric?: RefinancingMetric) => metric?.startDate && metric.endDate ? `${date(metric.startDate)} – ${date(metric.endDate)}` : metric?.endDate ? `As of ${date(metric.endDate)}` : 'Period unavailable';
const humanReason = (reason?: string | null) => reason === 'not_comparable_for_financial_institutions' ? 'Not comparable for financial institutions' : reason === 'conflicting_facts' ? 'Reported inputs could not be reconciled' : 'No compatible value in this filing';
const labelFor = (key: string, rolling: boolean) => key === 'next12m' ? rolling ? 'Next 12 months' : 'Next fiscal year' : key === 'after5' ? 'Thereafter' : `${rolling ? 'Rolling year' : 'Fiscal year'} +${key.slice(-1)}`;

function buildBuckets(companies: SupportedCompany[], sectors: string[], rolling: boolean): Bucket[] {
  return [...BUCKETS, 'after5'].map(key => {
    const values = sectors.map(sector => ({ sector, amount: companies.filter(c => c.sector === sector).reduce((sum, c) => sum + (bucketValue(c, key) ?? 0), 0) }));
    return { key, label: labelFor(key, rolling), total: values.reduce((sum, v) => sum + v.amount, 0), values: values.filter(v => v.amount > 0), count: companies.filter(c => isAmount(bucketValue(c, key))).length };
  });
}

function exportCsv(companies: SupportedCompany[]) {
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    // Quotes delimit CSV cells but do not prevent spreadsheet formula execution.
    // Prefix untrusted text only; actual numbers retain their numeric meaning.
    const safe = typeof value === 'string' && /^\s*[=+\-@]|^[\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const rows = [['Ticker', 'Company', 'CIK', 'Sector', 'Report date', 'Filed date', 'Currency', 'Schedule basis', 'Maturity bucket', 'Amount', 'Bucket date basis', 'Start date', 'End date', 'Complete schedule', 'SEC source', 'XBRL concept'], ...companies.flatMap(c => c.profile.buckets.map(m => [c.ticker, c.name, c.cik, c.sector, c.profile.asOf, c.profile.filedAt, c.profile.currency, c.profile.basis, m.label, m.value, m.dateBasis, m.startDate, m.endDate, c.profile.coverage.complete, c.profile.sourceUrl, m.tag]))];
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sec-edgar-refinancing-wall.csv';
  link.hidden = true;
  // Keep the link connected and its blob alive while the browser hands the file
  // to its download manager. An early revocation can race that handoff.
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 60000);
  }
}

export default function RefinancingWall({ data, cftcEnabled = true }: Props) {
  const [sector, setSector] = useState('all');
  const [query, setQuery] = useState('');
  const [basis, setBasis] = useState('fiscal');
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [hoveredYear, setHoveredYear] = useState<string | null>(null);
  const [sort, setSort] = useState('near');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [directoryView, setDirectoryView] = useState<'scheduled' | 'all'>('scheduled');
  const [statusFilter, setStatusFilter] = useState<CoverageStatus | 'all'>('all');
  const [selectedCik, setSelectedCik] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const universe = useMemo(() => data.companies || [], [data.companies]);
  const companies = useMemo(() => universe.filter(supported), [universe]);
  const sectors = useMemo(() => [...new Set(universe.map(c => c.sector))].sort(), [universe]);
  const companyIndex = useMemo(() => new Map(universe.map(c => [c.cik, { company: c, status: coverageStatus(c), ready: supported(c), subtotal: supported(c) ? disclosedTotal(c) : null, firstTwo: supported(c) ? nearTerm(c) : null, search: `${c.ticker} ${c.name} ${c.cik}`.toLowerCase() }])), [universe]);
  const coverageCounts = useMemo(() => {
    const counts: Record<CoverageStatus, number> = { complete: 0, partial: 0, pending: 0, unavailable: 0 };
    for (const entry of companyIndex.values()) counts[entry.status]++;
    return counts;
  }, [companyIndex]);
  const filteredUniverse = useMemo(() => {
    const term = query.trim().toLowerCase();
    return universe.filter(c => (sector === 'all' || c.sector === sector) && (!term || companyIndex.get(c.cik)?.search.includes(term)));
  }, [universe, sector, query, companyIndex]);
  const colors = useMemo(() => new Map(sectors.map((name, i) => [name, PALETTE[i % PALETTE.length]])), [sectors]);
  const hasRolling = companies.some(c => c.profile.basis === 'rolling');
  const hasFiscal = companies.some(c => c.profile.basis === 'fiscal');
  const activeBasis = basis === 'fiscal' && !hasFiscal && hasRolling ? 'rolling' : basis;
  const matching = useMemo(() => filteredUniverse.filter((c): c is SupportedCompany => supported(c) && c.profile.basis === activeBasis), [filteredUniverse, activeBasis]);
  const allBuckets = useMemo(() => buildBuckets(matching, sectors, activeBasis === 'rolling'), [matching, sectors, activeBasis]);
  const buckets = allBuckets.filter(b => b.key !== 'after5');
  const thereafter = allBuckets.find(b => b.key === 'after5')!;
  const total = matching.reduce((sum, c) => sum + disclosedTotal(c), 0);
  const incomplete = matching.filter(c => !c.profile.coverage.complete).length;
  const peak = buckets.filter(b => b.count).reduce<Bucket | null>((best, b) => !best || b.total > best.total ? b : best, null);
  const activeBucket = allBuckets.find(b => b.key === (hoveredYear || selectedYear)) || null;
  const dates = matching.map(c => c.profile.asOf).filter((d): d is string => Boolean(d)).sort();
  const dateRange = dates.length ? dates[0] === dates[dates.length - 1] ? date(dates[0]) : `${date(dates[0])} – ${date(dates[dates.length - 1])}` : 'No reported periods';
  const selected = selectedCik ? companyIndex.get(selectedCik)?.company || null : null;
  const displayedCompanies = useMemo(() => {
    const list = (directoryView === 'all' ? filteredUniverse : matching).filter(c =>
      (statusFilter === 'all' || companyIndex.get(c.cik)?.status === statusFilter)
      && (!selectedYear || companyIndex.get(c.cik)?.ready && isAmount(c.profile?.buckets.find(b => b.key === selectedYear)?.value)));
    const value = (c: RefinancingCompany) => {
      const entry = companyIndex.get(c.cik);
      return !entry?.ready ? -Infinity : sort === 'total' ? entry.subtotal ?? -Infinity : selectedYear ? c.profile?.buckets.find(b => b.key === selectedYear)?.value ?? -Infinity : entry.firstTwo ?? -Infinity;
    };
    return list.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : value(b) - value(a) || a.name.localeCompare(b.name));
  }, [matching, filteredUniverse, directoryView, statusFilter, companyIndex, selectedYear, sort]);
  const pageCount = Math.max(1, Math.ceil(displayedCompanies.length / pageSize));
  const effectivePage = Math.min(page, pageCount - 1);
  const maxBar = Math.max(1, ...buckets.map(b => b.total));
  const updateSector = (value: string) => { setSector(value); setPage(0); setSelectedYear(null); setHoveredYear(null); };
  const selectBucket = (key: string) => { setSelectedYear(selectedYear === key ? null : key); setDirectoryView('scheduled'); setStatusFilter('all'); setPage(0); };
  const showCoverage = (status: CoverageStatus) => {
    setDirectoryView('all'); setStatusFilter(status); setPage(0); setSelectedYear(null); setQuery(''); setSector('all');
    document.getElementById('issuer-directory')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };
  const selectIssuer = (cik: string) => { setSelectedCik(cik); setCopyFailed(false); setTimeout(() => document.getElementById('issuer-maturity-detail')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }), 0); };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialCompany = params.get('company');
    const initialSector = params.get('sector');
    if (initialCompany && companyIndex.has(initialCompany)) { setSelectedCik(initialCompany); setBasis(companyIndex.get(initialCompany)!.company.profile?.basis || 'fiscal'); if (!supported(companyIndex.get(initialCompany)!.company)) setDirectoryView('all'); }
    if (initialSector && sectors.includes(initialSector)) setSector(initialSector);
  }, [companyIndex, sectors]);

  async function copyView() {
    const url = new URL(window.location.href);
    if (selectedCik) url.searchParams.set('company', selectedCik); else url.searchParams.delete('company');
    if (sector !== 'all') url.searchParams.set('sector', sector); else url.searchParams.delete('sector');
    try { await navigator.clipboard.writeText(url.href); setCopyFailed(false); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setCopyFailed(true); }
  }

  function downloadData() {
    try {
      exportCsv(matching);
      setExportMessage(`CSV download requested for ${matching.length.toLocaleString()} ${matching.length === 1 ? 'issuer' : 'issuers'}. Check your browser’s downloads.`);
    } catch {
      setExportMessage('The CSV could not be prepared. Please try again.');
    }
  }

  return <div className={s.page}>
    <nav className={s.breadcrumb} aria-label="Breadcrumb"><Link prefetch={false} href="/market">Market</Link><ChevronRight size={13} /><span>Refinancing wall</span></nav>
    <header className={s.hero}>
      <div><span className={s.eyebrow}><CalendarDays size={14} />THE MATURITY PICTURE</span><h1>Debt comes due.<br /><span>See when.</span></h1><p>Explore corporate debt maturities, then put each issuer’s schedule beside its financial resources.</p></div>
      <div className={s.heroAside}><span>SEC REFINANCING WALL</span><div className={s.heroMotif} aria-hidden="true">{[25, 44, 64, 96, 72, 46, 33].map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}</div><small>Filing evidence. Company context.</small></div>
    </header>
    <nav className={s.researchNav} aria-label="Market research"><Link prefetch={false} href="/market">Market briefing</Link>{cftcEnabled && <Link prefetch={false} href="/market?tab=positioning">CFTC positioning</Link>}<Link prefetch={false} href="/market?tab=sectors">Sector performance</Link><Link prefetch={false} href="/market/refinancing" aria-current="page">Refinancing wall</Link><Link prefetch={false} href="/market/funding">Funding &amp; clearing</Link><Link prefetch={false} href="/market/derivatives">Derivatives</Link></nav>
    <div className={s.statusLine}><span><i className={companies.length ? s.readyDot : s.unavailableDot} />{data.cache?.status === 'stale' ? 'Preserved SEC snapshot' : companies.length ? 'Prepared SEC disclosures' : 'Disclosure coverage unavailable'}</span><span>Updated {date(data.generatedAt)}</span><details className={s.inlineDetails}><summary>Coverage &amp; scope <ChevronDown size={12} /></summary><div><strong>{companies.length.toLocaleString()} issuers with supported schedules</strong><p>{data.coverage?.totalCandidates ? `From ${data.coverage.totalCandidates.toLocaleString()} companies in the prepared universe. ` : ''}{data.coverage?.pendingCompanies ? `${data.coverage.pendingCompanies.toLocaleString()} companies have not yet been checked. ` : ''}Coverage is limited to validated, standard-tagged maturity disclosures in USD. It is not the full corporate debt market.</p><p>Fiscal and rolling schedules are viewed separately. Years are relative to each source report, not today. “Thereafter” is never allocated to individual years. Missing buckets remain unreported.</p><p>Bank funding is available separately in <Link prefetch={false} href="/analysis/banks">BankScope ↗</Link>.</p></div></details></div>
    {data.cache?.status === 'stale' && <p className={s.staleNotice}>Showing the last prepared snapshot while an update is unavailable. Check each issuer’s report date.</p>}
    {universe.length > 0 && <section className={s.coverageRibbon} aria-label="Market universe disclosure coverage">
      <div className={s.coverageHeading}><p><strong>{companies.length.toLocaleString()}</strong> supported schedules <span>from {universe.length.toLocaleString()} loaded Market companies</span></p><Link prefetch={false} href="/market?tab=sectors">Same Market universe <ArrowUpRight size={12} /></Link></div>
      <div className={s.coverageTrack} aria-hidden="true">{COVERAGE_STATES.filter(status => coverageCounts[status] > 0).map(status => <i key={status} data-status={status} style={{ flex: coverageCounts[status] }} />)}</div>
      <div className={s.coverageLegend}>{COVERAGE_STATES.map(status => <button key={status} data-status={status} disabled={!coverageCounts[status]} onClick={() => showCoverage(status)}><i /><b>{coverageCounts[status].toLocaleString()}</b>{status === 'complete' ? 'complete' : status === 'partial' ? 'partial' : status === 'pending' ? 'awaiting review' : 'unavailable'}</button>)}<span>{(data.coverage?.checkedCompanies ?? universe.length - coverageCounts.pending).toLocaleString()} checked · {(data.coverage?.totalCandidates ?? universe.length).toLocaleString()} in Market universe</span></div>
    </section>}
    {!universe.length ? <section className={s.empty}><BarChart3 size={36} strokeWidth={1.2} /><h2>The maturity picture is being prepared.</h2><p>{data.message || 'No validated corporate maturity schedules are available in this snapshot. Reported values will appear when disclosure coverage is ready.'}</p><div><Link prefetch={false} href="/market">Explore market briefing <ArrowRight size={14} /></Link><Link prefetch={false} href="/analysis/banks">Explore BankScope <ArrowUpRight size={14} /></Link></div></section> : <>
      <section className={s.filters} aria-label="Refinancing wall filters">
        <label className={s.search}><Search size={17} /><span className={s.srOnly}>Search all Market companies, tickers, or CIKs</span><input type="search" placeholder="Search all Market companies or tickers" value={query} onChange={e => { setQuery(e.target.value); setPage(0); setSelectedYear(null); setStatusFilter('all'); setDirectoryView(e.target.value.trim() ? 'all' : 'scheduled'); }} /></label>
        <label className={s.sectorSelect}><SlidersHorizontal size={14} /><span className={s.srOnly}>Sector</span><select value={sector} onChange={e => updateSector(e.target.value)}><option value="all">All sectors</option>{sectors.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <button className={s.download} disabled={!matching.length} onClick={downloadData}><Download size={14} /><span>Export data</span></button>
      </section>
      {exportMessage && <p className={s.exportStatus} role="status">{exportMessage}</p>}
      {hasFiscal && hasRolling && <div className={s.basisToggle} role="group" aria-label="Schedule basis"><button aria-pressed={activeBasis === 'fiscal'} onClick={() => { setBasis('fiscal'); setSelectedYear(null); setPage(0); }}>Fiscal schedules</button><button aria-pressed={activeBasis === 'rolling'} onClick={() => { setBasis('rolling'); setSelectedYear(null); setPage(0); }}>Rolling schedules</button></div>}
      <section className={s.wall} aria-labelledby="wall-title">
        <div className={s.sectionHeader}><div><span className={s.eyebrow}>{sector === 'all' ? 'COVERED ISSUERS · ALL SECTORS' : sector.toUpperCase()}</span><h2 id="wall-title">The refinancing horizon</h2></div><span className={s.unitLabel}>USD · {activeBasis === 'rolling' ? 'rolling' : 'fiscal'} years<br />Relative to each report date</span></div>
        <div className={s.summaryStrip} aria-live="polite"><div><span>Disclosed maturities</span><strong>{matching.length ? amount(total) : '—'}</strong><small>Includes thereafter{incomplete ? ` · ${incomplete} partial schedules` : ''}</small></div><div><span>Supported issuers in view</span><strong>{matching.length.toLocaleString()}<small> / {companies.length.toLocaleString()} covered</small></strong><small>Reporting dates: {dateRange}</small></div><div><span>{activeBucket ? activeBucket.label : 'Largest annual bucket'}</span><strong className={s.gold}>{activeBucket ? activeBucket.count ? amount(activeBucket.total) : '—' : peak ? amount(peak.total) : '—'}</strong><small>{activeBucket ? `${activeBucket.count} / ${matching.length} issuers report this bucket` : peak?.label || 'No reported annual values'}</small></div></div>
        {matching.length ? <>
          <div className={s.chartWrap}>
            <div className={s.axis} aria-hidden="true">{[1, .75, .5, .25, 0].map(ratio => <span key={ratio} style={{ top: `${(1 - ratio) * 100}%` }}>{amount(maxBar * ratio, 0)}</span>)}</div>
            <div className={s.chart} role="group" aria-label="Reported debt maturity totals by fiscal or rolling year relative to source reports. Select a bar to filter companies.">
              <div className={s.gridLines} aria-hidden="true">{[0, 25, 50, 75, 100].map(top => <i key={top} style={{ top: `${top}%` }} />)}</div>
              <div className={s.columns} style={{ gridTemplateColumns: 'repeat(5, minmax(44px, 1fr))' }}>
                {buckets.map(bucket => <button key={bucket.key} className={s.column} data-selected={selectedYear === bucket.key} aria-pressed={selectedYear === bucket.key} aria-label={`${bucket.label}: ${bucket.count ? exactAmount(bucket.total) : 'not reported'}, ${bucket.count} of ${matching.length} issuers report this bucket. Relative to each source report. Select to filter companies.`} onMouseEnter={() => setHoveredYear(bucket.key)} onMouseLeave={() => setHoveredYear(null)} onFocus={() => setHoveredYear(bucket.key)} onBlur={() => setHoveredYear(null)} onClick={() => selectBucket(bucket.key)}>
                  <span className={s.columnValue} style={{ bottom: `${bucket.total / maxBar * 100}%` }}>{bucket.count ? amount(bucket.total) : 'Not reported'}</span><span className={s.stack} style={{ height: `${bucket.total / maxBar * 100}%` }}>{bucket.values.map(value => <span key={value.sector} style={{ background: colors.get(value.sector), flex: value.amount }} title={`${value.sector}: ${exactAmount(value.amount)}`} />)}</span><span className={s.columnLabel}>{bucket.label}<small>{bucket.count} / {matching.length} report</small></span>
                </button>)}
              </div>
            </div>
          </div>
          <div className={s.thereafter}><div><span>Beyond the five annual buckets</span><strong>{thereafter.count ? amount(thereafter.total) : '—'}</strong></div><span>Reported thereafter · {thereafter.count} / {matching.length} issuers</span><button aria-pressed={selectedYear === 'after5'} onClick={() => selectBucket('after5')}>Explore <ArrowRight size={13} /></button></div>
          <div className={s.legend} aria-label="Sector chart legend">{sectors.filter(name => matching.some(c => c.sector === name)).map(name => <button key={name} onClick={() => updateSector(sector === name ? 'all' : name)} aria-pressed={sector === name}><i style={{ background: colors.get(name) }} />{name}</button>)}</div>
          <div className={s.chartFooter}><span>{selectedYear ? <button onClick={() => { setSelectedYear(null); setPage(0); }}>Showing {labelFor(selectedYear, activeBasis === 'rolling')} <X size={12} /></button> : 'Select a bucket to explore its issuers'}</span><details className={s.explanation}><summary>How to read this chart</summary><p>Each column adds supported maturities for the companies in view. Colors identify sectors. The horizontal axis is relative to each source report: a “next fiscal year” from a 2025 report is different from one in a 2026 report. This is not a calendar-year market total or a schedule beginning today.</p><p>The counts below each bar show coverage for that bucket. Partial schedules contribute only their reported values; a missing bucket is excluded, not zero. “Thereafter” combines periods beyond five annual buckets and is shown separately. Scheduled principal may differ from debt’s balance-sheet carrying value.</p></details></div>
        </> : <div className={s.noResults}><Search size={24} /><h3>No supported {activeBasis} schedules in this view.</h3><p>{filteredUniverse.length ? `${filteredUniverse.length.toLocaleString()} matching Market ${filteredUniverse.length === 1 ? 'company is' : 'companies are'} available in the full directory below. Check disclosure status or try the other schedule basis.` : 'Try a different company, ticker, or sector.'}</p>{filteredUniverse.length > 0 && <button onClick={() => { setDirectoryView('all'); setStatusFilter('all'); setSelectedYear(null); setPage(0); document.getElementById('issuer-directory')?.scrollIntoView({ block: 'start' }); }}>View matching Market companies <ArrowRight size={13} /></button>}<button onClick={() => { setQuery(''); updateSector('all'); }}>Clear filters</button></div>}
      </section>
      <section id="issuer-directory" className={s.directory} aria-labelledby="issuers-title">
        <div className={s.sectionHeader}><div><span className={s.eyebrow}>FROM THE MARKET TO THE COMPANY</span><h2 id="issuers-title">Explore Market companies{selectedYear ? <span> · {labelFor(selectedYear, activeBasis === 'rolling')}</span> : ''}</h2></div><label className={s.sortLabel}><ArrowDown size={13} /><span className={s.srOnly}>Sort companies</span><select value={sort} onChange={e => { setSort(e.target.value); setPage(0); }}><option value="near">{selectedYear ? 'Selected bucket: largest first' : 'First 2 years: largest first'}</option><option value="total">Disclosed maturities: largest first</option><option value="name">Company name</option></select></label></div>
        <div className={s.directoryToolbar}><div className={s.directoryViews} role="group" aria-label="Company directory scope"><button aria-pressed={directoryView === 'scheduled'} onClick={() => { setDirectoryView('scheduled'); setStatusFilter('all'); setPage(0); }}>Maturity schedules <span>{matching.length.toLocaleString()}</span></button><button aria-pressed={directoryView === 'all'} onClick={() => { setDirectoryView('all'); setStatusFilter('all'); setSelectedYear(null); setPage(0); }}>All Market companies <span>{filteredUniverse.length.toLocaleString()}</span></button></div><label className={s.directoryStatus}><span className={s.srOnly}>Filter company disclosure status</span><select value={statusFilter} onChange={e => { setStatusFilter(e.target.value as CoverageStatus | 'all'); setPage(0); }}><option value="all">All disclosure statuses</option>{COVERAGE_STATES.filter(status => directoryView === 'all' || status === 'complete' || status === 'partial').map(status => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label></div>
        <p className={s.directoryScope}>{directoryView === 'all' ? 'Search the loaded Market universe. Only supported schedules contribute to the charts above.' : `Supported ${activeBasis} schedules in this view. Partial schedules retain every reported bucket; missing values stay unavailable.`}</p>
        <div className={s.issuerList}><div className={s.listHeading} aria-hidden="true"><span>Company / disclosure status</span><span>Maturity profile</span><span>{selectedYear ? 'Selected bucket' : 'First 2 years'}</span><span>Disclosed subtotal</span><span /></div>{displayedCompanies.slice(effectivePage * pageSize, (effectivePage + 1) * pageSize).map(company => <CompanyRow key={company.cik} company={company} color={colors.get(company.sector) || PALETTE[0]} selectedYear={selectedYear} selected={selectedCik === company.cik} onSelect={() => selectIssuer(company.cik)} />)}</div>
        {!displayedCompanies.length && <div className={s.directoryEmpty}><p>No companies match these disclosure filters.</p><button onClick={() => { setDirectoryView('all'); setStatusFilter('all'); setSelectedYear(null); setPage(0); }}>Show all matching Market companies <ArrowRight size={13} /></button></div>}
        <div className={s.pagination}><span>{displayedCompanies.length ? `${effectivePage * pageSize + 1}–${Math.min((effectivePage + 1) * pageSize, displayedCompanies.length)} of ${displayedCompanies.length.toLocaleString()} companies` : 'No matching companies'} · Select an issuer to inspect its disclosure</span><div><label className={s.pageSize}><span>Show</span><select aria-label="Companies per page" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }}><option value={25}>25</option><option value={50}>50</option></select></label><button aria-label="Previous page of issuers" disabled={effectivePage === 0} onClick={() => setPage(effectivePage - 1)}><ChevronLeft size={17} /></button><span>{effectivePage + 1} / {pageCount}</span><button aria-label="Next page of issuers" disabled={effectivePage >= pageCount - 1} onClick={() => setPage(effectivePage + 1)}><ChevronRight size={17} /></button></div></div>
      </section>
      {selected && (supported(selected) ? <IssuerDetail company={selected} color={colors.get(selected.sector) || PALETTE[0]} onClose={() => setSelectedCik(null)} onCopy={copyView} copied={copied} copyFailed={copyFailed} /> : <IssuerStatusDetail company={selected} onClose={() => setSelectedCik(null)} onCopy={copyView} copied={copied} copyFailed={copyFailed} />)}
    </>}
    <section className={s.bankLink}><div><Building2 size={24} strokeWidth={1.4} /><div><h2>Looking at a bank?</h2><p>Explore deposits, borrowing composition, and reported funding maturities in BankScope.</p></div></div><Link prefetch={false} href="/analysis/banks">Explore bank funding <ArrowRight size={16} /></Link></section>
    <details className={s.methodology}><summary>Methodology, coverage &amp; source limitations <ChevronDown size={15} /></summary><div><p><b>What this shows.</b> Principal maturity schedules in annual SEC filings, with financial context from the same filing and compatible periods. Only supported USD disclosures enter the aggregate. SEC company facts cover standard, entity-wide taxonomy concepts; custom-tagged and individual-instrument schedules may be absent.</p><p><b>Different reporting dates.</b> Years are relative to each source report. Fiscal and rolling schedules are separate views, and fiscal years may differ between issuers. Subsequent repayments, new borrowing, amendments, and acquisitions can change a schedule. Values are not a forecast.</p><p><b>Resources are context.</b> Cash and annual operating cash flow are separate measures and are not added into a synthetic funding pool. Interest coverage is reported operating income divided by positive reported interest expense, using matching annual periods. It is not assigned for financial institutions.</p><p><b>Missing means unavailable.</b> Partial schedules show only supported buckets. Missing values are not zero; the disclosed subtotal of a partial schedule is not a complete debt total. “Thereafter” is never spread across years. Source concepts, dates, and exact values are available in each company’s filing evidence.</p></div></details>
  </div>;
}

function CompanyRow({ company: c, color, selectedYear, selected, onSelect }: { company: RefinancingCompany; color: string; selectedYear: string | null; selected: boolean; onSelect: () => void }) {
  const status = coverageStatus(c);
  const ready = supported(c);
  const subtotal = ready ? disclosedTotal(c) : null;
  const focusAmount = ready ? selectedYear ? bucketValue(c, selectedYear) : nearTerm(c) : null;
  return <button className={s.issuerRow} data-selected={selected} onClick={onSelect} aria-label={`Explore ${c.name}, ${c.ticker}. ${STATUS_LABELS[status]}${ready ? `, report dated ${date(c.profile.asOf)}` : ''}`}>
    <span className={s.issuerName}><b><i style={{ background: color }} />{c.ticker}<em data-status={status}>{STATUS_LABELS[status]}</em></b><strong>{c.name}</strong><small>{ready ? `${date(c.profile.asOf)} · ` : c.checkedAt ? `${status === 'pending' ? 'Market data checked' : 'Maturity data checked'} ${date(c.checkedAt)} · ` : ''}{c.sector}</small></span>
    {ready ? <span className={s.miniProfile} aria-hidden="true">{c.profile.buckets.filter(m => isAmount(m.value) && m.value > 0).map((m, i) => <i key={m.key} style={{ flex: subtotal ? Number(m.value) / subtotal : 1, background: m.key === 'after5' ? 'var(--r-muted)' : color, opacity: m.key === 'after5' ? .35 : 1 - Math.min(i, 5) * .1 }} title={`${m.label}: ${amount(m.value)}`} />)}</span> : <span className={s.unavailableProfile}>{status === 'pending' ? 'Not yet evaluated' : 'No supported schedule'}</span>}
    <span className={s.rowMetric}><small>{selectedYear ? 'Selected bucket' : 'First 2 years'}</small>{amount(focusAmount)}</span><span className={s.rowMetric}><small>Disclosed subtotal</small>{amount(subtotal)}</span><ArrowUpRight size={17} />
  </button>;
}

function IssuerStatusDetail({ company: c, onClose, onCopy, copied, copyFailed }: { company: RefinancingCompany; onClose: () => void; onCopy: () => void; copied: boolean; copyFailed: boolean }) {
  const status = coverageStatus(c);
  const source = safeSource(c.profile?.sourceUrl);
  const secCompany = /^\d{1,10}$/.test(c.cik) ? `https://www.sec.gov/edgar/browse/?CIK=${Number(c.cik)}&owner=exclude` : null;
  return <section id="issuer-maturity-detail" className={s.issuerDetail} aria-labelledby="issuer-title" style={{ '--issuer-color': 'var(--r-muted)' } as CSSProperties}>
    <header className={s.detailHeader}><div><span className={s.eyebrow}>{c.ticker} · {c.sector}</span><h2 id="issuer-title">{c.name}</h2><p>{STATUS_LABELS[status]}{c.checkedAt ? ` · ${status === 'pending' ? 'Market data checked' : 'Maturity data checked'} ${date(c.checkedAt)}` : ''}</p></div><button className={s.close} onClick={onClose} aria-label="Close company detail"><X size={20} /></button></header>
    <div className={s.statusDetailBody}><span className={s.statusBadge} data-status={status}>{STATUS_LABELS[status]}</span><p>{scheduleReason(c)}</p><small>This company contributes no amount to the maturity charts. An unavailable schedule does not mean it has no debt.</small></div>
    <div className={s.detailActions}><Link prefetch={false} href={`/analysis?cik=${encodeURIComponent(c.cik)}&ticker=${encodeURIComponent(c.ticker)}`}>Company analysis <ArrowUpRight size={14} /></Link>{(source || secCompany) && <a href={source || secCompany!} target="_blank" rel="noreferrer">{source ? 'Open SEC filing' : 'Browse SEC filings'} <ExternalLink size={13} /></a>}<button onClick={onCopy}>{copied ? <><Check size={13} />Copied</> : <>Copy company link <ArrowUpRight size={13} /></>}</button></div>
    {copyFailed && <p className={s.copyError}>Clipboard access is unavailable. Company link: <Link prefetch={false} href={`/market/refinancing?company=${encodeURIComponent(c.cik)}`}>open this view</Link>.</p>}
    <details className={s.statusExplanation}><summary>About disclosure coverage</summary><p>Being included in the Market universe and having a supported maturity schedule are separate things. The wall uses validated principal maturity disclosures from standard SEC concepts. Custom tags, different currencies, older reports, and conflicting inputs can leave a company outside the charts.</p><p>Coverage updates with prepared Market snapshots. Awaiting review includes companies pending their first completed check or a later attempt. A company may remain unavailable if its filings do not use supported maturity tags.</p>{c.factsRetrievedAt && <p>Underlying company facts retrieved {date(c.factsRetrievedAt)}.</p>}{c.profile?.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}</details>
  </section>;
}

function IssuerDetail({ company: c, color, onClose, onCopy, copied, copyFailed }: { company: SupportedCompany; color: string; onClose: () => void; onCopy: () => void; copied: boolean; copyFailed: boolean }) {
  const profile = c.profile;
  const max = Math.max(1, ...profile.buckets.map(m => m.value ?? 0));
  const source = safeSource(profile.sourceUrl);
  const metrics = profile.metrics;
  return <section id="issuer-maturity-detail" className={s.issuerDetail} aria-labelledby="issuer-title" style={{ '--issuer-color': color } as CSSProperties}>
    <header className={s.detailHeader}><div><span className={s.eyebrow}>{c.ticker} · {c.sector}</span><h2 id="issuer-title">{c.name}</h2><p>Report date {date(profile.asOf)}{profile.filedAt ? ` · Filed ${date(profile.filedAt)}` : ''}{!profile.coverage.complete ? ` · Partial schedule (${profile.coverage.reportedBuckets} of ${profile.coverage.totalBuckets} buckets)` : ''}</p></div><button className={s.close} onClick={onClose} aria-label="Close company detail"><X size={20} /></button></header>
    <div className={s.detailActions}>{source && <a href={source} target="_blank" rel="noreferrer">Open SEC filing <ExternalLink size={13} /></a>}<Link prefetch={false} href={`/analysis?cik=${encodeURIComponent(c.cik)}&ticker=${encodeURIComponent(c.ticker)}`}>Company analysis <ArrowUpRight size={14} /></Link><button onClick={onCopy}>{copied ? <><Check size={13} />Copied</> : <>Copy company link <ArrowUpRight size={13} /></>}</button><span>USD · issuer’s {profile.basis} schedule</span></div>
    {copyFailed && <p className={s.copyError}>Clipboard access is unavailable. Company link: <Link prefetch={false} href={`/market/refinancing?company=${encodeURIComponent(c.cik)}`}>open this view</Link>.</p>}
    <div className={s.detailGrid}><div className={s.issuerSchedule}><div className={s.subheading}><h3>When debt comes due</h3><span>{amount(disclosedTotal(c))} {profile.coverage.complete ? 'scheduled' : 'disclosed subtotal'}</span></div>{profile.buckets.map(m => <div key={m.key} className={s.maturityRow}><span>{m.calendarYear || m.label}{m.key === 'after5' ? <small>Beyond year 5</small> : m.endDate && !m.calendarYear ? <small>Ends ~{date(m.endDate)}</small> : null}</span><div className={s.maturityTrack} data-missing={!isAmount(m.value)}>{isAmount(m.value) && <i style={{ width: `${m.value / max * 100}%`, minWidth: m.value === 0 ? 0 : 1, background: m.key === 'after5' ? 'var(--r-muted)' : color }} />}</div><strong>{amount(m.value)}{!isAmount(m.value) && <small>Not reported</small>}</strong></div>)}<details className={s.explanation}><summary>Schedule dates &amp; missing values</summary><p>Annual buckets are relative to the report dated {date(profile.asOf)}. For non-calendar fiscal years, displayed end dates are anniversary estimates; exact 52/53-week year ends can differ. Open the filing for the contractual schedule.</p><p>{profile.coverage.complete ? 'All six annual/thereafter buckets have supported values.' : `Only ${profile.coverage.reportedBuckets} of ${profile.coverage.totalBuckets} buckets have supported values. Missing buckets are not zero, and the subtotal is not a complete debt total.`}</p></details></div>
      <div className={s.resources}><div className={s.subheading}><h3>Financial resources</h3><span>Same-filing context</span></div><Metric label="Cash & cash equivalents" metric={metrics.cash} sourceUrl={profile.sourceUrl} /><Metric label="Annual operating cash flow" metric={metrics.operatingCashFlow} sourceUrl={profile.sourceUrl} /><Metric label="Interest coverage" metric={metrics.interestCoverage} ratio sourceUrl={profile.sourceUrl} /><details className={s.explanation}><summary>How these measures relate</summary><p>Cash is a point-in-time balance; operating cash flow covers the stated historical year. Neither forecasts cash available for repayment. Other uses of cash, refinancing access, and contractual terms matter.</p><p>Interest coverage = reported operating income / positive reported interest expense, using matching annual periods. Missing inputs stay unavailable; financial institutions are excluded from this ratio. No rating or refinancing shortfall is assigned.</p></details></div>
    </div>
    <details className={s.evidence}><summary>Exact values &amp; filing evidence <ChevronDown size={14} /></summary><div className={s.evidenceContent}><div><p><strong>{profile.form || 'SEC filing'}</strong> · {date(profile.asOf)}{profile.accession ? ` · ${profile.accession}` : ''}</p>{source && <a href={source} target="_blank" rel="noreferrer">Read the original disclosure <ExternalLink size={12} /></a>}{profile.warnings?.map((note, i) => <p key={i}>{note}</p>)}<div className={s.conceptList}>{Object.entries(metrics).filter(([key]) => ['cash', 'operatingCashFlow', 'operatingIncome', 'interestExpense', 'interestCoverage'].includes(key)).map(([key, metric]) => <p key={key}><b>{key === 'cash' ? 'Cash' : key === 'operatingCashFlow' ? 'Operating cash flow' : key === 'operatingIncome' ? 'Operating income' : key === 'interestExpense' ? 'Interest expense' : 'Interest coverage'}</b><span>{key === 'interestCoverage' ? isAmount(metric?.value) ? `${metric.value.toLocaleString('en-US', { maximumFractionDigits: 3 })}×` : 'Unavailable' : exactAmount(metric?.value ?? null)} · {metricPeriod(metric)}</span><code>{metric?.tag || metric?.formula || humanReason(metric?.reason)}</code></p>)}</div></div><table><caption>Reported principal maturities · USD</caption><thead><tr><th scope="col">Disclosed bucket / concept</th><th scope="col">Amount</th></tr></thead><tbody>{profile.buckets.map(m => <tr key={m.key}><th scope="row">{m.label}{m.tag && <code>{m.tag}</code>}</th><td>{exactAmount(m.value)}</td></tr>)}</tbody><tfoot><tr><th scope="row">{profile.coverage.complete ? 'Schedule total' : 'Reported subtotal · partial'}</th><td>{exactAmount(disclosedTotal(c))}</td></tr></tfoot></table></div></details>
  </section>;
}

function Metric({ label, metric, ratio = false, sourceUrl }: { label: string; metric?: RefinancingMetric; ratio?: boolean; sourceUrl?: string | null }) {
  const available = isAmount(metric?.value);
  const source = safeSource(metric?.source?.documentUrl || sourceUrl);
  return <div className={s.resourceMetric}><div><span>{label}</span><strong>{available ? ratio ? `${metric!.value!.toLocaleString('en-US', { maximumFractionDigits: 1 })}×` : amount(metric!.value) : '—'}</strong></div><small>{available ? metricPeriod(metric) : humanReason(metric?.reason)}{available && source && <> · <a href={source} target="_blank" rel="noreferrer" aria-label={`SEC source for ${label}`}>Source ↗</a></>}</small></div>;
}
