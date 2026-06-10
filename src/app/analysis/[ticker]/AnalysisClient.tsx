'use client';

import React, { useState, useContext, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart3, Download, TrendingUp, Wallet, ArrowRightLeft, Percent,
  Link as LinkIcon, GitCompare, AlertTriangle, ExternalLink, Info,
  LayoutDashboard, LineChart, Users, DollarSign, History, Building2,
  Loader2, AlertCircle, ShieldCheck, FileText,
} from 'lucide-react';
import { MetricChart as MetricChartImpl } from '../../../components/MetricChart.jsx';
import SummaryDashboardImpl from '../../../components/SummaryDashboard.jsx';
import StockPriceChartImpl from '../../../components/StockPriceChart.jsx';
import InsiderActivityImpl from '../../../components/InsiderActivity.jsx';
import HoldersSectionImpl from '../../../components/HoldersSection.jsx';
import ConceptHistoryModalImpl from '../../../components/ConceptHistoryModal.jsx';
import { TickerContext } from '../../../contexts/TickerContext';
import { secDataUrl } from '../../../utils/secApi.js';
import { checkIsFund } from '../../../utils/fundCheck.js';
import { getItemsInfo } from '../../../utils/formItems.js';
import {
  extractAnnualPeriods,
  extractQuarterlyPeriods,
  buildIncomeStatement,
  buildBalanceSheet,
  buildCashFlow,
  buildMetricRow,
  buildRatios,
  formatValue,
  formatGrowth,
  computeGrowth,
  periodLabel,
  buildSourceUrl,
} from '../../../utils/xbrlParser.js';
import { classifyIndustry, industryLabel, industryDisclosure, INDUSTRY_GROUPS } from '../../../utils/industry.js';

