'use client';

import React, { useState, useContext, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart3, Download, TrendingUp, Wallet, ArrowRightLeft, Percent,
  Link as LinkIcon, GitCompare, AlertTriangle, ExternalLink, Info,
  LayoutDashboard, LineChart, Users, DollarSign, History, Building2,
  Loader2, AlertCircle,
} from 'lucide-react';
import { MetricChart } from '../../../components/MetricChart.jsx';
import SummaryDashboard from '../../../components/SummaryDashboard.jsx';
import StockPriceChart from '../../../components/StockPriceChart.jsx';
import InsiderActivity from '../../../components/InsiderActivity.jsx';
import HoldersSection from '../../../components/HoldersSection.jsx';
import ConceptHistoryModal from '../../../components/ConceptHistoryModal.jsx';
import { TickerContext } from '../../../contexts/TickerContext';
import { secDataUrl } from '../../../utils/secApi.js';
import { checkIsFund } from '../../../utils/fundCheck.js';
import {
  extractAnnualPeriods,
  extractQuarterlyPeriods,
  buildIncomeStatement,
  buildBalanceSheet,
  buildCashFlow,
  buildRatios,
  formatValue,
  formatGrowth,
  computeGrowth,
  periodLabel,
  buildSourceUrl,
} from '../../../utils/xbrlParser.js';
import { classifyIndustry, industryLabel, industryDisclosure } from '../../../utils/industry.js';

// ============================================================================
// Types
// ============================================================================
interface AnalysisClientProps {
  urlTicker: string;
  preloadedCik: string | null;
  preloadedCompanyName: string | null;
  preloadedSicDescription: string | null;
}

interface FilingEntry {
  form: string;
  filingDate: string;
  accession: string;
  accessionNumber: string;
  documentUrl: string;
}

interface CompanyState {
  name: string;
  cik: string;
  sic?: string;
  sicNumber?: string | number;
  exchanges: string;
  tickers: string;
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  ein?: string;
}

interface InsiderMarker {
  date: string;
  direction: 'buy' | 'sell';
  ownerName?: string;
  relationship?: string;
  shares?: number;
  price?: number;
  value?: number;
  accession?: string;
  xmlUrl?: string;
}

interface ConceptToTrace {
  tag: string;
  taxonomy: string;
  unit: string;
}

// ============================================================================
// Section + statement definitions (unchanged from original)
// ============================================================================
const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'stock-chart', label: 'Stock Chart', icon: LineChart },
  { id: 'insiders', label: 'Insiders', icon: Users },
  { id: 'holders', label: 'Holders', icon: Building2 },
  { id: 'financials', label: 'Financials', icon: DollarSign },
  { id: 'ratios', label: 'Ratios', icon: Percent },
];

const STATEMENTS = [
  { id: 'income', label: 'Income Statement', icon: TrendingUp, build: buildIncomeStatement,
    featuredRows: ['Revenue', 'Net Income', 'Operating Income', 'Gross Profit'] },
  { id: 'balance', label: 'Balance Sheet', icon: Wallet, build: buildBalanceSheet,
    featuredRows: ['Total Assets', 'Total Liabilities', "Stockholders' Equity", 'Cash & Equivalents'] },
  { id: 'cashflow', label: 'Cash Flow', icon: ArrowRightLeft, build: buildCashFlow,
    featuredRows: ['Operating Cash Flow', 'Capital Expenditures', 'Financing Cash Flow', 'Investing Cash Flow'] },
];