// ============================================================================
// JS-component prop interop
//
// The components below are plain .jsx files with no TypeScript prop types.
// When a JS component is imported into a TS file, TypeScript can infer prop
// types in surprising (and often wrong) ways — for example narrowing array
// props to `never[]` based on incidental JSX usage. Casting each component
// to `any` at the import boundary tells TS "trust the runtime here" and
// matches how the rest of this codebase treats JS-utility interop. The
// runtime behavior is unchanged.
// ============================================================================
/* eslint-disable @typescript-eslint/no-explicit-any */
const MetricChart = MetricChartImpl as any;
const SummaryDashboard = SummaryDashboardImpl as any;
const StockPriceChart = StockPriceChartImpl as any;
const InsiderActivity = InsiderActivityImpl as any;
const HoldersSection = HoldersSectionImpl as any;
const ConceptHistoryModal = ConceptHistoryModalImpl as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  reportDate?: string;
  primaryDoc?: string;
  primaryDescription?: string;
  items?: string;
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
              reportDate: recent.reportDate?.[i],
              primaryDoc,
              primaryDescription: recent.primaryDocDescription?.[i],
              items: recent.items?.[i],
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
  const annualPeriods = useMemo(
    () => (facts ? extractAnnualPeriods(facts).slice(0, 10) : []),
    [facts]
  );
  const quarterlyPeriods = useMemo(
    () => (facts ? extractQuarterlyPeriods(facts).slice(0, 12) : []),
    [facts]
  );
  const periods = periodType === 'annual' ? annualPeriods : quarterlyPeriods;

  const statementDef = STATEMENTS.find((s) => s.id === statement) || STATEMENTS[0];
  const rows = useMemo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (facts && periods.length > 0 ? statementDef.build(facts, periods, sicCode as any) : []),
    [facts, periods, statementDef, sicCode]
  );

  const ratioRows = useMemo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (facts && periods.length > 0 ? buildRatios(facts, periods, sicCode as any) : []),
    [facts, periods, sicCode]
  );

  const coverageStatementRows = useMemo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (facts && annualPeriods.length > 0 ? STATEMENTS.flatMap((s) => s.build(facts, annualPeriods, sicCode as any)) : []),
    [facts, annualPeriods, sicCode]
  );

  const coverageRatioRows = useMemo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (facts && annualPeriods.length > 0 ? buildRatios(facts, annualPeriods, sicCode as any) : []),
    [facts, annualPeriods, sicCode]
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

  const traceRowHistory = useCallback((row: { values: { source?: { tag: string; taxonomy?: string; unit?: string }, sources?: { tag: string; taxonomy?: string; unit?: string }[] }[] }) => {
    const firstSourced = row.values.find((v) => (v.source && v.source.tag) || v.sources?.some((source) => source.tag));
    const source = firstSourced?.source?.tag
      ? firstSourced.source
      : firstSourced?.sources?.find((item) => item.tag);
    if (!source) return;
    setConceptToTrace({
      tag: source.tag,
      taxonomy: source.taxonomy || 'us-gaap',
      unit: source.unit || 'USD',
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

              {annualPeriods.length > 0 && (
                <>
                  <DataCoveragePanel
                    statementRows={coverageStatementRows}
                    ratioRows={coverageRatioRows}
                    periods={annualPeriods}
                    filings={filings}
                    cik={company?.cik}
                  />
                  <FilingActivityPanel filings={filings} ticker={chartTicker} />
                  <SummaryDashboard facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} />
                  <QualitySnapshot facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} />
                </>
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

interface SourceFact {
  tag: string;
  unit: string;
  end: string;
  filed: string;
  accession: string;
}

interface MetricPoint {
  value: number | null;
  source?: SourceFact | null;
  sources?: SourceFact[];
}

function FilingActivityPanel({
  filings,
  ticker,
}: {
  filings: FilingEntry[];
  ticker?: string;
}) {
  const activity = useMemo(() => {
    const latestAnnual = findLatestFiling(filings, ['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);
    const latestQuarterly = findLatestFiling(filings, ['10-Q', '10-Q/A', '6-K']);
    const latestCurrent = findLatestFiling(filings, ['8-K', '8-K/A', '6-K']);
    const latestProxy = filings.find((filing) => filing.form.includes('DEF 14A') || filing.form.includes('PRE 14A')) || null;
    const insiderForms = filings.filter((filing) => ['3', '3/A', '4', '4/A', '5', '5/A'].includes(filing.form));
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const last90Days = filings.filter((filing) => {
      const time = new Date(filing.filingDate).getTime();
      return Number.isFinite(time) && time >= cutoff;
    }).length;
    const eventFilings = filings
      .filter((filing) => isEventFiling(filing))
      .slice(0, 6);

    return {
      latestAnnual,
      latestQuarterly,
      latestCurrent,
      latestProxy,
      insiderForms,
      last90Days,
      eventFilings,
    };
  }, [filings]);

  if (!filings.length) return null;

  const filingsHref = ticker ? `/filings/${ticker}` : '/filings';

  return (
    <div className="mb-6 border-2 border-stone-800 bg-stone-950/50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              SEC Filing Activity
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Recent source documents that explain what changed around the reported numbers.
          </p>
        </div>
        <a
          href={filingsHref}
          className="inline-flex items-center gap-1.5 border border-stone-700 bg-stone-900 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.16em] text-stone-300 hover:border-sky-500 hover:text-sky-300 transition-colors"
        >
          Full Filing History
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
        <FilingStat
          label="Annual Report"
          filing={activity.latestAnnual}
          fallback="No recent 10-K / 20-F in SEC submissions feed"
        />
        <FilingStat
          label="Quarterly Update"
          filing={activity.latestQuarterly}
          fallback="No recent 10-Q / 6-K in SEC submissions feed"
        />
        <FilingStat
          label="Current Report"
          filing={activity.latestCurrent}
          fallback="No recent 8-K / 6-K in SEC submissions feed"
        />
        <FilingCountStat
          label="Recent Filing Load"
          value={`${activity.last90Days}`}
          detail={`${activity.insiderForms.length} insider ownership forms in recent feed`}
        />
      </div>

      {activity.eventFilings.length > 0 && (
        <div className="border-t border-stone-800 px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
              Event Watch
            </div>
            {activity.latestProxy && (
              <a
                href={activity.latestProxy.documentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-violet-300 hover:text-violet-200 transition-colors"
              >
                Latest Proxy: {activity.latestProxy.filingDate}
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {activity.eventFilings.map((filing) => (
              <FilingEventRow key={filing.accession} filing={filing} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FilingCountStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border-2 border-stone-800 bg-stone-950/60 p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-stone-500 font-bold">
        <FileText className="w-3.5 h-3.5 text-stone-500" />
        {label}
      </div>
      <div className="mt-2 text-lg font-black tabular-nums text-stone-100">{value}</div>
      <div className="mt-2 text-xs leading-relaxed text-stone-400">
        filings in the last 90 days
        <span className="block text-stone-500">{detail}</span>
      </div>
    </div>
  );
}

function FilingEventRow({ filing }: { filing: FilingEntry }) {
  const items = filing.form.startsWith('8-K') ? getItemsInfo(filing.items || '') : [];
  return (
    <a
      href={filing.documentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group block border border-stone-800 bg-stone-900/30 px-3 py-3 hover:border-sky-700/70 hover:bg-sky-950/10 transition-colors"
    >
      <div className="flex items-start gap-3">
        <span className={`shrink-0 border px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em] ${filingBadgeClass(filing.form)}`}>
          {filing.form}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-bold text-stone-100">
            <span className="truncate">{filing.primaryDescription || filing.primaryDoc || 'SEC filing'}</span>
            <ExternalLink className="w-3 h-3 shrink-0 text-stone-600 group-hover:text-sky-300 transition-colors" />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] uppercase tracking-[0.12em] text-stone-500">
            <span>Filed {filing.filingDate}</span>
            {filing.reportDate && <span>Period {filing.reportDate}</span>}
            <span className="font-mono">{filing.accession}</span>
          </div>
          {items.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {items.slice(0, 4).map((item) => (
                <span
                  key={`${filing.accession}-${item.code}`}
                  className="border border-sky-800/60 bg-sky-950/30 px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-sky-200"
                  title={`8-K Item ${item.code}`}
                >
                  {item.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </a>
  );
}

function isEventFiling(filing: FilingEntry) {
  return (
    filing.form.startsWith('8-K')
    || filing.form === '6-K'
    || filing.form.includes('DEF 14A')
    || filing.form.startsWith('S-')
    || filing.form.startsWith('SC 13')
  );
}

function filingBadgeClass(form: string) {
  if (form.startsWith('8-K')) return 'border-rose-700/50 bg-rose-900/30 text-rose-200';
  if (form === '6-K') return 'border-sky-700/50 bg-sky-900/30 text-sky-200';
  if (form.includes('DEF 14A') || form.includes('PRE 14A')) return 'border-violet-700/50 bg-violet-900/30 text-violet-200';
  if (form.startsWith('S-')) return 'border-sky-700/50 bg-sky-900/30 text-sky-200';
  if (form.startsWith('SC 13')) return 'border-fuchsia-700/50 bg-fuchsia-900/30 text-fuchsia-200';
  return 'border-stone-700 bg-stone-800/60 text-stone-300';
}

interface CoveragePanelProps {
  statementRows: any[];
  ratioRows: any[];
  periods: any[];
  filings: FilingEntry[];
  cik?: string;
}

interface CoverageRow {
  label: string;
  total: number;
  sourced: number;
  latestSourced: boolean;
}

function DataCoveragePanel({
  statementRows,
  ratioRows,
  periods,
  filings,
  cik,
}: CoveragePanelProps) {
  const coverage = useMemo(() => {
    const rows = [...statementRows, ...ratioRows]
      .filter((row) => row?.values?.some((point: MetricPoint) => point?.value != null));
    const cells = rows.flatMap((row) => row.values.filter((point: MetricPoint) => point?.value != null));
    const sourcedCells = cells.filter(hasPointSource);
    const latestCells = rows
      .map((row) => row.values?.[0])
      .filter((point: MetricPoint | undefined) => point?.value != null);
    const latestSourcedCells = latestCells.filter(hasPointSource);
    const rowCoverage: CoverageRow[] = rows
      .map((row) => {
        const dataPoints = row.values.filter((point: MetricPoint) => point?.value != null);
        const sourcedPoints = dataPoints.filter(hasPointSource);
        return {
          label: row.label,
          total: dataPoints.length,
          sourced: sourcedPoints.length,
          latestSourced: hasPointSource(row.values?.[0]),
        };
      })
      .filter((row) => row.total > 0);

    const weakRows = rowCoverage
      .filter((row) => row.sourced < row.total || !row.latestSourced)
      .sort((a, b) => (a.sourced / a.total) - (b.sourced / b.total))
      .slice(0, 5);

    return {
      rows,
      cells,
      sourcedCells,
      latestCells,
      latestSourcedCells,
      weakRows,
    };
  }, [statementRows, ratioRows]);

  if (!coverage.cells.length) return null;

  const latestPeriod = periods[0];
  const latestAnnualFiling = findLatestFiling(filings, ['10-K', '10-K/A']);
  const latestQuarterlyFiling = findLatestFiling(filings, ['10-Q', '10-Q/A']);
  const latestPct = pctText(coverage.latestSourcedCells.length, coverage.latestCells.length);
  const allPct = pctText(coverage.sourcedCells.length, coverage.cells.length);
  const companyFactsUrl = cik
    ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`
    : null;

  return (
    <div className="mb-6 border-2 border-stone-800 bg-stone-950/50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              SEC Data Coverage
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Auditability check for the annual company page data, sourced from SEC Company Facts.
          </p>
        </div>
        {companyFactsUrl && (
          <a
            href={companyFactsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 border border-stone-700 bg-stone-900 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.16em] text-stone-300 hover:border-emerald-500 hover:text-emerald-300 transition-colors"
          >
            Company Facts
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
        <CoverageStat
          label="Latest Values"
          value={latestPct}
          detail={`${coverage.latestSourcedCells.length} of ${coverage.latestCells.length} latest metrics link to SEC tags`}
          tone={coverage.latestSourcedCells.length === coverage.latestCells.length ? 'good' : 'warn'}
        />
        <CoverageStat
          label="Historical Values"
          value={allPct}
          detail={`${coverage.sourcedCells.length} of ${coverage.cells.length} reported table values are source-linked`}
          tone={coverage.sourcedCells.length === coverage.cells.length ? 'good' : 'warn'}
        />
        <FilingStat
          label="Latest 10-K"
          filing={latestAnnualFiling}
          fallback={latestPeriod ? `${periodLabel(latestPeriod)} filed ${latestPeriod.filed || 'N/A'}` : 'No annual period'}
        />
        <FilingStat
          label="Latest 10-Q"
          filing={latestQuarterlyFiling}
          fallback="No recent 10-Q in SEC submissions feed"
        />
      </div>

      {coverage.weakRows.length > 0 && (
        <div className="border-t border-stone-800 px-4 py-3">
          <div className="mb-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Coverage Watchlist
          </div>
          <div className="flex flex-wrap gap-2">
            {coverage.weakRows.map((row) => (
              <span
                key={row.label}
                title={`${row.sourced} of ${row.total} reported values have source links${row.latestSourced ? '' : '; latest value has no direct source link'}`}
                className="inline-flex items-center gap-1.5 border border-amber-800/60 bg-amber-950/20 px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] text-amber-200"
              >
                {row.label}
                <span className="text-stone-500 tabular-nums">{row.sourced}/{row.total}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CoverageStat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'good' | 'warn';
}) {
  const toneClass = tone === 'good' ? 'text-emerald-300 border-emerald-800/70' : 'text-amber-300 border-amber-800/70';
  return (
    <div className={`border-2 bg-stone-950/60 p-4 ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500 font-bold">{label}</div>
      <div className="mt-2 text-3xl font-black tabular-nums text-stone-100">{value}</div>
      <div className="mt-2 text-xs leading-relaxed text-stone-400">{detail}</div>
    </div>
  );
}

function FilingStat({
  label,
  filing,
  fallback,
}: {
  label: string;
  filing?: FilingEntry | null;
  fallback: string;
}) {
  return (
    <div className="border-2 border-stone-800 bg-stone-950/60 p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-stone-500 font-bold">
        <FileText className="w-3.5 h-3.5 text-stone-500" />
        {label}
      </div>
      {filing ? (
        <>
          <a
            href={filing.documentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-lg font-black tabular-nums text-stone-100 hover:text-amber-300 transition-colors"
          >
            {filing.form}
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <div className="mt-2 text-xs leading-relaxed text-stone-400">
            Filed {filing.filingDate}
            <span className="block font-mono text-[10px] text-stone-600">{filing.accession}</span>
          </div>
        </>
      ) : (
        <div className="mt-2 text-xs leading-relaxed text-stone-500">{fallback}</div>
      )}
    </div>
  );
}

function hasPointSource(point?: MetricPoint | null) {
  return Boolean(
    point?.source?.tag
      || point?.sources?.some((source) => source?.tag)
  );
}

function findLatestFiling(filings: FilingEntry[], forms: string[]) {
  return filings.find((filing) => forms.includes(filing.form)) || null;
}

function pctText(numerator: number, denominator: number) {
  if (!denominator) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

interface SnapshotSource {
  label: string;
  point: MetricPoint | null;
}

interface SnapshotTile {
  key: string;
  label: string;
  value: number;
  format: string;
  detail: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  sources: SnapshotSource[];
}

function QualitySnapshot({
  facts,
  periods,
  sicCode,
  cik,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
}) {
  const { tiles, latestPeriod, group } = useMemo(() => {
    const latestPeriod = periods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod) return { tiles: [] as SnapshotTile[], latestPeriod, group };

    const metric = (key: string, format = 'currency'): MetricPoint | null => {
      const row = buildMetricRow(facts, key, key, [latestPeriod], format, group as any);
      return row?.values?.[0] || null;
    };

    const points = {
      revenue: metric('revenue'),
      netIncome: metric('netIncome'),
      operatingCashFlow: metric('operatingCashFlow'),
      capex: metric('capex'),
      cash: metric('cash'),
      shortTermDebt: metric('shortTermDebt'),
      longTermDebt: metric('longTermDebt'),
      stockholdersEquity: metric('stockholdersEquity'),
      totalAssets: metric('totalAssets'),
      loans: metric('loans'),
      deposits: metric('deposits'),
      allowanceForLoanLoss: metric('allowanceForLoanLoss'),
      provisionForLoanLoss: metric('provisionForLoanLoss'),
      premiumsEarned: metric('premiumsEarned'),
      lossesIncurred: metric('lossesIncurred'),
      underwritingExpenses: metric('underwritingExpenses'),
      investmentIncome: metric('investmentIncome'),
      shortTermInvestments: metric('shortTermInvestments'),
    };

    const num = (point: MetricPoint | null) => (
      typeof point?.value === 'number' && Number.isFinite(point.value) ? point.value : null
    );
    const pct = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return (numerator / denominator) * 100;
    };
    const addTile = (
      list: SnapshotTile[],
      tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }
    ) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      list.push({ ...tile, sources });
    };

    const tiles: SnapshotTile[] = [];

    if (group === INDUSTRY_GROUPS.BANKING) {
      const equity = num(points.stockholdersEquity);
      const assets = num(points.totalAssets);
      const loans = num(points.loans);
      const deposits = num(points.deposits);
      const allowance = num(points.allowanceForLoanLoss);
      const provision = num(points.provisionForLoanLoss);
      const revenue = num(points.revenue);

      const equityAssets = pct(equity, assets);
      if (equityAssets != null) {
        addTile(tiles, {
          key: 'equity-assets',
          label: 'Equity / Assets',
          value: equityAssets,
          format: 'percent',
          detail: 'Capital cushion from reported equity and assets',
          tone: equityAssets >= 8 ? 'good' : equityAssets >= 5 ? 'warn' : 'bad',
          sources: [
            { label: 'Equity', point: points.stockholdersEquity },
            { label: 'Assets', point: points.totalAssets },
          ],
        });
      }

      const loanDeposit = pct(loans, deposits);
      if (loanDeposit != null) {
        addTile(tiles, {
          key: 'loan-deposit',
          label: 'Loans / Deposits',
          value: loanDeposit,
          format: 'percent',
          detail: 'Loan book funded by customer deposits',
          tone: loanDeposit <= 90 ? 'good' : loanDeposit <= 105 ? 'warn' : 'bad',
          sources: [
            { label: 'Loans', point: points.loans },
            { label: 'Deposits', point: points.deposits },
          ],
        });
      }

      const allowanceCoverage = pct(allowance, loans);
      if (allowanceCoverage != null) {
        addTile(tiles, {
          key: 'allowance-loans',
          label: 'Allowance / Loans',
          value: allowanceCoverage,
          format: 'percent',
          detail: 'Credit-loss allowance against reported loans',
          tone: 'neutral',
          sources: [
            { label: 'Allowance', point: points.allowanceForLoanLoss },
            { label: 'Loans', point: points.loans },
          ],
        });
      }

      const provisionBurden = pct(provision, revenue);
      if (provisionBurden != null) {
        addTile(tiles, {
          key: 'provision-revenue',
          label: 'Provision / Revenue',
          value: provisionBurden,
          format: 'percent',
          detail: 'Credit provision burden in the latest annual period',
          tone: provisionBurden <= 5 ? 'good' : provisionBurden <= 15 ? 'warn' : 'bad',
          sources: [
            { label: 'Provision', point: points.provisionForLoanLoss },
            { label: 'Revenue', point: points.revenue },
          ],
        });
      }
    } else if (group === INDUSTRY_GROUPS.INSURANCE) {
      const premiums = num(points.premiumsEarned);
      const losses = num(points.lossesIncurred);
      const expenses = num(points.underwritingExpenses);
      const investmentIncome = num(points.investmentIncome);
      const investments = num(points.shortTermInvestments) ?? num(points.totalAssets);
      const equity = num(points.stockholdersEquity);
      const assets = num(points.totalAssets);

      if (premiums != null && premiums !== 0 && (losses != null || expenses != null)) {
        const combinedRatio = (((losses || 0) + (expenses || 0)) / premiums) * 100;
        addTile(tiles, {
          key: 'combined-ratio',
          label: 'Combined Ratio',
          value: combinedRatio,
          format: 'percent',
          detail: 'Losses plus underwriting expenses / premiums earned',
          tone: combinedRatio < 95 ? 'good' : combinedRatio <= 100 ? 'warn' : 'bad',
          sources: [
            { label: 'Losses', point: points.lossesIncurred },
            { label: 'Expenses', point: points.underwritingExpenses },
            { label: 'Premiums', point: points.premiumsEarned },
          ],
        });
      }

      const investmentYield = pct(investmentIncome, investments);
      if (investmentYield != null) {
        addTile(tiles, {
          key: 'investment-yield',
          label: 'Investment Yield',
          value: investmentYield,
          format: 'percent',
          detail: 'Investment income over reported investments or assets',
          tone: investmentYield >= 3 ? 'good' : investmentYield >= 1 ? 'warn' : 'bad',
          sources: [
            { label: 'Income', point: points.investmentIncome },
            { label: 'Base', point: points.shortTermInvestments?.value != null ? points.shortTermInvestments : points.totalAssets },
          ],
        });
      }

      const equityAssets = pct(equity, assets);
      if (equityAssets != null) {
        addTile(tiles, {
          key: 'insurer-equity-assets',
          label: 'Equity / Assets',
          value: equityAssets,
          format: 'percent',
          detail: 'Balance-sheet cushion from equity and assets',
          tone: equityAssets >= 10 ? 'good' : equityAssets >= 6 ? 'warn' : 'bad',
          sources: [
            { label: 'Equity', point: points.stockholdersEquity },
            { label: 'Assets', point: points.totalAssets },
          ],
        });
      }
    } else {
      const revenue = num(points.revenue);
      const netIncome = num(points.netIncome);
      const ocf = num(points.operatingCashFlow);
      const capex = num(points.capex);
      const normalizedCapex = capex == null ? null : Math.abs(capex);
      const fcf = ocf != null && normalizedCapex != null ? ocf - normalizedCapex : null;
      const equity = num(points.stockholdersEquity);
      const cash = num(points.cash);
      const shortDebt = num(points.shortTermDebt);
      const longDebt = num(points.longTermDebt);
      const totalDebt = shortDebt != null || longDebt != null ? (shortDebt || 0) + (longDebt || 0) : null;

      const cfoConversion = netIncome != null && netIncome > 0 ? pct(ocf, netIncome) : null;
      if (cfoConversion != null) {
        addTile(tiles, {
          key: 'cfo-conversion',
          label: 'CFO Conversion',
          value: cfoConversion,
          format: 'percent',
          detail: 'Operating cash flow / net income',
          tone: cfoConversion >= 100 ? 'good' : cfoConversion >= 75 ? 'warn' : 'bad',
          sources: [
            { label: 'OCF', point: points.operatingCashFlow },
            { label: 'Net Income', point: points.netIncome },
          ],
        });
      }

      const fcfMargin = pct(fcf, revenue);
      if (fcfMargin != null) {
        addTile(tiles, {
          key: 'fcf-margin',
          label: 'FCF Margin',
          value: fcfMargin,
          format: 'percent',
          detail: `Free cash flow: ${formatValue(fcf, 'currency')}`,
          tone: fcfMargin >= 10 ? 'good' : fcfMargin >= 0 ? 'warn' : 'bad',
          sources: [
            { label: 'OCF', point: points.operatingCashFlow },
            { label: 'Capex', point: points.capex },
            { label: 'Revenue', point: points.revenue },
          ],
        });
      }

      const capexIntensity = pct(normalizedCapex, revenue);
      if (capexIntensity != null) {
        addTile(tiles, {
          key: 'capex-intensity',
          label: 'Capex Intensity',
          value: capexIntensity,
          format: 'percent',
          detail: 'Capital expenditures / revenue',
          tone: capexIntensity <= 8 ? 'good' : capexIntensity <= 18 ? 'warn' : 'neutral',
          sources: [
            { label: 'Capex', point: points.capex },
            { label: 'Revenue', point: points.revenue },
          ],
        });
      }

      const netDebt = totalDebt != null && cash != null ? totalDebt - cash : null;
      const netDebtEquity = pct(netDebt, equity);
      if (netDebt != null && netDebtEquity != null) {
        addTile(tiles, {
          key: 'net-debt-equity',
          label: 'Net Debt / Equity',
          value: netDebtEquity,
          format: 'percent',
          detail: `Net debt: ${formatValue(netDebt, 'currency')}`,
          tone: netDebt <= 0 ? 'good' : netDebtEquity <= 75 ? 'warn' : 'bad',
          sources: [
            { label: 'Cash', point: points.cash },
            { label: 'ST Debt', point: points.shortTermDebt },
            { label: 'LT Debt', point: points.longTermDebt },
            { label: 'Equity', point: points.stockholdersEquity },
          ],
        });
      }
    }

    return { tiles: tiles.slice(0, 4), latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Quality Snapshot
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Latest annual XBRL period: {latestPeriod ? periodLabel(latestPeriod) : 'Latest'} ({industryLabel(group)})
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          Source-linked inputs
        </div>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <QualityTile key={tile.key} tile={tile} cik={cik} />
        ))}
      </div>
    </div>
  );
}

function QualityTile({ tile, cik }: { tile: SnapshotTile; cik?: string }) {
  const toneClasses = {
    good: 'border-emerald-800/70 bg-emerald-950/10 text-emerald-300',
    warn: 'border-amber-800/70 bg-amber-950/10 text-amber-300',
    bad: 'border-rose-800/70 bg-rose-950/10 text-rose-300',
    neutral: 'border-sky-800/70 bg-sky-950/10 text-sky-300',
  }[tile.tone];

  return (
    <div className={`min-h-[168px] border-2 p-4 flex flex-col justify-between ${toneClasses}`}>
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-stone-400">
          {tile.label}
        </div>
        <div className="mt-2 text-2xl font-black tabular-nums text-stone-100">
          {formatValue(tile.value, tile.format)}
        </div>
        <div className="mt-2 text-xs leading-relaxed text-stone-400">
          {tile.detail}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {tile.sources.map((source) => (
          <SourceChip key={`${tile.key}-${source.label}`} source={source} cik={cik} />
        ))}
      </div>
    </div>
  );
}

function SourceChip({ source, cik }: { source: SnapshotSource; cik?: string }) {
  const sourceUrl = source.point?.source && cik ? buildSourceUrl(cik, source.point.source) : null;
  if (!sourceUrl || !source.point?.source) return null;

  const factSource = source.point.source;
  return (
    <a
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={`Tag: ${factSource.tag}\nUnit: ${factSource.unit}\nPeriod: ${factSource.end}\nFiled: ${factSource.filed}\nAccession: ${factSource.accession}`}
      className="inline-flex items-center gap-1 border border-stone-700 bg-stone-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-stone-300 hover:border-amber-500 hover:text-amber-300 transition-colors"
    >
      <LinkIcon className="w-3 h-3" />
      {source.label}
    </a>
  );
}

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
            const hasSource = row.values.some((v: any) => (v.source && v.source.tag) || v.sources?.some((source: any) => source.tag));
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
                  <ValueCell key={i} value={v.value} source={v.source} sources={v.sources} cik={cik} format={row.format} isHeader={header} />
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
  source?: { label?: string; tag: string; unit: string; end: string; filed: string; accession: string };
  sources?: { label?: string; tag: string; unit: string; end: string; filed: string; accession: string }[];
  cik?: string;
  format: string;
  isHeader: boolean;
}

function ValueCell({ value, source, sources, cik, format, isHeader }: ValueCellProps) {
  const sourceLinks = ((sources && sources.length > 0) ? sources : source ? [source] : [])
    .filter((item) => item?.tag);
  const linkedSources = sourceLinks
    .map((item) => ({ source: item, url: cik ? buildSourceUrl(cik, item) : null }))
    .filter((item) => item.url);
  const tooltip = sourceLinks.length > 0
    ? sourceLinks.map((item, index) => (
      `${item.label || `Source ${index + 1}`}\nTag: ${item.tag}\nUnit: ${item.unit}\nPeriod: ${item.end}\nFiled: ${item.filed}\nAccession: ${item.accession}`
    )).join('\n\n')
    : value == null ? 'No data reported for this concept' : 'Computed value';
  const cellClasses = `px-4 py-2.5 text-right tabular-nums group/cell ${
    value == null ? 'text-stone-700' : isHeader ? 'text-stone-100 font-bold' : 'text-stone-300'
  }`;
  if (!linkedSources.length || value == null) {
    return <td className={cellClasses} title={tooltip}>{formatValue(value, format)}</td>;
  }
  if (linkedSources.length === 1) {
    const only = linkedSources[0];
    return (
      <td className={cellClasses} title={`${tooltip}\nClick to open SEC source`}>
        <a href={only.url || '#'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-amber-400 transition-colors">
          {formatValue(value, format)}
          <ExternalLink className="w-3 h-3 opacity-0 group-hover/cell:opacity-50 transition-opacity" />
        </a>
      </td>
    );
  }
  return (
    <td className={cellClasses} title={tooltip}>
      <span className="inline-flex items-center justify-end gap-1.5">
        <span>{formatValue(value, format)}</span>
        <span className="inline-flex items-center gap-0.5 opacity-0 group-hover/cell:opacity-70 transition-opacity">
          {linkedSources.slice(0, 4).map(({ source: item, url }, index) => (
            <a
              key={`${item.tag}-${item.end}-${index}`}
              href={url || '#'}
              target="_blank"
              rel="noopener noreferrer"
              title={`${item.label || `Source ${index + 1}`}\nTag: ${item.tag}\nUnit: ${item.unit}\nPeriod: ${item.end}\nFiled: ${item.filed}\nAccession: ${item.accession}\nClick to open SEC source`}
              aria-label={`Open SEC source for ${item.label || `input ${index + 1}`}`}
              className="text-stone-500 hover:text-amber-400 transition-colors"
            >
              <LinkIcon className="w-3 h-3" />
            </a>
          ))}
        </span>
      </span>
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