// ============================================================================
// Main client component
// ============================================================================
export default function AnalysisClient({
  urlTicker,
  preloadedCik,
  preloadedCompanyName,
  preloadedSicDescription,
}: AnalysisClientProps) {
  const router = useRouter();
  const ctx = useContext(TickerContext);
  const tickerMap = ctx?.tickerMap ?? null;

  // Local company state — initialized from server props for instant display,
  // augmented client-side once submissions fetch completes
  const [company, setCompanyState] = useState<CompanyState | null>(
    preloadedCik && preloadedCompanyName
      ? {
          name: preloadedCompanyName,
          cik: preloadedCik,
          sic: preloadedSicDescription || undefined,
          exchanges: 'N/A',
          tickers: urlTicker,
        }
      : null
  );

  const [facts, setFacts] = useState<Record<string, unknown> | null>(null);
  const [sicCode, setSicCode] = useState<string | number | null>(null);
  const [filings, setFilings] = useState<FilingEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statement, setStatement] = useState('income');
  const [periodType, setPeriodType] = useState<'annual' | 'quarterly'>('annual');
  const [showGrowth, setShowGrowth] = useState(true);
  const [activeSection, setActiveSection] = useState('overview');

  const [insiderMarkers, setInsiderMarkers] = useState<InsiderMarker[]>([]);
  const handleInsiderMarkers = useCallback((markers: InsiderMarker[]) => {
    setInsiderMarkers(markers || []);
  }, []);

  const [conceptToTrace, setConceptToTrace] = useState<ConceptToTrace | null>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // Scrollspy: highlight active section as user scrolls
  useEffect(() => {
    if (!facts) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveSection(visible[0].target.id);
        }
      },
      { rootMargin: '-100px 0px -60% 0px', threshold: 0 }
    );
    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [facts]);

  // ==========================================================================
  // fetchFacts — load XBRL data for a given company entry
  //
  // Order matters: clear state FIRST, then run the fund check, then fetch.
  // The original code ran setFacts(null) AFTER the fund check, causing a
  // brief flicker where stale data was visible during the async check.
  // ==========================================================================
  const fetchFacts = useCallback(
    async (entry: { ticker: string; cik: string; name: string; type: string; isFund: boolean }) => {
      // Clear state immediately so any previous company's data disappears
      setFacts(null);
      setFilings([]);
      setInsiderMarkers([]);
      setActiveSection('overview');
      setError(null);

      // Fund detection — if already known to be a fund, redirect
      if (entry.type === 'fund' || entry.isFund) {
        router.push(`/fund/${entry.ticker}`);
        return;
      }

      setLoading(true);

      try {
        const authoritativeIsFund = await checkIsFund(entry.cik, 3000);
        if (authoritativeIsFund === true) {
          setLoading(false);
          router.push(`/fund/${entry.ticker}`);
          return;
        }
      } catch (err) {
        console.warn('Fund check unexpected error:', err);
      }

      try {
        const [submissionsRes, factsRes] = await Promise.all([
          fetch(secDataUrl(`/submissions/CIK${entry.cik}.json`)),
          fetch(secDataUrl(`/api/xbrl/companyfacts/CIK${entry.cik}.json`)),
        ]);

        if (!submissionsRes.ok) throw new Error(`Submissions API returned ${submissionsRes.status}`);
        if (!factsRes.ok) {
          if (factsRes.status === 404) {
            throw new Error('This company has no XBRL financial data available.');
          }
          throw new Error(`XBRL API returned ${factsRes.status}`);
        }

        const submissions = await submissionsRes.json();
        const factsData = await factsRes.json();

        setCompanyState({
          name: submissions.name,
          cik: entry.cik,
          sic: submissions.sicDescription,
          sicNumber: submissions.sic,
          exchanges: submissions.exchanges?.join(', ') || 'N/A',
          tickers: submissions.tickers?.join(', ') || entry.name,
          fiscalYearEnd: submissions.fiscalYearEnd,
          stateOfIncorporation: submissions.stateOfIncorporation,
          ein: submissions.ein,
        });

        setSicCode(submissions.sic);
        setFacts(factsData.facts || {});

        const recent = submissions.filings?.recent;
        if (recent) {
          const allFilings: FilingEntry[] = recent.accessionNumber.map((acc: string, i: number) => {
            const accessionClean = acc.replace(/-/g, '');
            const primaryDoc = recent.primaryDocument[i];
            return {
              form: recent.form[i],
              filingDate: recent.filingDate[i],
              accession: acc,
              accessionNumber: acc,
              documentUrl: `https://www.sec.gov/Archives/edgar/data/${parseInt(entry.cik, 10)}/${accessionClean}/${primaryDoc}`,
            };
          });
          setFilings(allFilings);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to fetch financial data: ${msg}`);
      } finally {
        setLoading(false);
      }
    },
    [router]
  );

  // ==========================================================================
  // AUTO-FETCH on mount / ticker change
  //
  // Server already gave us preloadedCik. Use it directly when available to
  // skip the tickerMap lookup. Fall back to tickerMap only if server lookup
  // failed.
  // ==========================================================================
  useEffect(() => {
    if (!urlTicker) {
      setFacts(null);
      setFilings([]);
      setError(null);
      return;
    }

    const upper = urlTicker.toUpperCase();

    // Path A: server resolved CIK → fetch directly
    if (preloadedCik && preloadedCompanyName) {
      fetchFacts({
        ticker: upper,
        cik: preloadedCik,
        name: preloadedCompanyName,
        type: 'company',
        isFund: false,
      });
      return;
    }

    // Path B: server failed to resolve → wait for client-side ticker map
    if (!tickerMap) return;

    const entry = tickerMap[upper];
    if (!entry) {
      setError(`No SEC registrant found for "${urlTicker}". Try a valid ticker, CIK, or company name.`);
      setFacts(null);
      setFilings([]);
      return;
    }

    fetchFacts({
      ticker: upper,
      cik: entry.cik,
      name: entry.name,
      type: entry.isFund ? 'fund' : 'company',
      isFund: entry.isFund,
    });
  }, [urlTicker, tickerMap, preloadedCik, preloadedCompanyName, fetchFacts]);

  // ==========================================================================
  // Derived state — periods, table rows, growth, etc.
  // ==========================================================================
  const periods = facts
    ? periodType === 'annual'
      ? extractAnnualPeriods(facts).slice(0, 10)
      : extractQuarterlyPeriods(facts).slice(0, 12)
    : [];

  const statementDef = STATEMENTS.find((s) => s.id === statement) || STATEMENTS[0];
  const rows = useMemo(
    () => (facts && periods.length > 0 ? statementDef.build(facts, periods, sicCode) : []),
    [facts, periods, statementDef, sicCode]
  );

  const ratioRows = useMemo(
    () => (facts && periods.length > 0 ? buildRatios(facts, periods, sicCode) : []),
    [facts, periods, sicCode]
  );

  const featuredRows = useMemo(() => {
    if (!rows.length) return [];
    return rows.filter((r: { label: string }) => statementDef.featuredRows.includes(r.label));
  }, [rows, statementDef]);

  const featuredRatioRows = useMemo(() => {
    if (!ratioRows.length) return [];
    return ratioRows
      .filter((r: { values: { value: number | null }[] }) => r.values.some((v) => v.value != null))
      .slice(0, 4);
  }, [ratioRows]);

  const growthVisible = showGrowth && periodType === 'annual';

  // ==========================================================================
  // Action handlers
  // ==========================================================================
  const exportCsv = (rowData: any[], name: string) => {
    if (!rowData.length || !periods.length) return;
    const header = ['Metric', ...periods.map(periodLabel), 'YoY %', '5Y CAGR %', '10Y CAGR %'].join(',');
    const lines = rowData.map((r) => {
      const g = computeGrowth(r);
      const vals = r.values.map((v: { value: number | null }) => (v.value == null ? '' : v.value));
      return [
        `"${r.label}"`,
        ...vals,
        g.yoy != null ? g.yoy.toFixed(2) : '',
        g.cagr5y != null ? g.cagr5y.toFixed(2) : '',
        g.cagr10y != null ? g.cagr10y.toFixed(2) : '',
      ].join(',');
    });
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${company?.name || 'financials'}_${name}_${periodType}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyShareLink = () => {
    const t = company?.tickers?.split(',')[0]?.trim() || urlTicker;
    const url = `${window.location.origin}/analysis/${t}`;
    navigator.clipboard.writeText(url);
  };

  const goToCompare = () => {
    const t = urlTicker || company?.tickers?.split(',')[0]?.trim();
    if (t) router.push(`/compare/${t}`);
    else router.push('/compare');
  };

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const traceRowHistory = useCallback((row: { values: { source?: { tag: string; taxonomy?: string; unit?: string } }[] }) => {
    const firstSourced = row.values.find((v) => v.source && v.source.tag);
    if (!firstSourced || !firstSourced.source) return;
    setConceptToTrace({
      tag: firstSourced.source.tag,
      taxonomy: firstSourced.source.taxonomy || 'us-gaap',
      unit: firstSourced.source.unit || 'USD',
    });
  }, []);

  const group = classifyIndustry(sicCode);
  const disclosure = industryDisclosure(group);
  const chartTicker = company?.tickers?.split(',')[0]?.trim() || urlTicker;
  const form4Count = filings.filter((f) => f.form === '4').length;

  // ==========================================================================
  // Render
  // ==========================================================================
  return (
    <>
      {loading && (
        <div className="flex items-center gap-2 text-sm text-stone-400 mb-4 uppercase tracking-widest">
          <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
          Loading {urlTicker?.toUpperCase()}...
        </div>
      )}

      {error && (
        <div className="bg-rose-950/30 border-2 border-rose-900/60 px-4 py-3 mb-4 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span className="text-sm text-rose-200">{error}</span>
        </div>
      )}

      {!loading && !facts && !error && (
        <div className="border-2 border-dashed border-stone-800 p-12 text-center">
          <BarChart3 className="w-12 h-12 text-stone-700 mx-auto mb-4" />
          <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">Financial Analysis</p>
          <p className="text-stone-600 text-xs max-w-md mx-auto">
            Use the search bar above to look up any company by ticker or name.
            You'll see financial data, industry-specific ratios, stock prices with filing markers,
            and insider trading activity.
          </p>
          <p className="text-stone-700 text-[10px] max-w-md mx-auto mt-3">
            Mutual fund and ETF tickers are automatically routed to the Funds page.
          </p>
        </div>
      )}

      {facts && (
        <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr] gap-6">
          <aside className="lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <div className="lg:hidden flex gap-1 overflow-x-auto pb-2 -mx-2 px-2 mb-4 border-b-2 border-stone-800">
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const active = activeSection === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => scrollToSection(s.id)}
                    className={`shrink-0 flex items-center gap-1.5 px-3 py-2 text-[10px] uppercase tracking-[0.15em] font-bold border-2 transition-colors ${
                      active
                        ? 'bg-amber-500 text-stone-950 border-amber-500'
                        : 'bg-stone-900 text-stone-400 border-stone-800'
                    }`}
                    type="button"
                  >
                    <Icon className="w-3 h-3" />
                    {s.label}
                  </button>
                );
              })}
            </div>

            <nav className="hidden lg:block space-y-1">
              <div className="text-[10px] uppercase tracking-[0.2em] text-stone-600 mb-2 px-3">
                Sections
              </div>
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const active = activeSection === s.id;
                const badge = s.id === 'insiders' && form4Count > 0 ? form4Count : null;
                return (
                  <button
                    key={s.id}
                    onClick={() => scrollToSection(s.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-xs uppercase tracking-[0.15em] font-bold border-l-2 transition-all ${
                      active
                        ? 'bg-amber-500/10 text-amber-400 border-amber-500'
                        : 'text-stone-500 border-stone-800 hover:text-stone-200 hover:border-stone-600 hover:bg-stone-900/50'
                    }`}
                    type="button"
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="flex-1 text-left">{s.label}</span>
                    {badge && (
                      <span className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded ${
                        active ? 'bg-amber-500 text-stone-950' : 'bg-stone-800 text-stone-400'
                      }`}>
                        {badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="hidden lg:flex flex-col gap-1 mt-6 pt-4 border-t border-stone-800">
              <div className="text-[10px] uppercase tracking-[0.2em] text-stone-600 mb-2 px-3">
                Actions
              </div>
              <button
                onClick={copyShareLink}
                className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest text-stone-400 hover:text-amber-400 hover:bg-stone-900/50 transition-colors"
                type="button"
              >
                <LinkIcon className="w-3.5 h-3.5" />
                Share
              </button>
              <button
                onClick={goToCompare}
                className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest text-stone-400 hover:text-amber-400 hover:bg-stone-900/50 transition-colors"
                type="button"
              >
                <GitCompare className="w-3.5 h-3.5" />
                Compare
              </button>
            </div>
          </aside>

          <main className="min-w-0 space-y-12">
            <section id="overview" className="scroll-mt-4">
              <SectionHeader icon={LayoutDashboard} title="Overview" />

              <div className="mb-4 border-2 border-amber-700/40 bg-amber-950/20 p-4 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-100/90 leading-relaxed">
                  <span className="font-bold text-amber-300">Experimental — verify before relying on these numbers.</span>{' '}
                  Financial data is parsed from SEC's XBRL API. Click any value to see the exact SEC source tag.
                </div>
              </div>

              {disclosure && (
                <div className={`mb-6 border-2 p-4 flex items-start gap-3 ${
                  disclosure.tone === 'warn'
                    ? 'border-rose-700/40 bg-rose-950/20'
                    : 'border-sky-700/40 bg-sky-950/20'
                }`}>
                  <Info className={`w-5 h-5 shrink-0 mt-0.5 ${
                    disclosure.tone === 'warn' ? 'text-rose-400' : 'text-sky-400'
                  }`} />
                  <div className="text-xs leading-relaxed">
                    <span className={`font-bold ${
                      disclosure.tone === 'warn' ? 'text-rose-300' : 'text-sky-300'
                    }`}>
                      {disclosure.title}
                    </span>{' '}
                    <span className="text-stone-200">{disclosure.body}</span>
                  </div>
                </div>
              )}

              {periodType === 'annual' && periods.length > 0 && (
                <SummaryDashboard facts={facts} periods={periods} sicCode={sicCode} />
              )}
            </section>

            <section id="stock-chart" className="scroll-mt-4">
              <SectionHeader icon={LineChart} title="Stock Chart" />
              {chartTicker && filings.length > 0 ? (
                <StockPriceChart ticker={chartTicker} filings={filings} insiderMarkers={insiderMarkers} />
              ) : (
                <div className="border-2 border-stone-800 bg-stone-900/30 p-6 text-center">
                  <p className="text-stone-500 text-xs uppercase tracking-widest">
                    Stock chart unavailable
                  </p>
                </div>
              )}
            </section>

            <section id="insiders" className="scroll-mt-4">
              <SectionHeader icon={Users} title="Insider Activity" />
              {company?.cik ? (
                <InsiderActivity cik={company.cik} filings={filings} onMarkersReady={handleInsiderMarkers} />
              ) : (
                <div className="border-2 border-stone-800 bg-stone-900/30 p-6 text-center">
                  <p className="text-stone-500 text-xs uppercase tracking-widest">Loading insider data...</p>
                </div>
              )}
            </section>

            {chartTicker && (
              <HoldersSection ticker={chartTicker} cik={company?.cik} companyName={company?.name} />
            )}

            <section id="financials" className="scroll-mt-4">
              <SectionHeader icon={DollarSign} title="Financial Statements" />

              <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap gap-1">
                  {STATEMENTS.map((s) => {
                    const Icon = s.icon;
                    const active = statement === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setStatement(s.id)}
                        className={`flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-[0.15em] font-bold border-2 transition-colors ${
                          active
                            ? 'bg-amber-500 text-stone-950 border-amber-500'
                            : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700 hover:text-stone-200'
                        }`}
                        type="button"
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {s.label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex ml-auto gap-1 flex-wrap">
                  <button
                    onClick={() => setPeriodType('annual')}
                    className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                      periodType === 'annual' ? 'bg-stone-100 text-stone-950 border-stone-100' : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                    }`}
                    type="button"
                  >
                    Annual (10-K)
                  </button>
                  <button
                    onClick={() => setPeriodType('quarterly')}
                    className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                      periodType === 'quarterly' ? 'bg-stone-100 text-stone-950 border-stone-100' : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                    }`}
                    type="button"
                  >
                    Quarterly (10-Q)
                  </button>

                  {periodType === 'annual' && (
                    <button
                      onClick={() => setShowGrowth((s) => !s)}
                      className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                        showGrowth ? 'bg-emerald-500 text-stone-950 border-emerald-500' : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                      }`}
                      type="button"
                    >
                      Growth {showGrowth ? 'ON' : 'OFF'}
                    </button>
                  )}

                  <button
                    onClick={() => exportCsv(rows, statement)}
                    className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors"
                    type="button"
                  >
                    <Download className="w-3.5 h-3.5" />
                    CSV
                  </button>
                </div>
              </div>

              {featuredRows.length > 0 && (
                <div className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {featuredRows.map((row: { label: string; values: any[]; format: string }) => (
                    <MetricChart
                      key={row.label}
                      title={row.label}
                      data={row.values}
                      format={row.format}
                      chartType="bar"
                    />
                  ))}
                </div>
              )}

              <FinancialTable
                rows={rows}
                periods={periods}
                growthVisible={growthVisible}
                cik={company?.cik}
                onTraceRow={traceRowHistory}
                isHeaderRow={(label: string) => ['Revenue', 'Gross Profit', 'Operating Income', 'Net Income', 'Total Assets', 'Total Liabilities', "Stockholders' Equity", 'Operating Cash Flow'].includes(label)}
              />

              <p className="mt-4 text-[11px] text-stone-500 leading-relaxed">
                Source: SEC XBRL Company Facts. Hover any value for the source XBRL tag; click to open SEC's concept endpoint.
                Click the <History className="inline w-3 h-3 text-amber-400" /> icon next to any metric to trace its full reporting history including restatements.
                Industry group: <span className="text-amber-400 font-bold">{industryLabel(group)}</span>
                {sicCode ? <span> · SIC {sicCode}</span> : null}
              </p>
            </section>

            <section id="ratios" className="scroll-mt-4">
              <SectionHeader icon={Percent} title="Ratios" />

              <div className="mb-4 flex gap-1 justify-end flex-wrap">
                {periodType === 'annual' && (
                  <button
                    onClick={() => setShowGrowth((s) => !s)}
                    className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                      showGrowth ? 'bg-emerald-500 text-stone-950 border-emerald-500' : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                    }`}
                    type="button"
                  >
                    Growth {showGrowth ? 'ON' : 'OFF'}
                  </button>
                )}
                <button
                  onClick={() => exportCsv(ratioRows, 'ratios')}
                  className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors"
                  type="button"
                >
                  <Download className="w-3.5 h-3.5" />
                  CSV
                </button>
              </div>

              {featuredRatioRows.length > 0 && (
                <div className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {featuredRatioRows.map((row: { label: string; values: any[]; format: string }) => (
                    <MetricChart
                      key={row.label}
                      title={row.label}
                      data={row.values}
                      format={row.format}
                      chartType="line"
                    />
                  ))}
                </div>
              )}

              <FinancialTable
                rows={ratioRows}
                periods={periods}
                growthVisible={growthVisible}
                cik={company?.cik}
                onTraceRow={traceRowHistory}
                isHeaderRow={() => false}
              />

              <p className="mt-4 text-[11px] text-stone-500 leading-relaxed">
                Industry-specific ratios auto-selected based on SIC {sicCode}
                ({industryLabel(group)}). Ratios are computed from reported XBRL values
                and may differ slightly from company-reported non-GAAP versions.
              </p>
            </section>
          </main>
        </div>
      )}

      {conceptToTrace && company?.cik && (
        <ConceptHistoryModal
          cik={company.cik}
          companyName={company?.name || chartTicker}
          tag={conceptToTrace.tag}
          taxonomy={conceptToTrace.taxonomy}
          unit={conceptToTrace.unit}
          onClose={() => setConceptToTrace(null)}
        />
      )}
    </>
  );
}

// ============================================================================
// Sub-components — moved from page-components/AnalysisPage.jsx unchanged
// ============================================================================

function SectionHeader({ icon: Icon, title }: { icon: any; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4 pb-2 border-b-2 border-stone-800">
      <Icon className="w-5 h-5 text-amber-400" />
      <h2 className="text-sm uppercase tracking-[0.25em] font-black text-stone-200">{title}</h2>
    </div>
  );
}

interface FinancialTableProps {
  rows: any[];
  periods: any[];
  growthVisible: boolean;
  cik?: string;
  onTraceRow: (row: any) => void;
  isHeaderRow: (label: string) => boolean;
}

function FinancialTable({ rows, periods, growthVisible, cik, onTraceRow, isHeaderRow }: FinancialTableProps) {
  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-stone-900 border-b-2 border-stone-800">
          <tr>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.25em] text-stone-400 sticky left-0 bg-stone-900 z-20 min-w-[240px]">
              Metric
            </th>
            {periods.map((p: any) => (
              <th
                key={`${p.fy}-${p.fp}-${p.end}`}
                className="text-right px-4 py-3 text-[10px] uppercase tracking-[0.2em] text-amber-400 font-black min-w-[90px]"
              >
                {periodLabel(p)}
              </th>
            ))}
            {growthVisible && (
              <>
                <th className="text-right px-3 py-3 text-[10px] uppercase tracking-[0.2em] text-emerald-400 font-black min-w-[80px] sticky right-[160px] bg-stone-900 z-20 border-l-2 border-stone-800">
                  YoY
                </th>
                <th className="text-right px-3 py-3 text-[10px] uppercase tracking-[0.2em] text-emerald-400 font-black min-w-[80px] sticky right-[80px] bg-stone-900 z-20">
                  5Y CAGR
                </th>
                <th className="text-right px-3 py-3 text-[10px] uppercase tracking-[0.2em] text-emerald-400 font-black min-w-[80px] sticky right-0 bg-stone-900 z-20">
                  10Y CAGR
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row: any) => {
            const header = isHeaderRow(row.label);
            const growth = computeGrowth(row);
            const hasSource = row.values.some((v: any) => v.source && v.source.tag);
            return (
              <tr key={row.label} className={`border-b border-stone-800/60 hover:bg-amber-500/5 transition-colors group ${header ? 'bg-stone-900/40' : ''}`}>
                <td className={`px-4 py-2.5 sticky left-0 z-10 ${header ? 'bg-stone-900/95 text-stone-100 font-bold' : 'bg-stone-950/95 text-stone-300'}`}>
                  <span className="inline-flex items-center gap-1.5">
                    {row.label}
                    {hasSource && onTraceRow && (
                      <button
                        onClick={() => onTraceRow(row)}
                        className="text-stone-600 hover:text-amber-400 transition-colors opacity-0 group-hover:opacity-100"
                        title="Trace full history of this concept (detects restatements)"
                        aria-label={`Trace history of ${row.label}`}
                        type="button"
                      >
                        <History className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                </td>
                {row.values.map((v: any, i: number) => (
                  <ValueCell key={i} value={v.value} source={v.source} cik={cik} format={row.format} isHeader={header} />
                ))}
                {growthVisible && (
                  <>
                    <GrowthCell pct={growth.yoy} isHeader={header} stickyRight={160} borderLeft />
                    <GrowthCell pct={growth.cagr5y} isHeader={header} stickyRight={80} />
                    <GrowthCell pct={growth.cagr10y} isHeader={header} stickyRight={0} />
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface ValueCellProps {
  value: number | null;
  source?: { tag: string; unit: string; end: string; filed: string; accession: string };
  cik?: string;
  format: string;
  isHeader: boolean;
}

function ValueCell({ value, source, cik, format, isHeader }: ValueCellProps) {
  const sourceUrl = source && cik ? buildSourceUrl(cik, source) : null;
  const tooltip = source
    ? `Tag: ${source.tag}\nUnit: ${source.unit}\nPeriod: ${source.end}\nFiled: ${source.filed}\nAccession: ${source.accession}\nClick to open SEC source`
    : value == null ? 'No data reported for this concept' : 'Computed value';
  const cellClasses = `px-4 py-2.5 text-right tabular-nums group/cell ${
    value == null ? 'text-stone-700' : isHeader ? 'text-stone-100 font-bold' : 'text-stone-300'
  }`;
  if (!sourceUrl || value == null) {
    return <td className={cellClasses} title={tooltip}>{formatValue(value, format)}</td>;
  }
  return (
    <td className={cellClasses} title={tooltip}>
      <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-amber-400 transition-colors">
        {formatValue(value, format)}
        <ExternalLink className="w-3 h-3 opacity-0 group-hover/cell:opacity-50 transition-opacity" />
      </a>
    </td>
  );
}

interface GrowthCellProps {
  pct: number | null;
  isHeader: boolean;
  borderLeft?: boolean;
  stickyRight?: number;
}

function GrowthCell({ pct, isHeader, borderLeft, stickyRight }: GrowthCellProps) {
  const g = formatGrowth(pct);
  const colorClass = g.color === 'positive' ? 'text-emerald-400' : g.color === 'negative' ? 'text-rose-400' : 'text-stone-600';
  const bg = isHeader ? 'bg-stone-900/95' : 'bg-stone-950/95';
  const sticky = stickyRight !== undefined ? `sticky z-10` : '';
  const styleObj = stickyRight !== undefined ? { right: `${stickyRight}px` } : undefined;
  return (
    <td style={styleObj} className={`px-3 py-2.5 text-right tabular-nums ${bg} ${sticky} ${colorClass} ${isHeader ? 'font-bold' : ''} ${borderLeft ? 'border-l-2 border-stone-800' : ''}`}>
      {g.text}
    </td>
  );
}
