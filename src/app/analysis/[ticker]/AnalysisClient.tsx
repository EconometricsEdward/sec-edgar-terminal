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

const COMMON_SIZE_BASES = {
  income: { metricKey: 'revenue', label: 'Revenue', buttonLabel: '% of Revenue' },
  balance: { metricKey: 'totalAssets', label: 'Total Assets', buttonLabel: '% of Assets' },
  cashflow: { metricKey: 'revenue', label: 'Revenue', buttonLabel: '% of Revenue' },
} as const;

type StatementViewMode = 'reported' | 'commonSize';

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
  const [statementView, setStatementView] = useState<StatementViewMode>('reported');
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

  const commonSizeBasis = useMemo(() => {
    const basis = COMMON_SIZE_BASES[statement as keyof typeof COMMON_SIZE_BASES];
    if (!basis || !facts || periods.length === 0) return null;
    return {
      ...basis,
      row: buildMetricRow(facts, basis.metricKey, basis.label, periods, 'currency', sicCode as any),
    };
  }, [facts, periods, sicCode, statement]);

  const commonSizeRows = useMemo(
    () => (commonSizeBasis ? buildCommonSizeRows(rows, commonSizeBasis.row, commonSizeBasis.label) : []),
    [rows, commonSizeBasis]
  );

  const commonSizeAvailable = commonSizeRows.some((row: any) => (
    row.values.some((point: MetricPoint) => point.value != null && hasPointSource(point))
  ));
  const activeStatementView = statementView === 'commonSize' && commonSizeAvailable ? 'commonSize' : 'reported';
  const displayedRows = activeStatementView === 'commonSize' ? commonSizeRows : rows;

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
    if (!displayedRows.length) return [];
    return displayedRows.filter((r: { label: string }) => statementDef.featuredRows.includes(r.label));
  }, [displayedRows, statementDef]);

  const featuredRatioRows = useMemo(() => {
    if (!ratioRows.length) return [];
    return ratioRows
      .filter((r: { values: { value: number | null }[] }) => r.values.some((v) => v.value != null))
      .slice(0, 4);
  }, [ratioRows]);

  const growthVisible = showGrowth && periodType === 'annual';
  const statementGrowthVisible = growthVisible && activeStatementView === 'reported';

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
            quarterly momentum, expense discipline, profitability bridge, earnings quality, growth durability, per-share economics, payout coverage, capital efficiency, and insider trading activity.
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
                  <QuarterlyMomentumPanel
                    facts={facts}
                    periods={quarterlyPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
                  <SummaryDashboard facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} />
                  <AnalystChecklist facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} />
                  <QualitySnapshot facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} />
                  <ExpenseDisciplinePanel
                    facts={facts}
                    periods={annualPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
                  <ProfitabilityBridgePanel
                    facts={facts}
                    periods={annualPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
                  <EarningsQualityPanel
                    facts={facts}
                    periods={annualPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
                  <GrowthDurabilityPanel
                    facts={facts}
                    periods={annualPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
                  <PerShareEconomicsPanel
                    facts={facts}
                    periods={annualPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
                  <CapitalEfficiencyPanel
                    facts={facts}
                    periods={annualPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
                  <BalanceSheetRiskPanel
                    facts={facts}
                    periods={annualPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
                  <CashConversionPanel
                    facts={facts}
                    periods={annualPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
                  <CapitalAllocationPanel
                    facts={facts}
                    periods={annualPeriods}
                    sicCode={sicCode}
                    cik={company?.cik}
                    onTraceRow={traceRowHistory}
                  />
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

                  <button
                    onClick={() => setStatementView('reported')}
                    className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                      activeStatementView === 'reported' ? 'bg-stone-100 text-stone-950 border-stone-100' : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                    }`}
                    type="button"
                  >
                    Reported
                  </button>
                  <button
                    onClick={() => setStatementView('commonSize')}
                    disabled={!commonSizeAvailable}
                    title={commonSizeBasis ? `Divide statement rows by ${commonSizeBasis.label}` : 'Common-size view unavailable'}
                    className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      activeStatementView === 'commonSize' ? 'bg-sky-500 text-stone-950 border-sky-500' : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                    }`}
                    type="button"
                  >
                    {commonSizeBasis?.buttonLabel || 'Common Size'}
                  </button>

                  {periodType === 'annual' && activeStatementView === 'reported' && (
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
                    onClick={() => exportCsv(displayedRows, activeStatementView === 'commonSize' ? `${statement}_common_size` : statement)}
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
                rows={displayedRows}
                periods={periods}
                growthVisible={statementGrowthVisible}
                cik={company?.cik}
                onTraceRow={traceRowHistory}
                isHeaderRow={(label: string) => ['Revenue', 'Gross Profit', 'Operating Income', 'Net Income', 'Total Assets', 'Total Liabilities', "Stockholders' Equity", 'Operating Cash Flow'].includes(label)}
              />

              <p className="mt-4 text-[11px] text-stone-500 leading-relaxed">
                Source: SEC XBRL Company Facts. Hover any value for the source XBRL tag; click to open SEC's concept endpoint.
                {activeStatementView === 'commonSize' && commonSizeBasis ? (
                  <span> Common-size values divide each reported row by {commonSizeBasis.label}; computed cells link both inputs.</span>
                ) : null}{' '}
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
  period?: any;
  value: number | null;
  source?: SourceFact | null;
  sources?: SourceFact[];
}

function buildCommonSizeRows(rows: any[], basisRow: any, basisLabel: string) {
  const sourceWithLabel = (label: string, point?: MetricPoint | null) => {
    if (!point?.source?.tag) return null;
    return { ...point.source, label };
  };

  const uniqueSources = (sources: Array<(SourceFact & { label: string }) | null>) => {
    const seen = new Set<string>();
    return sources.filter((source) => {
      if (!source?.tag) return false;
      const key = `${source.tag}:${source.end}:${source.accession || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }) as Array<SourceFact & { label: string }>;
  };

  return rows.map((row) => ({
    ...row,
    format: 'percent',
    commonSizeBase: basisLabel,
    values: row.values.map((point: MetricPoint, index: number) => {
      const basisPoint = basisRow?.values?.[index] || null;
      const numerator = typeof point?.value === 'number' && Number.isFinite(point.value) ? point.value : null;
      const denominator = typeof basisPoint?.value === 'number' && Number.isFinite(basisPoint.value) ? basisPoint.value : null;
      const value = numerator != null && denominator != null && denominator !== 0
        ? (numerator / denominator) * 100
        : null;
      const sources = uniqueSources([
        sourceWithLabel(row.label, point),
        sourceWithLabel(`Base: ${basisLabel}`, basisPoint),
      ]);

      return {
        period: point?.period || basisPoint?.period,
        value,
        source: sources[0] || null,
        sources,
      };
    }),
  }));
}

interface CapitalAllocationPanelProps {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}

interface CapitalTile {
  key: string;
  label: string;
  value: number;
  format: string;
  detail: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  sources: SnapshotSource[];
}

function CapitalAllocationPanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: CapitalAllocationPanelProps) {
  const { tiles, tableRows, displayPeriods, latestPeriod } = useMemo(() => {
    const displayPeriods = periods.slice(0, 5);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as CapitalTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
      };
    }

    const metricRow = (key: string, label: string) => (
      buildMetricRow(facts, key, label, displayPeriods, 'currency', group as any)
    );

    const rowsByKey = {
      netIncome: metricRow('netIncome', 'Net Income'),
      operatingCashFlow: metricRow('operatingCashFlow', 'Operating Cash Flow'),
      capex: metricRow('capex', 'Capital Expenditures'),
      dividendsPaid: metricRow('dividendsPaid', 'Dividends Paid'),
      stockRepurchased: metricRow('stockRepurchased', 'Share Repurchases'),
      debtIssued: metricRow('debtIssued', 'Debt Issued'),
      debtRepaid: metricRow('debtRepaid', 'Debt Repaid'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const outflow = (item: MetricPoint | null) => {
      const value = num(item);
      return value == null ? null : Math.abs(value);
    };
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => sourceFact(label, item))
        .filter(Boolean) as Array<SourceFact & { label: string }>
    );
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );

    const valueForPeriod = (index: number) => {
      const ocfPoint = point('operatingCashFlow', index);
      const capexPoint = point('capex', index);
      const netIncomePoint = point('netIncome', index);
      const dividendPoint = point('dividendsPaid', index);
      const buybackPoint = point('stockRepurchased', index);
      const issuedPoint = point('debtIssued', index);
      const repaidPoint = point('debtRepaid', index);

      const ocf = num(ocfPoint);
      const capex = outflow(capexPoint);
      const netIncome = num(netIncomePoint);
      const dividends = outflow(dividendPoint);
      const buybacks = outflow(buybackPoint);
      const debtIssued = num(issuedPoint);
      const debtRepaid = outflow(repaidPoint);
      const fcf = ocf != null && capex != null ? ocf - capex : null;
      const cashReturned = dividends != null || buybacks != null ? (dividends || 0) + (buybacks || 0) : null;
      const netDebtIssued = debtIssued != null || debtRepaid != null ? (debtIssued || 0) - (debtRepaid || 0) : null;
      const payoutRatio = (outflowValue: number | null, incomeValue: number | null) => (
        outflowValue != null && incomeValue != null && incomeValue > 0
          ? (outflowValue / incomeValue) * 100
          : null
      );

      return {
        ocfPoint,
        capexPoint,
        netIncomePoint,
        dividendPoint,
        buybackPoint,
        issuedPoint,
        repaidPoint,
        ocf,
        capex,
        netIncome,
        dividends,
        buybacks,
        fcf,
        cashReturned,
        netDebtIssued,
        dividendNetIncome: payoutRatio(dividends, netIncome),
        dividendFcf: payoutRatio(dividends, fcf),
        buybacksFcf: payoutRatio(buybacks, fcf),
        cashReturnedNetIncome: payoutRatio(cashReturned, netIncome),
        cashReturnedFcf: payoutRatio(cashReturned, fcf),
      };
    };

    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => ({
      period: displayPeriods[index],
      value,
      source: sourceFacts(inputs)[0] || null,
      sources: sourceFacts(inputs),
    });

    const tableRows = [
      {
        key: 'netIncome',
        label: 'Net Income',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const p = point('netIncome', index);
          return { ...rowsByKey.netIncome.values[index], sources: sourceFacts([['Net Income', p]]) };
        }),
      },
      {
        key: 'operatingCashFlow',
        label: 'Operating Cash Flow',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const p = point('operatingCashFlow', index);
          return { ...rowsByKey.operatingCashFlow.values[index], sources: sourceFacts([['OCF', p]]) };
        }),
      },
      {
        key: 'capexOutflow',
        label: 'Capex Outflow',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.capex, [['Capex', v.capexPoint]]);
        }),
      },
      {
        key: 'freeCashFlow',
        label: 'Free Cash Flow',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcf, [
            ['OCF', v.ocfPoint],
            ['Capex', v.capexPoint],
          ]);
        }),
      },
      {
        key: 'cashReturned',
        label: 'Cash Returned',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cashReturned, [
            ['Buybacks', v.buybackPoint],
            ['Dividends', v.dividendPoint],
          ]);
        }),
      },
      {
        key: 'dividendsPaid',
        label: 'Dividends Paid',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.dividends, [['Dividends', v.dividendPoint]]);
        }),
      },
      {
        key: 'stockRepurchased',
        label: 'Share Repurchases',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.buybacks, [['Buybacks', v.buybackPoint]]);
        }),
      },
      {
        key: 'dividendNetIncome',
        label: 'Dividends / Net Income',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.dividendNetIncome, [
            ['Dividends', v.dividendPoint],
            ['Net Income', v.netIncomePoint],
          ]);
        }),
      },
      {
        key: 'dividendFcf',
        label: 'Dividends / FCF',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.dividendFcf, [
            ['Dividends', v.dividendPoint],
            ['OCF', v.ocfPoint],
            ['Capex', v.capexPoint],
          ]);
        }),
      },
      {
        key: 'buybacksFcf',
        label: 'Buybacks / FCF',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.buybacksFcf, [
            ['Buybacks', v.buybackPoint],
            ['OCF', v.ocfPoint],
            ['Capex', v.capexPoint],
          ]);
        }),
      },
      {
        key: 'cashReturnedNetIncome',
        label: 'Cash Returned / Net Income',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cashReturnedNetIncome, [
            ['Buybacks', v.buybackPoint],
            ['Dividends', v.dividendPoint],
            ['Net Income', v.netIncomePoint],
          ]);
        }),
      },
      {
        key: 'cashReturnedFcf',
        label: 'Cash Returned / FCF',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cashReturnedFcf, [
            ['Buybacks', v.buybackPoint],
            ['Dividends', v.dividendPoint],
            ['OCF', v.ocfPoint],
            ['Capex', v.capexPoint],
          ]);
        }),
      },
      {
        key: 'netDebtIssuance',
        label: 'Net Debt Issuance',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.netDebtIssued, [
            ['Debt Issued', v.issuedPoint],
            ['Debt Repaid', v.repaidPoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: CapitalTile[] = [];
    const addTile = (tile: CapitalTile) => {
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!Number.isFinite(tile.value) || sources.length === 0) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.fcf != null) {
      addTile({
        key: 'free-cash-flow',
        label: 'Free Cash Flow',
        value: latest.fcf,
        format: 'currency',
        detail: 'Operating cash flow less capital expenditures',
        tone: latest.fcf > 0 ? 'good' : 'bad',
        sources: snapshotSources([
          ['OCF', latest.ocfPoint],
          ['Capex', latest.capexPoint],
        ]),
      });
    }

    if (latest.ocf != null && latest.ocf > 0 && latest.capex != null) {
      const reinvestmentRate = (latest.capex / latest.ocf) * 100;
      addTile({
        key: 'reinvestment-rate',
        label: 'Reinvestment / CFO',
        value: reinvestmentRate,
        format: 'percent',
        detail: 'Capex outflow as a share of operating cash flow',
        tone: reinvestmentRate <= 35 ? 'good' : reinvestmentRate <= 75 ? 'warn' : 'neutral',
        sources: snapshotSources([
          ['Capex', latest.capexPoint],
          ['OCF', latest.ocfPoint],
        ]),
      });
    }

    if (latest.cashReturned != null && latest.fcf != null && latest.fcf > 0) {
      const returnedFcf = (latest.cashReturned / latest.fcf) * 100;
      addTile({
        key: 'cash-returned-fcf',
        label: 'Cash Returned / FCF',
        value: returnedFcf,
        format: 'percent',
        detail: `Cash returned: ${formatValue(latest.cashReturned, 'currency')}`,
        tone: returnedFcf <= 80 ? 'good' : returnedFcf <= 120 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Buybacks', latest.buybackPoint],
          ['Dividends', latest.dividendPoint],
          ['OCF', latest.ocfPoint],
          ['Capex', latest.capexPoint],
        ]),
      });
    }

    if (latest.dividendFcf != null) {
      addTile({
        key: 'dividend-fcf-coverage',
        label: 'Dividends / FCF',
        value: latest.dividendFcf,
        format: 'percent',
        detail: `Dividends paid: ${formatValue(latest.dividends, 'currency')}`,
        tone: latest.dividendFcf <= 60 ? 'good' : latest.dividendFcf <= 100 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Dividends', latest.dividendPoint],
          ['OCF', latest.ocfPoint],
          ['Capex', latest.capexPoint],
        ]),
      });
    }

    if (latest.dividendNetIncome != null) {
      addTile({
        key: 'dividend-net-income-coverage',
        label: 'Dividends / Net Income',
        value: latest.dividendNetIncome,
        format: 'percent',
        detail: 'Dividends paid divided by reported net income',
        tone: latest.dividendNetIncome <= 60 ? 'good' : latest.dividendNetIncome <= 100 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Dividends', latest.dividendPoint],
          ['Net Income', latest.netIncomePoint],
        ]),
      });
    }

    if (latest.cashReturnedNetIncome != null) {
      addTile({
        key: 'cash-returned-net-income',
        label: 'Cash Returned / Net Income',
        value: latest.cashReturnedNetIncome,
        format: 'percent',
        detail: 'Dividends plus buybacks divided by reported net income',
        tone: latest.cashReturnedNetIncome <= 80 ? 'good' : latest.cashReturnedNetIncome <= 120 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Buybacks', latest.buybackPoint],
          ['Dividends', latest.dividendPoint],
          ['Net Income', latest.netIncomePoint],
        ]),
      });
    }

    if (latest.netDebtIssued != null) {
      addTile({
        key: 'net-debt-issued',
        label: 'Net Debt Issuance',
        value: latest.netDebtIssued,
        format: 'currency',
        detail: 'Debt issued less debt repaid in the latest annual period',
        tone: latest.netDebtIssued <= 0 ? 'good' : 'warn',
        sources: snapshotSources([
          ['Debt Issued', latest.issuedPoint],
          ['Debt Repaid', latest.repaidPoint],
        ]),
      });
    }

    return { tiles, tableRows, displayPeriods, latestPeriod };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Capital Allocation
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Latest annual cash generation, reinvestment, payout coverage, shareholder returns, and debt flows.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {latestPeriod ? periodLabel(latestPeriod) : 'Annual'} inputs
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <CapitalTileCard key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Five-Year Cash Deployment & Payout Coverage
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Net Income', 'Free Cash Flow', 'Cash Returned', 'Dividends / FCF', 'Cash Returned / FCF'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Capex, dividends, repurchases, and debt repayments are shown as cash-flow magnitudes where SEC tags report payment concepts. Payout coverage rows compare those cash returns with reported net income and free cash flow; linked values open each source tag.
          </p>
        </div>
      )}
    </div>
  );
}

function CapitalTileCard({ tile, cik }: { tile: CapitalTile; cik?: string }) {
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

function BalanceSheetRiskPanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}) {
  const { tiles, tableRows, displayPeriods, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 5);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as SnapshotTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
        group,
      };
    }

    const metricRow = (key: string, label: string) => (
      buildMetricRow(facts, key, label, displayPeriods, 'currency', group as any)
    );
    const rowsByKey = {
      revenue: metricRow('revenue', 'Revenue'),
      cash: metricRow('cash', 'Cash & Equivalents'),
      currentAssets: metricRow('currentAssets', 'Current Assets'),
      currentLiabilities: metricRow('currentLiabilities', 'Current Liabilities'),
      shortTermDebt: metricRow('shortTermDebt', 'Short-term Debt'),
      longTermDebt: metricRow('longTermDebt', 'Long-term Debt'),
      totalAssets: metricRow('totalAssets', 'Total Assets'),
      totalLiabilities: metricRow('totalLiabilities', 'Total Liabilities'),
      stockholdersEquity: metricRow('stockholdersEquity', "Stockholders' Equity"),
      operatingCashFlow: metricRow('operatingCashFlow', 'Operating Cash Flow'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, item]) => sourceFact(label, item))
        .filter((source): source is SourceFact & { label: string } => {
          if (!source?.tag) return false;
          const key = `${source.label}:${source.tag}:${source.end}:${source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );
    const ratio = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return numerator / denominator;
    };
    const pct = (numerator: number | null, denominator: number | null) => {
      const value = ratio(numerator, denominator);
      return value == null ? null : value * 100;
    };
    const valueForPeriod = (index: number) => {
      const revenuePoint = point('revenue', index);
      const cashPoint = point('cash', index);
      const currentAssetsPoint = point('currentAssets', index);
      const currentLiabilitiesPoint = point('currentLiabilities', index);
      const shortDebtPoint = point('shortTermDebt', index);
      const longDebtPoint = point('longTermDebt', index);
      const totalAssetsPoint = point('totalAssets', index);
      const totalLiabilitiesPoint = point('totalLiabilities', index);
      const equityPoint = point('stockholdersEquity', index);
      const ocfPoint = point('operatingCashFlow', index);

      const revenue = num(revenuePoint);
      const cash = num(cashPoint);
      const currentAssets = num(currentAssetsPoint);
      const currentLiabilities = num(currentLiabilitiesPoint);
      const shortDebt = num(shortDebtPoint);
      const longDebt = num(longDebtPoint);
      const totalAssets = num(totalAssetsPoint);
      const totalLiabilities = num(totalLiabilitiesPoint);
      const equity = num(equityPoint);
      const ocf = num(ocfPoint);
      const totalDebt = shortDebt != null || longDebt != null ? (shortDebt || 0) + (longDebt || 0) : null;
      const netDebt = totalDebt != null && cash != null ? totalDebt - cash : null;
      const workingCapital = currentAssets != null && currentLiabilities != null
        ? currentAssets - currentLiabilities
        : null;

      return {
        revenuePoint,
        cashPoint,
        currentAssetsPoint,
        currentLiabilitiesPoint,
        shortDebtPoint,
        longDebtPoint,
        totalAssetsPoint,
        totalLiabilitiesPoint,
        equityPoint,
        ocfPoint,
        revenue,
        cash,
        currentAssets,
        currentLiabilities,
        totalDebt,
        netDebt,
        totalAssets,
        totalLiabilities,
        equity,
        ocf,
        workingCapital,
        currentRatio: ratio(currentAssets, currentLiabilities),
        cashCurrentLiabilities: pct(cash, currentLiabilities),
        workingCapitalRevenue: pct(workingCapital, revenue),
        liabilitiesAssets: pct(totalLiabilities, totalAssets),
        debtEquity: pct(totalDebt, equity),
        netDebtCfo: ratio(netDebt, ocf && ocf > 0 ? ocf : null),
      };
    };
    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => ({
      period: displayPeriods[index],
      value,
      source: sourceFacts(inputs)[0] || null,
      sources: sourceFacts(inputs),
    });

    const tableRows = [
      {
        key: 'currentRatio',
        label: 'Current Ratio',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.currentRatio, [
            ['Current Assets', v.currentAssetsPoint],
            ['Current Liabilities', v.currentLiabilitiesPoint],
          ]);
        }),
      },
      {
        key: 'workingCapital',
        label: 'Working Capital',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.workingCapital, [
            ['Current Assets', v.currentAssetsPoint],
            ['Current Liabilities', v.currentLiabilitiesPoint],
          ]);
        }),
      },
      {
        key: 'cashCoverage',
        label: 'Cash / Current Liabilities',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cashCurrentLiabilities, [
            ['Cash', v.cashPoint],
            ['Current Liabilities', v.currentLiabilitiesPoint],
          ]);
        }),
      },
      {
        key: 'netDebt',
        label: 'Net Debt',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.netDebt, [
            ['Short-term Debt', v.shortDebtPoint],
            ['Long-term Debt', v.longDebtPoint],
            ['Cash', v.cashPoint],
          ]);
        }),
      },
      {
        key: 'netDebtCfo',
        label: 'Net Debt / CFO',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.netDebtCfo, [
            ['Short-term Debt', v.shortDebtPoint],
            ['Long-term Debt', v.longDebtPoint],
            ['Cash', v.cashPoint],
            ['CFO', v.ocfPoint],
          ]);
        }),
      },
      {
        key: 'liabilitiesAssets',
        label: 'Liabilities / Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.liabilitiesAssets, [
            ['Liabilities', v.totalLiabilitiesPoint],
            ['Assets', v.totalAssetsPoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: SnapshotTile[] = [];
    const addTile = (tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.currentRatio != null) {
      addTile({
        key: 'current-ratio',
        label: 'Current Ratio',
        value: latest.currentRatio,
        format: 'decimal',
        detail: 'Current assets divided by current liabilities',
        tone: latest.currentRatio >= 1.5 ? 'good' : latest.currentRatio >= 1 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Current Assets', latest.currentAssetsPoint],
          ['Current Liabilities', latest.currentLiabilitiesPoint],
        ]),
      });
    }

    if (latest.cashCurrentLiabilities != null) {
      addTile({
        key: 'cash-current-liabilities',
        label: 'Cash / Current Liabilities',
        value: latest.cashCurrentLiabilities,
        format: 'percent',
        detail: 'Cash coverage of near-term reported obligations',
        tone: latest.cashCurrentLiabilities >= 50 ? 'good' : latest.cashCurrentLiabilities >= 20 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Cash', latest.cashPoint],
          ['Current Liabilities', latest.currentLiabilitiesPoint],
        ]),
      });
    }

    if (latest.netDebtCfo != null) {
      addTile({
        key: 'net-debt-cfo',
        label: 'Net Debt / CFO',
        value: latest.netDebtCfo,
        format: 'decimal',
        detail: `Net debt: ${formatValue(latest.netDebt, 'currency')}; CFO: ${formatValue(latest.ocf, 'currency')}`,
        tone: latest.netDebt != null && latest.netDebt <= 0 ? 'good' : latest.netDebtCfo <= 2 ? 'good' : latest.netDebtCfo <= 4 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Short-term Debt', latest.shortDebtPoint],
          ['Long-term Debt', latest.longDebtPoint],
          ['Cash', latest.cashPoint],
          ['CFO', latest.ocfPoint],
        ]),
      });
    }

    if (latest.workingCapitalRevenue != null) {
      addTile({
        key: 'working-capital-revenue',
        label: 'Working Capital / Revenue',
        value: latest.workingCapitalRevenue,
        format: 'percent',
        detail: `Working capital: ${formatValue(latest.workingCapital, 'currency')}`,
        tone: latest.workingCapitalRevenue >= 10 ? 'good' : latest.workingCapitalRevenue >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Current Assets', latest.currentAssetsPoint],
          ['Current Liabilities', latest.currentLiabilitiesPoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.liabilitiesAssets != null) {
      addTile({
        key: 'liabilities-assets',
        label: 'Liabilities / Assets',
        value: latest.liabilitiesAssets,
        format: 'percent',
        detail: 'Reported liabilities as a share of total assets',
        tone: latest.liabilitiesAssets <= 60 ? 'good' : latest.liabilitiesAssets <= 80 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Liabilities', latest.totalLiabilitiesPoint],
          ['Assets', latest.totalAssetsPoint],
        ]),
      });
    }

    return { tiles: tiles.slice(0, 4), tableRows, displayPeriods, latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Wallet className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Balance Sheet Risk
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked liquidity, leverage, and working-capital signals for {latestPeriod ? periodLabel(latestPeriod) : 'the latest annual period'}.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {industryLabel(group)}
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <QualityTile key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Five-Year Balance Sheet Watch
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Working Capital', 'Net Debt'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Derived ratios use reported SEC XBRL values. Click linked values to open the source filing/tag; use the history icon to inspect the underlying concept over time.
          </p>
        </div>
      )}
    </div>
  );
}

function CashConversionPanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}) {
  const { tiles, tableRows, displayPeriods, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 5);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as SnapshotTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
        group,
      };
    }

    const metricRow = (key: string, label: string) => (
      buildMetricRow(facts, key, label, displayPeriods, 'currency', group as any)
    );
    const rowsByKey = {
      revenue: metricRow('revenue', 'Revenue'),
      costOfRevenue: metricRow('costOfRevenue', 'Cost of Revenue'),
      receivables: metricRow('receivables', 'Accounts Receivable'),
      inventory: metricRow('inventory', 'Inventory'),
      accountsPayable: metricRow('accountsPayable', 'Accounts Payable'),
      operatingCashFlow: metricRow('operatingCashFlow', 'Operating Cash Flow'),
      netIncome: metricRow('netIncome', 'Net Income'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, item]) => sourceFact(label, item))
        .filter((source): source is SourceFact & { label: string } => {
          if (!source?.tag) return false;
          const key = `${source.label}:${source.tag}:${source.end}:${source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );
    const ratio = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return numerator / denominator;
    };
    const pct = (numerator: number | null, denominator: number | null) => {
      const value = ratio(numerator, denominator);
      return value == null ? null : value * 100;
    };
    const days = (balance: number | null, flow: number | null) => {
      const value = ratio(balance, flow);
      return value == null ? null : value * 365;
    };
    const valueForPeriod = (index: number) => {
      const revenuePoint = point('revenue', index);
      const costPoint = point('costOfRevenue', index);
      const receivablesPoint = point('receivables', index);
      const inventoryPoint = point('inventory', index);
      const payablePoint = point('accountsPayable', index);
      const ocfPoint = point('operatingCashFlow', index);
      const netIncomePoint = point('netIncome', index);

      const revenue = num(revenuePoint);
      const costOfRevenue = num(costPoint);
      const receivables = num(receivablesPoint);
      const inventory = num(inventoryPoint);
      const accountsPayable = num(payablePoint);
      const ocf = num(ocfPoint);
      const netIncome = num(netIncomePoint);
      const dso = days(receivables, revenue);
      const daysInventory = days(inventory, costOfRevenue);
      const dpo = days(accountsPayable, costOfRevenue);
      const cashConversionCycle = dso != null && (daysInventory != null || dpo != null)
        ? (dso || 0) + (daysInventory || 0) - (dpo || 0)
        : null;
      const tradeWorkingCapitalInputs = [receivables, inventory, accountsPayable].filter((value) => value != null).length;
      const tradeWorkingCapital = tradeWorkingCapitalInputs >= 2
        ? (receivables || 0) + (inventory || 0) - (accountsPayable || 0)
        : null;

      return {
        revenuePoint,
        costPoint,
        receivablesPoint,
        inventoryPoint,
        payablePoint,
        ocfPoint,
        netIncomePoint,
        revenue,
        ocf,
        netIncome,
        dso,
        daysInventory,
        dpo,
        cashConversionCycle,
        tradeWorkingCapital,
        tradeWorkingCapitalRevenue: pct(tradeWorkingCapital, revenue),
        cfoNetIncome: netIncome != null && netIncome > 0 ? pct(ocf, netIncome) : null,
      };
    };
    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => {
      const sources = sourceFacts(inputs);
      return {
        period: displayPeriods[index],
        value,
        source: sources[0] || null,
        sources,
      };
    };

    const tableRows = [
      {
        key: 'dso',
        label: 'Days Sales Outstanding',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.dso, [
            ['Receivables', v.receivablesPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'daysInventory',
        label: 'Days Inventory',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.daysInventory, [
            ['Inventory', v.inventoryPoint],
            ['Cost of Revenue', v.costPoint],
          ]);
        }),
      },
      {
        key: 'dpo',
        label: 'Days Payable Outstanding',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.dpo, [
            ['Accounts Payable', v.payablePoint],
            ['Cost of Revenue', v.costPoint],
          ]);
        }),
      },
      {
        key: 'cashConversionCycle',
        label: 'Cash Conversion Cycle',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cashConversionCycle, [
            ['Receivables', v.receivablesPoint],
            ['Inventory', v.inventoryPoint],
            ['Payables', v.payablePoint],
            ['Revenue', v.revenuePoint],
            ['Cost of Revenue', v.costPoint],
          ]);
        }),
      },
      {
        key: 'tradeWorkingCapital',
        label: 'Trade Working Capital',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.tradeWorkingCapital, [
            ['Receivables', v.receivablesPoint],
            ['Inventory', v.inventoryPoint],
            ['Payables', v.payablePoint],
          ]);
        }),
      },
      {
        key: 'tradeWorkingCapitalRevenue',
        label: 'Trade WC / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.tradeWorkingCapitalRevenue, [
            ['Receivables', v.receivablesPoint],
            ['Inventory', v.inventoryPoint],
            ['Payables', v.payablePoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'cfoNetIncome',
        label: 'CFO / Net Income',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cfoNetIncome, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Net Income', v.netIncomePoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: SnapshotTile[] = [];
    const addTile = (tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.cashConversionCycle != null) {
      addTile({
        key: 'cash-conversion-cycle',
        label: 'Cash Conversion Cycle',
        value: latest.cashConversionCycle,
        format: 'decimal',
        detail: 'DSO plus inventory days less payable days',
        tone: latest.cashConversionCycle <= 30 ? 'good' : latest.cashConversionCycle <= 90 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Receivables', latest.receivablesPoint],
          ['Inventory', latest.inventoryPoint],
          ['Payables', latest.payablePoint],
          ['Revenue', latest.revenuePoint],
          ['Cost of Revenue', latest.costPoint],
        ]),
      });
    }

    if (latest.dso != null) {
      addTile({
        key: 'dso',
        label: 'Days Sales Outstanding',
        value: latest.dso,
        format: 'decimal',
        detail: 'Receivables divided by annual revenue, expressed in days',
        tone: latest.dso <= 45 ? 'good' : latest.dso <= 75 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Receivables', latest.receivablesPoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.tradeWorkingCapitalRevenue != null) {
      addTile({
        key: 'trade-working-capital-revenue',
        label: 'Trade WC / Revenue',
        value: latest.tradeWorkingCapitalRevenue,
        format: 'percent',
        detail: `Trade working capital: ${formatValue(latest.tradeWorkingCapital, 'currency')}`,
        tone: latest.tradeWorkingCapitalRevenue <= 15 ? 'good' : latest.tradeWorkingCapitalRevenue <= 35 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Receivables', latest.receivablesPoint],
          ['Inventory', latest.inventoryPoint],
          ['Payables', latest.payablePoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.cfoNetIncome != null) {
      addTile({
        key: 'cfo-net-income',
        label: 'CFO / Net Income',
        value: latest.cfoNetIncome,
        format: 'percent',
        detail: 'Operating cash flow compared with reported net income',
        tone: latest.cfoNetIncome >= 100 ? 'good' : latest.cfoNetIncome >= 75 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Net Income', latest.netIncomePoint],
        ]),
      });
    }

    if (latest.daysInventory != null) {
      addTile({
        key: 'days-inventory',
        label: 'Days Inventory',
        value: latest.daysInventory,
        format: 'decimal',
        detail: 'Inventory divided by annual cost of revenue, expressed in days',
        tone: latest.daysInventory <= 60 ? 'good' : latest.daysInventory <= 120 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Inventory', latest.inventoryPoint],
          ['Cost of Revenue', latest.costPoint],
        ]),
      });
    }

    return { tiles: tiles.slice(0, 4), tableRows, displayPeriods, latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Cash Conversion
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked receivables, inventory, payables, and cash-flow conversion signals for {latestPeriod ? periodLabel(latestPeriod) : 'the latest annual period'}.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {industryLabel(group)}
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <QualityTile key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Five-Year Cash Conversion Watch
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Cash Conversion Cycle', 'Trade Working Capital'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Derived days metrics use annual SEC XBRL balance sheet amounts divided by annual flow amounts. Linked values open the reported source tags; use trend direction and company context rather than a single-year cutoff.
          </p>
        </div>
      )}
    </div>
  );
}

type ChecklistTone = 'good' | 'watch' | 'bad' | 'neutral';

interface ChecklistItem {
  key: string;
  label: string;
  value: string;
  question: string;
  detail: string;
  tone: ChecklistTone;
  sources: SnapshotSource[];
}

function AnalystChecklist({
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
  const { items, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 2);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length < 2) {
      return { items: [] as ChecklistItem[], latestPeriod, group };
    }

    const row = (key: string, label: string, format = 'currency') => (
      buildMetricRow(facts, key, label, displayPeriods, format, group as any)
    );
    const rowsByKey = {
      revenue: row('revenue', 'Revenue'),
      operatingIncome: row('operatingIncome', 'Operating Income'),
      netIncome: row('netIncome', 'Net Income'),
      operatingCashFlow: row('operatingCashFlow', 'Operating Cash Flow'),
      capex: row('capex', 'Capital Expenditures'),
      cash: row('cash', 'Cash & Equivalents'),
      shortTermDebt: row('shortTermDebt', 'Short-term Debt'),
      longTermDebt: row('longTermDebt', 'Long-term Debt'),
      stockholdersEquity: row('stockholdersEquity', "Stockholders' Equity"),
      totalAssets: row('totalAssets', 'Total Assets'),
      sharesDiluted: row('sharesDiluted', 'Diluted Shares', 'shares'),
      stockRepurchased: row('stockRepurchased', 'Share Repurchases'),
      dividendsPaid: row('dividendsPaid', 'Dividends Paid'),
      loans: row('loans', 'Loans'),
      deposits: row('deposits', 'Deposits'),
      allowanceForLoanLoss: row('allowanceForLoanLoss', 'Allowance for Credit Losses'),
      provisionForLoanLoss: row('provisionForLoanLoss', 'Provision for Credit Losses'),
      premiumsEarned: row('premiumsEarned', 'Premiums Earned'),
      lossesIncurred: row('lossesIncurred', 'Losses Incurred'),
      underwritingExpenses: row('underwritingExpenses', 'Underwriting Expenses'),
      investmentIncome: row('investmentIncome', 'Investment Income'),
      shortTermInvestments: row('shortTermInvestments', 'Investments'),
    };

    const point = (key: keyof typeof rowsByKey, index = 0): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const magnitude = (item: MetricPoint | null) => {
      const value = num(item);
      return value == null ? null : Math.abs(value);
    };
    const pct = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return (numerator / denominator) * 100;
    };
    const growth = (current: number | null, prior: number | null) => {
      if (current == null || prior == null || prior === 0) return null;
      return ((current - prior) / Math.abs(prior)) * 100;
    };
    const sources = (inputs: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return inputs
        .filter(([, item]) => item?.source?.tag)
        .map(([label, item]) => ({ label, point: item }))
        .filter((source) => {
          const key = `${source.label}:${source.point?.source?.tag}:${source.point?.source?.end}:${source.point?.source?.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }) as SnapshotSource[];
    };
    const addItem = (
      list: ChecklistItem[],
      item: Omit<ChecklistItem, 'sources'> & { sources: SnapshotSource[] }
    ) => {
      const linkedSources = item.sources.filter((source) => source.point?.source?.tag);
      if (!linkedSources.length) return;
      list.push({ ...item, sources: linkedSources });
    };

    const items: ChecklistItem[] = [];

    if (group === INDUSTRY_GROUPS.BANKING) {
      const equityAssets = pct(num(point('stockholdersEquity')), num(point('totalAssets')));
      if (equityAssets != null) {
        addItem(items, {
          key: 'bank-capital',
          label: 'Capital Cushion',
          value: formatValue(equityAssets, 'percent'),
          question: 'Is the balance sheet carrying enough equity against assets?',
          detail: 'Equity / assets from the latest annual XBRL period.',
          tone: equityAssets >= 8 ? 'good' : equityAssets >= 5 ? 'watch' : 'bad',
          sources: sources([
            ['Equity', point('stockholdersEquity')],
            ['Assets', point('totalAssets')],
          ]),
        });
      }

      const loanDeposit = pct(num(point('loans')), num(point('deposits')));
      if (loanDeposit != null) {
        addItem(items, {
          key: 'bank-funding',
          label: 'Funding Mix',
          value: formatValue(loanDeposit, 'percent'),
          question: 'How much of the loan book is funded by deposits?',
          detail: 'Loans / deposits helps frame funding intensity.',
          tone: loanDeposit <= 90 ? 'good' : loanDeposit <= 105 ? 'watch' : 'bad',
          sources: sources([
            ['Loans', point('loans')],
            ['Deposits', point('deposits')],
          ]),
        });
      }

      const provisionRevenue = pct(num(point('provisionForLoanLoss')), num(point('revenue')));
      if (provisionRevenue != null) {
        addItem(items, {
          key: 'bank-credit',
          label: 'Credit Cost Burden',
          value: formatValue(provisionRevenue, 'percent'),
          question: 'Are credit-loss provisions becoming material to revenue?',
          detail: 'Provision for credit losses / revenue in the latest annual period.',
          tone: provisionRevenue <= 5 ? 'good' : provisionRevenue <= 15 ? 'watch' : 'bad',
          sources: sources([
            ['Provision', point('provisionForLoanLoss')],
            ['Revenue', point('revenue')],
          ]),
        });
      }

      const roe = pct(num(point('netIncome')), num(point('stockholdersEquity')));
      if (roe != null) {
        addItem(items, {
          key: 'bank-profitability',
          label: 'Profitability',
          value: formatValue(roe, 'percent'),
          question: 'Is the bank earning enough on equity?',
          detail: 'Net income / stockholders equity from the latest annual XBRL period.',
          tone: roe >= 12 ? 'good' : roe >= 8 ? 'watch' : 'bad',
          sources: sources([
            ['Net Income', point('netIncome')],
            ['Equity', point('stockholdersEquity')],
          ]),
        });
      }

      const depositGrowth = growth(num(point('deposits')), num(point('deposits', 1)));
      if (depositGrowth != null) {
        addItem(items, {
          key: 'bank-deposit-growth',
          label: 'Deposit Trend',
          value: `${formatSignedPct(depositGrowth)} deposits`,
          question: 'Are deposits growing or leaving the balance sheet?',
          detail: 'Year-over-year change in reported deposits.',
          tone: depositGrowth >= 0 ? 'good' : depositGrowth >= -5 ? 'watch' : 'bad',
          sources: sources([
            ['Deposits', point('deposits')],
            ['Prior Deposits', point('deposits', 1)],
          ]),
        });
      }
    } else if (group === INDUSTRY_GROUPS.INSURANCE) {
      const premiums = num(point('premiumsEarned'));
      const losses = num(point('lossesIncurred'));
      const expenses = num(point('underwritingExpenses'));
      if (premiums != null && premiums !== 0 && (losses != null || expenses != null)) {
        const combined = (((losses || 0) + (expenses || 0)) / premiums) * 100;
        addItem(items, {
          key: 'insurance-underwriting',
          label: 'Underwriting Discipline',
          value: formatValue(combined, 'percent'),
          question: 'Is underwriting profitable before investment income?',
          detail: 'Combined ratio from losses, underwriting expenses, and premiums earned.',
          tone: combined < 95 ? 'good' : combined <= 100 ? 'watch' : 'bad',
          sources: sources([
            ['Losses', point('lossesIncurred')],
            ['Expenses', point('underwritingExpenses')],
            ['Premiums', point('premiumsEarned')],
          ]),
        });
      }

      const premiumGrowth = growth(num(point('premiumsEarned')), num(point('premiumsEarned', 1)));
      if (premiumGrowth != null) {
        addItem(items, {
          key: 'insurance-premium-growth',
          label: 'Premium Trend',
          value: `${formatSignedPct(premiumGrowth)} premiums`,
          question: 'Is the premium base expanding?',
          detail: 'Year-over-year change in premiums earned.',
          tone: premiumGrowth >= 5 ? 'good' : premiumGrowth >= 0 ? 'watch' : 'bad',
          sources: sources([
            ['Premiums', point('premiumsEarned')],
            ['Prior Premiums', point('premiumsEarned', 1)],
          ]),
        });
      }

      const investmentPoint = num(point('shortTermInvestments')) != null ? point('shortTermInvestments') : point('totalAssets');
      const investmentYield = pct(num(point('investmentIncome')), num(investmentPoint));
      if (investmentYield != null) {
        addItem(items, {
          key: 'insurance-investments',
          label: 'Investment Yield',
          value: formatValue(investmentYield, 'percent'),
          question: 'How much yield is the investment portfolio producing?',
          detail: 'Investment income over reported investments or assets.',
          tone: investmentYield >= 3 ? 'good' : investmentYield >= 1 ? 'watch' : 'bad',
          sources: sources([
            ['Investment Income', point('investmentIncome')],
            [investmentPoint === point('shortTermInvestments') ? 'Investments' : 'Assets', investmentPoint],
          ]),
        });
      }

      const equityAssets = pct(num(point('stockholdersEquity')), num(point('totalAssets')));
      if (equityAssets != null) {
        addItem(items, {
          key: 'insurance-capital',
          label: 'Capital Cushion',
          value: formatValue(equityAssets, 'percent'),
          question: 'How much equity supports the insurer balance sheet?',
          detail: 'Stockholders equity / total assets from the latest annual XBRL period.',
          tone: equityAssets >= 10 ? 'good' : equityAssets >= 6 ? 'watch' : 'bad',
          sources: sources([
            ['Equity', point('stockholdersEquity')],
            ['Assets', point('totalAssets')],
          ]),
        });
      }
    } else {
      const revenueGrowth = growth(num(point('revenue')), num(point('revenue', 1)));
      const opGrowth = growth(num(point('operatingIncome')), num(point('operatingIncome', 1)));
      const operatingMargin = pct(num(point('operatingIncome')), num(point('revenue')));
      if (revenueGrowth != null || opGrowth != null || operatingMargin != null) {
        addItem(items, {
          key: 'growth-quality',
          label: 'Growth Quality',
          value: `${formatSignedPct(revenueGrowth)} rev`,
          question: 'Is revenue growth converting into operating leverage?',
          detail: `Operating income growth: ${formatSignedPct(opGrowth)}; latest operating margin: ${formatPctValue(operatingMargin)}.`,
          tone: revenueGrowth != null && revenueGrowth > 0 && opGrowth != null && opGrowth >= revenueGrowth
            ? 'good'
            : revenueGrowth != null && revenueGrowth < 0
              ? 'bad'
              : 'watch',
          sources: sources([
            ['Revenue', point('revenue')],
            ['Prior Revenue', point('revenue', 1)],
            ['Operating Income', point('operatingIncome')],
            ['Prior Operating Income', point('operatingIncome', 1)],
          ]),
        });
      }

      const cfoConversion = num(point('netIncome')) != null && (num(point('netIncome')) || 0) > 0
        ? pct(num(point('operatingCashFlow')), num(point('netIncome')))
        : null;
      const fcf = num(point('operatingCashFlow')) != null && magnitude(point('capex')) != null
        ? (num(point('operatingCashFlow')) || 0) - (magnitude(point('capex')) || 0)
        : null;
      if (cfoConversion != null || fcf != null) {
        addItem(items, {
          key: 'cash-conversion',
          label: 'Cash Conversion',
          value: cfoConversion != null ? formatValue(cfoConversion, 'percent') : formatValue(fcf, 'currency'),
          question: 'Do reported earnings turn into cash?',
          detail: `Free cash flow in the latest annual period: ${formatValue(fcf, 'currency')}.`,
          tone: cfoConversion == null ? 'neutral' : cfoConversion >= 100 ? 'good' : cfoConversion >= 75 ? 'watch' : 'bad',
          sources: sources([
            ['Operating Cash Flow', point('operatingCashFlow')],
            ['Net Income', point('netIncome')],
            ['Capex', point('capex')],
          ]),
        });
      }

      const totalDebt = num(point('shortTermDebt')) != null || num(point('longTermDebt')) != null
        ? (num(point('shortTermDebt')) || 0) + (num(point('longTermDebt')) || 0)
        : null;
      const netDebt = totalDebt != null && num(point('cash')) != null ? totalDebt - (num(point('cash')) || 0) : null;
      const netDebtEquity = pct(netDebt, num(point('stockholdersEquity')));
      if (netDebt != null || netDebtEquity != null) {
        addItem(items, {
          key: 'balance-sheet',
          label: 'Balance Sheet Pressure',
          value: netDebtEquity != null ? formatValue(netDebtEquity, 'percent') : formatValue(netDebt, 'currency'),
          question: 'Is net debt manageable relative to equity?',
          detail: `Net debt: ${formatValue(netDebt, 'currency')}; debt less reported cash.`,
          tone: netDebt != null && netDebt <= 0 ? 'good' : netDebtEquity != null && netDebtEquity <= 75 ? 'watch' : 'bad',
          sources: sources([
            ['Cash', point('cash')],
            ['ST Debt', point('shortTermDebt')],
            ['LT Debt', point('longTermDebt')],
            ['Equity', point('stockholdersEquity')],
          ]),
        });
      }

      const shareGrowth = growth(num(point('sharesDiluted')), num(point('sharesDiluted', 1)));
      if (shareGrowth != null) {
        addItem(items, {
          key: 'dilution',
          label: 'Dilution Check',
          value: `${formatSignedPct(shareGrowth)} shares`,
          question: 'Are per-share economics being diluted?',
          detail: 'Year-over-year change in diluted weighted-average shares.',
          tone: shareGrowth <= 0 ? 'good' : shareGrowth <= 2 ? 'watch' : 'bad',
          sources: sources([
            ['Diluted Shares', point('sharesDiluted')],
            ['Prior Diluted Shares', point('sharesDiluted', 1)],
          ]),
        });
      }

      const cashReturned = magnitude(point('stockRepurchased')) != null || magnitude(point('dividendsPaid')) != null
        ? (magnitude(point('stockRepurchased')) || 0) + (magnitude(point('dividendsPaid')) || 0)
        : null;
      const returnFcf = fcf != null && fcf > 0 ? pct(cashReturned, fcf) : null;
      if (returnFcf != null) {
        addItem(items, {
          key: 'capital-return',
          label: 'Capital Return',
          value: formatValue(returnFcf, 'percent'),
          question: 'Are buybacks and dividends covered by free cash flow?',
          detail: `Cash returned: ${formatValue(cashReturned, 'currency')}.`,
          tone: returnFcf <= 80 ? 'good' : returnFcf <= 120 ? 'watch' : 'bad',
          sources: sources([
            ['Buybacks', point('stockRepurchased')],
            ['Dividends', point('dividendsPaid')],
            ['Operating Cash Flow', point('operatingCashFlow')],
            ['Capex', point('capex')],
          ]),
        });
      }
    }

    return { items: items.slice(0, 5), latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!items.length) return null;

  const toneCounts = items.reduce((counts, item) => {
    counts[item.tone] = (counts[item.tone] || 0) + 1;
    return counts;
  }, {} as Record<ChecklistTone, number>);

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Analyst Checklist
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked diligence prompts for {latestPeriod ? periodLabel(latestPeriod) : 'the latest annual period'} ({industryLabel(group)}).
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.14em]">
          {toneCounts.good ? <span className="border border-emerald-800/70 bg-emerald-950/20 px-2 py-1 text-emerald-300">{toneCounts.good} steady</span> : null}
          {toneCounts.watch ? <span className="border border-amber-800/70 bg-amber-950/20 px-2 py-1 text-amber-300">{toneCounts.watch} watch</span> : null}
          {toneCounts.bad ? <span className="border border-rose-800/70 bg-rose-950/20 px-2 py-1 text-rose-300">{toneCounts.bad} stress</span> : null}
        </div>
      </div>

      <div className="divide-y divide-stone-800/70">
        {items.map((item) => (
          <ChecklistRow key={item.key} item={item} cik={cik} />
        ))}
      </div>
    </div>
  );
}

function ChecklistRow({ item, cik }: { item: ChecklistItem; cik?: string }) {
  const toneClass = {
    good: 'border-emerald-800/70 bg-emerald-950/10 text-emerald-300',
    watch: 'border-amber-800/70 bg-amber-950/10 text-amber-300',
    bad: 'border-rose-800/70 bg-rose-950/10 text-rose-300',
    neutral: 'border-sky-800/70 bg-sky-950/10 text-sky-300',
  }[item.tone];
  const label = {
    good: 'Steady',
    watch: 'Watch',
    bad: 'Stress',
    neutral: 'Context',
  }[item.tone];

  return (
    <div className="grid gap-3 p-4 lg:grid-cols-[180px_1fr]">
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-stone-500">
          {item.label}
        </div>
        <div className="mt-1 text-lg font-black tabular-nums text-stone-100">
          {item.value}
        </div>
        <span className={`mt-2 inline-flex border px-2 py-1 text-[10px] uppercase tracking-[0.14em] font-bold ${toneClass}`}>
          {label}
        </span>
      </div>
      <div>
        <div className="text-sm font-bold text-stone-100">
          {item.question}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-stone-400">
          {item.detail}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {item.sources.map((source) => (
            <SourceChip key={`${item.key}-${source.label}`} source={source} cik={cik} />
          ))}
        </div>
      </div>
    </div>
  );
}

function formatSignedPct(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function formatPctValue(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return formatValue(value, 'percent');
}

type EventSignalTone = 'critical' | 'watch' | 'routine';

interface FilingItemInfo {
  code: string;
  label: string;
}

interface EventSignal {
  tone: EventSignalTone;
  label: string;
  priority: number;
}

interface EventWithSignal {
  filing: FilingEntry;
  items: FilingItemInfo[];
  signal: EventSignal;
}

interface EventItemSummary {
  code: string;
  label: string;
  count: number;
  latestFiling: FilingEntry;
  tone: EventSignalTone;
  priority: number;
}

const HIGH_SIGNAL_8K_ITEMS = new Set([
  '1.03', // bankruptcy or receivership
  '1.05', // cybersecurity incident
  '2.04', // accelerated/direct financial obligation
  '2.05', // exit or disposal costs
  '2.06', // material impairment
  '3.01', // listing/delisting notice
  '4.01', // change of accountant
  '4.02', // non-reliance on prior financials
  '5.01', // change of control
]);

const WATCH_8K_ITEMS = new Set([
  '1.01', // material agreement
  '1.02', // termination of agreement
  '2.01', // acquisition/disposition
  '2.02', // earnings release
  '2.03', // off-balance sheet arrangement
  '3.02', // unregistered sale
  '3.03', // modified shareholder rights
  '5.02', // executive change
  '5.03', // bylaws/charter change
  '5.07', // shareholder vote
  '7.01', // Regulation FD
  '8.01', // other events
]);

function filingDateTime(filing: FilingEntry) {
  const time = new Date(filing.filingDate).getTime();
  return Number.isFinite(time) ? time : 0;
}

function itemTone(item: FilingItemInfo): EventSignalTone {
  if (HIGH_SIGNAL_8K_ITEMS.has(item.code)) return 'critical';
  if (WATCH_8K_ITEMS.has(item.code)) return 'watch';
  return 'routine';
}

function itemPriority(item: FilingItemInfo) {
  const tone = itemTone(item);
  if (tone === 'critical') return 3;
  if (tone === 'watch') return 2;
  return 1;
}

function classifyEventItems(items: FilingItemInfo[]): EventSignal {
  if (!items.length) return { tone: 'routine', label: 'No item code', priority: 1 };
  const sorted = [...items].sort((a, b) => itemPriority(b) - itemPriority(a));
  const top = sorted[0];
  const tone = itemTone(top);
  return {
    tone,
    label: top.label,
    priority: itemPriority(top),
  };
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
    const eventCutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const itemEvents: EventWithSignal[] = filings
      .filter((filing) => filing.form.startsWith('8-K'))
      .map((filing) => {
        const items = getItemsInfo(filing.items || '') as FilingItemInfo[];
        return { filing, items, signal: classifyEventItems(items) };
      })
      .filter((event) => event.items.length > 0);
    const recentItemEvents = itemEvents.filter((event) => filingDateTime(event.filing) >= eventCutoff);
    const highSignalEvents = recentItemEvents
      .filter((event) => event.signal.tone === 'critical')
      .slice(0, 4);
    const watchEvents = recentItemEvents
      .filter((event) => event.signal.tone === 'watch')
      .slice(0, 4);
    const itemMap = new Map<string, EventItemSummary>();
    for (const event of recentItemEvents) {
      for (const item of event.items) {
        const existing = itemMap.get(item.code);
        const priority = itemPriority(item);
        const tone = itemTone(item);
        if (!existing) {
          itemMap.set(item.code, {
            code: item.code,
            label: item.label,
            count: 1,
            latestFiling: event.filing,
            priority,
            tone,
          });
          continue;
        }
        existing.count += 1;
        existing.priority = Math.max(existing.priority, priority);
        if (filingDateTime(event.filing) > filingDateTime(existing.latestFiling)) {
          existing.latestFiling = event.filing;
        }
      }
    }
    const eventItemSummary = Array.from(itemMap.values())
      .sort((a, b) => (
        b.priority - a.priority
        || b.count - a.count
        || filingDateTime(b.latestFiling) - filingDateTime(a.latestFiling)
      ))
      .slice(0, 8);
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
      itemEvents,
      recentItemEvents,
      highSignalEvents,
      watchEvents,
      eventItemSummary,
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

      {activity.itemEvents.length > 0 && (
        <MaterialEventRadar
          recentItemEvents={activity.recentItemEvents}
          highSignalEvents={activity.highSignalEvents}
          watchEvents={activity.watchEvents}
          eventItemSummary={activity.eventItemSummary}
        />
      )}

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

function MaterialEventRadar({
  recentItemEvents,
  highSignalEvents,
  watchEvents,
  eventItemSummary,
}: {
  recentItemEvents: EventWithSignal[];
  highSignalEvents: EventWithSignal[];
  watchEvents: EventWithSignal[];
  eventItemSummary: EventItemSummary[];
}) {
  const displayedEvents = highSignalEvents.length > 0 ? highSignalEvents : watchEvents;
  const latestSignal = displayedEvents[0] || recentItemEvents[0] || null;
  const highSignalCount = highSignalEvents.length;

  return (
    <div className="border-t border-stone-800 px-4 py-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Material Event Radar
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            8-K item-code triage from recent SEC submissions. Every signal links to the source filing.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">
          Last 180 days
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <EventRadarStat
          label="High-Signal 8-Ks"
          value={`${highSignalCount}`}
          detail="Cyber, impairment, delisting, accounting, bankruptcy, obligation, or control items"
          tone={highSignalCount > 0 ? 'critical' : 'routine'}
        />
        <EventRadarStat
          label="Item-Coded 8-Ks"
          value={`${recentItemEvents.length}`}
          detail={`${eventItemSummary.length} distinct item types detected in recent filings`}
          tone={recentItemEvents.length > 6 ? 'watch' : 'routine'}
        />
        <LatestEventStat event={latestSignal} />
      </div>

      {eventItemSummary.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {eventItemSummary.map((item) => (
            <a
              key={item.code}
              href={item.latestFiling.documentUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open latest ${item.label} filing from ${item.latestFiling.filingDate}`}
              className={`inline-flex items-center gap-1.5 border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] transition-colors ${eventToneChipClass(item.tone)}`}
            >
              Item {item.code}
              <span className="text-stone-400">{item.count}x</span>
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>
          ))}
        </div>
      )}

      {displayedEvents.length > 0 && (
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {displayedEvents.map((event) => (
            <MaterialEventRow key={event.filing.accession} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRadarStat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: EventSignalTone;
}) {
  const toneClass = {
    critical: 'border-rose-800/70 text-rose-300',
    watch: 'border-amber-800/70 text-amber-300',
    routine: 'border-stone-800 text-stone-300',
  }[tone];

  return (
    <div className={`border-2 bg-stone-950/60 p-4 ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500 font-bold">{label}</div>
      <div className="mt-2 text-3xl font-black tabular-nums text-stone-100">{value}</div>
      <div className="mt-2 text-xs leading-relaxed text-stone-400">{detail}</div>
    </div>
  );
}

function LatestEventStat({ event }: { event: EventWithSignal | null }) {
  if (!event) {
    return (
      <EventRadarStat
        label="Latest Signal"
        value="N/A"
        detail="No item-coded 8-Ks in the recent SEC submissions feed"
        tone="routine"
      />
    );
  }

  return (
    <div className={`border-2 bg-stone-950/60 p-4 ${eventToneBorderClass(event.signal.tone)}`}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500 font-bold">Latest Signal</div>
      <a
        href={event.filing.documentUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 text-lg font-black text-stone-100 hover:text-amber-300 transition-colors"
      >
        {event.signal.label}
        <ExternalLink className="w-3.5 h-3.5" />
      </a>
      <div className="mt-2 text-xs leading-relaxed text-stone-400">
        {event.filing.form} filed {event.filing.filingDate}
        <span className="block font-mono text-[10px] text-stone-600">{event.filing.accession}</span>
      </div>
    </div>
  );
}

function MaterialEventRow({ event }: { event: EventWithSignal }) {
  return (
    <a
      href={event.filing.documentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`group block border px-3 py-3 transition-colors ${eventRowClass(event.signal.tone)}`}
    >
      <div className="flex items-start gap-3">
        <span className={`shrink-0 border px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em] ${eventToneBadgeClass(event.signal.tone)}`}>
          {event.signal.tone === 'critical' ? 'Signal' : 'Watch'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-bold text-stone-100">
            <span className="truncate">{event.signal.label}</span>
            <ExternalLink className="w-3 h-3 shrink-0 text-stone-600 group-hover:text-amber-300 transition-colors" />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] uppercase tracking-[0.12em] text-stone-500">
            <span>{event.filing.form}</span>
            <span>Filed {event.filing.filingDate}</span>
            <span className="font-mono">{event.filing.accession}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {event.items.slice(0, 4).map((item) => (
              <span
                key={`${event.filing.accession}-${item.code}`}
                className={`border px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] ${eventToneChipClass(itemTone(item))}`}
                title={`8-K Item ${item.code}`}
              >
                {item.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </a>
  );
}

function eventToneBorderClass(tone: EventSignalTone) {
  if (tone === 'critical') return 'border-rose-800/70 text-rose-300';
  if (tone === 'watch') return 'border-amber-800/70 text-amber-300';
  return 'border-stone-800 text-stone-300';
}

function eventToneBadgeClass(tone: EventSignalTone) {
  if (tone === 'critical') return 'border-rose-700/60 bg-rose-950/40 text-rose-200';
  if (tone === 'watch') return 'border-amber-700/60 bg-amber-950/30 text-amber-200';
  return 'border-stone-700 bg-stone-900 text-stone-300';
}

function eventToneChipClass(tone: EventSignalTone) {
  if (tone === 'critical') return 'border-rose-800/70 bg-rose-950/30 text-rose-200 hover:border-rose-500';
  if (tone === 'watch') return 'border-amber-800/70 bg-amber-950/20 text-amber-200 hover:border-amber-500';
  return 'border-stone-700 bg-stone-950/70 text-stone-300 hover:border-stone-500';
}

function eventRowClass(tone: EventSignalTone) {
  if (tone === 'critical') return 'border-rose-900/70 bg-rose-950/10 hover:border-rose-600/80 hover:bg-rose-950/20';
  if (tone === 'watch') return 'border-amber-900/60 bg-amber-950/10 hover:border-amber-600/80 hover:bg-amber-950/20';
  return 'border-stone-800 bg-stone-900/30 hover:border-sky-700/70 hover:bg-sky-950/10';
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

function QuarterlyMomentumPanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}) {
  const { tiles, tableRows, displayPeriods, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 6);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as SnapshotTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
        group,
      };
    }

    const metricRow = (key: string, label: string) => (
      buildMetricRow(facts, key, label, displayPeriods, 'currency', group as any)
    );

    const rowsByKey = {
      revenue: metricRow('revenue', 'Revenue'),
      grossProfit: metricRow('grossProfit', 'Gross Profit'),
      operatingIncome: metricRow('operatingIncome', 'Operating Income'),
      netIncome: metricRow('netIncome', 'Net Income'),
      operatingCashFlow: metricRow('operatingCashFlow', 'Operating Cash Flow'),
      capex: metricRow('capex', 'Capital Expenditures'),
      cash: metricRow('cash', 'Cash & Equivalents'),
      shortTermDebt: metricRow('shortTermDebt', 'Short-term Debt'),
      currentLiabilities: metricRow('currentLiabilities', 'Current Liabilities'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      index >= 0 ? rowsByKey[key]?.values?.[index] || null : null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const magnitude = (item: MetricPoint | null) => {
      const value = num(item);
      return value == null ? null : Math.abs(value);
    };
    const pct = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return (numerator / denominator) * 100;
    };
    const growth = (current: number | null, prior: number | null) => {
      if (current == null || prior == null || prior === 0) return null;
      return ((current - prior) / Math.abs(prior)) * 100;
    };
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, item]) => sourceFact(label, item))
        .filter((source): source is SourceFact & { label: string } => {
          if (!source?.tag) return false;
          const key = `${source.label}:${source.tag}:${source.end}:${source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );
    const quarterNumber = (period: any) => {
      const match = String(period?.fp || '').match(/Q(\d)/);
      return match ? Number(match[1]) : null;
    };
    const previousSequentialIndex = (index: number) => {
      const current = displayPeriods[index];
      const prior = displayPeriods[index + 1];
      const currentQuarter = quarterNumber(current);
      const priorQuarter = quarterNumber(prior);
      if (!current || !prior || currentQuarter == null || priorQuarter == null) return -1;
      if (current.fy === prior.fy && priorQuarter === currentQuarter - 1) return index + 1;
      return -1;
    };
    const sameQuarterPriorYearIndex = (index: number) => {
      const current = displayPeriods[index];
      if (!current) return -1;
      return displayPeriods.findIndex((period, candidateIndex) => (
        candidateIndex > index
          && period?.fp === current.fp
          && Number(period?.fy) === Number(current.fy) - 1
      ));
    };

    const valueForPeriod = (index: number) => {
      const sequentialIndex = previousSequentialIndex(index);
      const priorYearIndex = sameQuarterPriorYearIndex(index);
      const revenuePoint = point('revenue', index);
      const grossProfitPoint = point('grossProfit', index);
      const operatingIncomePoint = point('operatingIncome', index);
      const netIncomePoint = point('netIncome', index);
      const ocfPoint = point('operatingCashFlow', index);
      const capexPoint = point('capex', index);
      const cashPoint = point('cash', index);
      const shortTermDebtPoint = point('shortTermDebt', index);
      const currentLiabilitiesPoint = point('currentLiabilities', index);

      const sequentialRevenuePoint = point('revenue', sequentialIndex);
      const priorYearRevenuePoint = point('revenue', priorYearIndex);
      const priorYearGrossProfitPoint = point('grossProfit', priorYearIndex);
      const priorYearOperatingIncomePoint = point('operatingIncome', priorYearIndex);
      const priorYearNetIncomePoint = point('netIncome', priorYearIndex);
      const priorYearOcfPoint = point('operatingCashFlow', priorYearIndex);
      const priorYearCapexPoint = point('capex', priorYearIndex);

      const revenue = num(revenuePoint);
      const grossProfit = num(grossProfitPoint);
      const operatingIncome = num(operatingIncomePoint);
      const netIncome = num(netIncomePoint);
      const ocf = num(ocfPoint);
      const capex = magnitude(capexPoint);
      const cash = num(cashPoint);
      const shortTermDebt = magnitude(shortTermDebtPoint);
      const currentLiabilities = magnitude(currentLiabilitiesPoint);
      const sequentialRevenue = num(sequentialRevenuePoint);
      const priorYearRevenue = num(priorYearRevenuePoint);
      const priorYearGrossProfit = num(priorYearGrossProfitPoint);
      const priorYearOperatingIncome = num(priorYearOperatingIncomePoint);
      const priorYearNetIncome = num(priorYearNetIncomePoint);
      const priorYearOcf = num(priorYearOcfPoint);
      const priorYearCapex = magnitude(priorYearCapexPoint);
      const fcf = ocf != null && capex != null ? ocf - capex : null;
      const priorYearFcf = priorYearOcf != null && priorYearCapex != null ? priorYearOcf - priorYearCapex : null;

      return {
        sequentialIndex,
        priorYearIndex,
        revenuePoint,
        grossProfitPoint,
        operatingIncomePoint,
        netIncomePoint,
        ocfPoint,
        capexPoint,
        cashPoint,
        shortTermDebtPoint,
        currentLiabilitiesPoint,
        sequentialRevenuePoint,
        priorYearRevenuePoint,
        priorYearGrossProfitPoint,
        priorYearOperatingIncomePoint,
        priorYearNetIncomePoint,
        priorYearOcfPoint,
        priorYearCapexPoint,
        revenue,
        grossProfit,
        operatingIncome,
        netIncome,
        ocf,
        capex,
        cash,
        shortTermDebt,
        currentLiabilities,
        sequentialRevenue,
        priorYearRevenue,
        priorYearGrossProfit,
        priorYearOperatingIncome,
        priorYearNetIncome,
        fcf,
        priorYearFcf,
        revenueSequentialGrowth: growth(revenue, sequentialRevenue),
        revenueYoYGrowth: growth(revenue, priorYearRevenue),
        grossProfitYoYGrowth: growth(grossProfit, priorYearGrossProfit),
        operatingIncomeYoYGrowth: growth(operatingIncome, priorYearOperatingIncome),
        netIncomeYoYGrowth: growth(netIncome, priorYearNetIncome),
        fcfYoYGrowth: growth(fcf, priorYearFcf),
        cashCurrentLiabilities: pct(cash, currentLiabilities),
        shortTermDebtCash: pct(shortTermDebt, cash),
      };
    };

    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => {
      const sources = sourceFacts(inputs);
      return {
        period: displayPeriods[index],
        value,
        source: sources[0] || null,
        sources,
      };
    };

    const tableRows = [
      {
        key: 'revenue',
        label: 'Revenue',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const revenuePoint = point('revenue', index);
          return {
            ...rowsByKey.revenue.values[index],
            sources: sourceFacts([['Revenue', revenuePoint]]),
          };
        }),
      },
      {
        key: 'revenueSequentialGrowth',
        label: 'Revenue Sequential Change',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.revenueSequentialGrowth, [
            ['Revenue', v.revenuePoint],
            ['Prior Sequential Revenue', v.sequentialRevenuePoint],
          ]);
        }),
      },
      {
        key: 'revenueYoYGrowth',
        label: 'Revenue YoY Change',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.revenueYoYGrowth, [
            ['Revenue', v.revenuePoint],
            ['Prior-Year Revenue', v.priorYearRevenuePoint],
          ]);
        }),
      },
      {
        key: 'grossProfitYoYGrowth',
        label: 'Gross Profit YoY Change',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.grossProfitYoYGrowth, [
            ['Gross Profit', v.grossProfitPoint],
            ['Prior-Year Gross Profit', v.priorYearGrossProfitPoint],
          ]);
        }),
      },
      {
        key: 'operatingIncomeYoYGrowth',
        label: 'Operating Income YoY Change',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.operatingIncomeYoYGrowth, [
            ['Operating Income', v.operatingIncomePoint],
            ['Prior-Year Operating Income', v.priorYearOperatingIncomePoint],
          ]);
        }),
      },
      {
        key: 'netIncomeYoYGrowth',
        label: 'Net Income YoY Change',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.netIncomeYoYGrowth, [
            ['Net Income', v.netIncomePoint],
            ['Prior-Year Net Income', v.priorYearNetIncomePoint],
          ]);
        }),
      },
      {
        key: 'freeCashFlow',
        label: 'Free Cash Flow',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcf, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
          ]);
        }),
      },
      {
        key: 'fcfYoYGrowth',
        label: 'Free Cash Flow YoY Change',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcfYoYGrowth, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
            ['Prior-Year Operating Cash Flow', v.priorYearOcfPoint],
            ['Prior-Year Capex', v.priorYearCapexPoint],
          ]);
        }),
      },
      {
        key: 'cash',
        label: 'Cash & Equivalents',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const cashPoint = point('cash', index);
          return {
            ...rowsByKey.cash.values[index],
            sources: sourceFacts([['Cash', cashPoint]]),
          };
        }),
      },
      {
        key: 'cashCurrentLiabilities',
        label: 'Cash / Current Liabilities',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cashCurrentLiabilities, [
            ['Cash', v.cashPoint],
            ['Current Liabilities', v.currentLiabilitiesPoint],
          ]);
        }),
      },
      {
        key: 'shortTermDebtCash',
        label: 'Short-Term Debt / Cash',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.shortTermDebtCash, [
            ['Short-term Debt', v.shortTermDebtPoint],
            ['Cash', v.cashPoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: SnapshotTile[] = [];
    const addTile = (
      tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }
    ) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.revenueYoYGrowth != null) {
      addTile({
        key: 'quarterly-momentum-revenue-yoy',
        label: 'Revenue YoY',
        value: latest.revenueYoYGrowth,
        format: 'percent',
        detail: 'Latest 10-Q revenue versus same quarter prior year',
        tone: latest.revenueYoYGrowth >= 10 ? 'good' : latest.revenueYoYGrowth >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Revenue', latest.revenuePoint],
          ['Prior-Year Revenue', latest.priorYearRevenuePoint],
        ]),
      });
    }

    if (latest.revenueSequentialGrowth != null) {
      addTile({
        key: 'quarterly-momentum-revenue-sequential',
        label: 'Revenue Sequential',
        value: latest.revenueSequentialGrowth,
        format: 'percent',
        detail: 'Latest 10-Q revenue versus the prior sequential 10-Q',
        tone: latest.revenueSequentialGrowth >= 5 ? 'good' : latest.revenueSequentialGrowth >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Revenue', latest.revenuePoint],
          ['Prior Sequential Revenue', latest.sequentialRevenuePoint],
        ]),
      });
    }

    if (latest.operatingIncomeYoYGrowth != null) {
      addTile({
        key: 'quarterly-momentum-operating-income-yoy',
        label: 'Operating Income YoY',
        value: latest.operatingIncomeYoYGrowth,
        format: 'percent',
        detail: 'Operating income versus same quarter prior year',
        tone: latest.operatingIncomeYoYGrowth >= 10 ? 'good' : latest.operatingIncomeYoYGrowth >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Income', latest.operatingIncomePoint],
          ['Prior-Year Operating Income', latest.priorYearOperatingIncomePoint],
        ]),
      });
    }

    if (latest.fcfYoYGrowth != null) {
      addTile({
        key: 'quarterly-momentum-fcf-yoy',
        label: 'FCF YoY',
        value: latest.fcfYoYGrowth,
        format: 'percent',
        detail: `Latest free cash flow: ${formatValue(latest.fcf, 'currency')}`,
        tone: latest.fcfYoYGrowth >= 10 ? 'good' : latest.fcfYoYGrowth >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Capex', latest.capexPoint],
          ['Prior-Year Operating Cash Flow', latest.priorYearOcfPoint],
          ['Prior-Year Capex', latest.priorYearCapexPoint],
        ]),
      });
    }

    if (latest.cashCurrentLiabilities != null) {
      addTile({
        key: 'quarterly-momentum-cash-current-liabilities',
        label: 'Cash / Current Liabilities',
        value: latest.cashCurrentLiabilities,
        format: 'percent',
        detail: 'Quarter-end liquidity against current liabilities',
        tone: latest.cashCurrentLiabilities >= 100 ? 'good' : latest.cashCurrentLiabilities >= 50 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Cash', latest.cashPoint],
          ['Current Liabilities', latest.currentLiabilitiesPoint],
        ]),
      });
    }

    return { tiles: tiles.slice(0, 4), tableRows, displayPeriods, latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <LineChart className="w-4 h-4 text-lime-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Quarterly Momentum
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked 10-Q view of recent growth, profit momentum, free cash flow, and liquidity for {industryLabel(group)} companies.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {latestPeriod ? periodLabel(latestPeriod) : 'Latest 10-Q'} inputs
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <QualityTile key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Six-Quarter Momentum Bridge
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Revenue', 'Revenue YoY Change', 'Operating Income YoY Change', 'Free Cash Flow', 'Cash & Equivalents'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Sequential rows compare adjacent reported 10-Q periods when the prior quarter is available. YoY rows compare each 10-Q period with the same fiscal quarter one year earlier. Free cash flow subtracts capital expenditures from operating cash flow using payment magnitudes where SEC tags report outflows.
          </p>
        </div>
      )}
    </div>
  );
}

function ExpenseDisciplinePanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}) {
  const { tiles, tableRows, displayPeriods, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 5);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as SnapshotTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
        group,
      };
    }

    const metricRow = (key: string, label: string) => (
      buildMetricRow(facts, key, label, displayPeriods, 'currency', group as any)
    );

    const rowsByKey = {
      revenue: metricRow('revenue', 'Revenue'),
      costOfRevenue: metricRow('costOfRevenue', 'Cost of Revenue'),
      grossProfit: metricRow('grossProfit', 'Gross Profit'),
      operatingExpenses: metricRow('operatingExpenses', 'Operating Expenses'),
      rnd: metricRow('rnd', 'R&D Expense'),
      sga: metricRow('sga', 'SG&A Expense'),
      operatingIncome: metricRow('operatingIncome', 'Operating Income'),
      interestExpense: metricRow('interestExpense', 'Interest Expense'),
      pretaxIncome: metricRow('pretaxIncome', 'Pre-tax Income'),
      incomeTax: metricRow('incomeTax', 'Income Tax'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const magnitude = (item: MetricPoint | null) => {
      const value = num(item);
      return value == null ? null : Math.abs(value);
    };
    const pct = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return (numerator / denominator) * 100;
    };
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, item]) => sourceFact(label, item))
        .filter((source): source is SourceFact & { label: string } => {
          if (!source?.tag) return false;
          const key = `${source.label}:${source.tag}:${source.end}:${source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );

    const valueForPeriod = (index: number) => {
      const revenuePoint = point('revenue', index);
      const costOfRevenuePoint = point('costOfRevenue', index);
      const grossProfitPoint = point('grossProfit', index);
      const operatingExpensesPoint = point('operatingExpenses', index);
      const rndPoint = point('rnd', index);
      const sgaPoint = point('sga', index);
      const operatingIncomePoint = point('operatingIncome', index);
      const interestExpensePoint = point('interestExpense', index);
      const pretaxIncomePoint = point('pretaxIncome', index);
      const incomeTaxPoint = point('incomeTax', index);

      const revenue = num(revenuePoint);
      const costOfRevenue = magnitude(costOfRevenuePoint);
      const grossProfit = num(grossProfitPoint);
      const reportedOperatingExpenses = magnitude(operatingExpensesPoint);
      const rnd = magnitude(rndPoint);
      const sga = magnitude(sgaPoint);
      const operatingIncome = num(operatingIncomePoint);
      const interestExpense = magnitude(interestExpensePoint);
      const pretaxIncome = num(pretaxIncomePoint);
      const incomeTax = num(incomeTaxPoint);
      const derivedOperatingExpenses = grossProfit != null && operatingIncome != null
        ? grossProfit - operatingIncome
        : null;
      const operatingExpenses = reportedOperatingExpenses ?? (
        derivedOperatingExpenses != null && derivedOperatingExpenses >= 0 ? derivedOperatingExpenses : null
      );
      const operatingExpenseInputs: Array<[string, MetricPoint | null]> = reportedOperatingExpenses != null
        ? [['Operating Expenses', operatingExpensesPoint]]
        : [
          ['Gross Profit', grossProfitPoint],
          ['Operating Income', operatingIncomePoint],
        ];

      return {
        revenuePoint,
        costOfRevenuePoint,
        grossProfitPoint,
        operatingExpensesPoint,
        rndPoint,
        sgaPoint,
        operatingIncomePoint,
        interestExpensePoint,
        pretaxIncomePoint,
        incomeTaxPoint,
        revenue,
        costOfRevenue,
        grossProfit,
        operatingExpenses,
        operatingExpenseInputs,
        rnd,
        sga,
        operatingIncome,
        interestExpense,
        pretaxIncome,
        incomeTax,
        costOfRevenueRevenue: pct(costOfRevenue, revenue),
        operatingExpenseRevenue: pct(operatingExpenses, revenue),
        rndRevenue: pct(rnd, revenue),
        rndOperatingExpense: pct(rnd, operatingExpenses),
        sgaRevenue: pct(sga, revenue),
        sgaOperatingExpense: pct(sga, operatingExpenses),
        interestRevenue: pct(interestExpense, revenue),
        interestOperatingIncome: operatingIncome != null && operatingIncome > 0
          ? pct(interestExpense, operatingIncome)
          : null,
        taxRate: pretaxIncome != null && pretaxIncome > 0 ? pct(incomeTax, pretaxIncome) : null,
      };
    };

    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => {
      const sources = sourceFacts(inputs);
      return {
        period: displayPeriods[index],
        value,
        source: sources[0] || null,
        sources,
      };
    };

    const tableRows = [
      {
        key: 'revenue',
        label: 'Revenue',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const revenuePoint = point('revenue', index);
          return {
            ...rowsByKey.revenue.values[index],
            sources: sourceFacts([['Revenue', revenuePoint]]),
          };
        }),
      },
      {
        key: 'costOfRevenue',
        label: 'Cost of Revenue',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.costOfRevenue, [['Cost of Revenue', v.costOfRevenuePoint]]);
        }),
      },
      {
        key: 'costOfRevenueRevenue',
        label: 'Cost of Revenue / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.costOfRevenueRevenue, [
            ['Cost of Revenue', v.costOfRevenuePoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'operatingExpenses',
        label: 'Operating Expenses',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.operatingExpenses, v.operatingExpenseInputs);
        }),
      },
      {
        key: 'operatingExpenseRevenue',
        label: 'Operating Expenses / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.operatingExpenseRevenue, [
            ...v.operatingExpenseInputs,
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'rndRevenue',
        label: 'R&D / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.rndRevenue, [
            ['R&D', v.rndPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'rndOperatingExpense',
        label: 'R&D / Operating Expenses',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.rndOperatingExpense, [
            ['R&D', v.rndPoint],
            ...v.operatingExpenseInputs,
          ]);
        }),
      },
      {
        key: 'sgaRevenue',
        label: 'SG&A / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.sgaRevenue, [
            ['SG&A', v.sgaPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'sgaOperatingExpense',
        label: 'SG&A / Operating Expenses',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.sgaOperatingExpense, [
            ['SG&A', v.sgaPoint],
            ...v.operatingExpenseInputs,
          ]);
        }),
      },
      {
        key: 'interestRevenue',
        label: 'Interest / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.interestRevenue, [
            ['Interest Expense', v.interestExpensePoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'interestOperatingIncome',
        label: 'Interest / Operating Income',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.interestOperatingIncome, [
            ['Interest Expense', v.interestExpensePoint],
            ['Operating Income', v.operatingIncomePoint],
          ]);
        }),
      },
      {
        key: 'taxRate',
        label: 'Effective Tax Rate',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.taxRate, [
            ['Income Tax', v.incomeTaxPoint],
            ['Pre-tax Income', v.pretaxIncomePoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: SnapshotTile[] = [];
    const addTile = (
      tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }
    ) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.costOfRevenueRevenue != null) {
      addTile({
        key: 'expense-discipline-cost-revenue',
        label: 'Cost / Revenue',
        value: latest.costOfRevenueRevenue,
        format: 'percent',
        detail: 'Cost of revenue as a share of revenue',
        tone: latest.costOfRevenueRevenue <= 50 ? 'good' : latest.costOfRevenueRevenue <= 75 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Cost of Revenue', latest.costOfRevenuePoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.operatingExpenseRevenue != null) {
      addTile({
        key: 'expense-discipline-opex-revenue',
        label: 'OpEx / Revenue',
        value: latest.operatingExpenseRevenue,
        format: 'percent',
        detail: 'Operating expenses as a share of revenue',
        tone: latest.operatingExpenseRevenue <= 25 ? 'good' : latest.operatingExpenseRevenue <= 45 ? 'warn' : 'bad',
        sources: snapshotSources([
          ...latest.operatingExpenseInputs,
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.rndRevenue != null) {
      addTile({
        key: 'expense-discipline-rnd-revenue',
        label: 'R&D / Revenue',
        value: latest.rndRevenue,
        format: 'percent',
        detail: 'Research and development intensity',
        tone: 'neutral',
        sources: snapshotSources([
          ['R&D', latest.rndPoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.sgaRevenue != null) {
      addTile({
        key: 'expense-discipline-sga-revenue',
        label: 'SG&A / Revenue',
        value: latest.sgaRevenue,
        format: 'percent',
        detail: 'Selling, general, and administrative intensity',
        tone: latest.sgaRevenue <= 20 ? 'good' : latest.sgaRevenue <= 35 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['SG&A', latest.sgaPoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.interestOperatingIncome != null) {
      addTile({
        key: 'expense-discipline-interest-burden',
        label: 'Interest Burden',
        value: latest.interestOperatingIncome,
        format: 'percent',
        detail: 'Interest expense divided by operating income',
        tone: latest.interestOperatingIncome <= 10 ? 'good' : latest.interestOperatingIncome <= 30 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Interest Expense', latest.interestExpensePoint],
          ['Operating Income', latest.operatingIncomePoint],
        ]),
      });
    }

    if (latest.taxRate != null) {
      addTile({
        key: 'expense-discipline-tax-rate',
        label: 'Tax Rate',
        value: latest.taxRate,
        format: 'percent',
        detail: 'Income tax divided by pre-tax income',
        tone: latest.taxRate >= 0 && latest.taxRate <= 35 ? 'neutral' : 'warn',
        sources: snapshotSources([
          ['Income Tax', latest.incomeTaxPoint],
          ['Pre-tax Income', latest.pretaxIncomePoint],
        ]),
      });
    }

    return { tiles: tiles.slice(0, 4), tableRows, displayPeriods, latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Expense Discipline
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked view of cost structure, operating expense mix, interest burden, and tax load for {industryLabel(group)} companies.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {latestPeriod ? periodLabel(latestPeriod) : 'Annual'} inputs
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <QualityTile key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Five-Year Expense Discipline Bridge
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Revenue', 'Cost of Revenue', 'Operating Expenses', 'Interest / Operating Income', 'Effective Tax Rate'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Expense ratios divide annual SEC XBRL amounts by revenue, operating expenses, operating income, or pre-tax income. When operating expenses are not reported directly, the table derives them from gross profit less operating income and links both source tags.
          </p>
        </div>
      )}
    </div>
  );
}

function ProfitabilityBridgePanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}) {
  const { tiles, tableRows, displayPeriods, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 5);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as SnapshotTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
        group,
      };
    }

    const metricRow = (key: string, label: string) => (
      buildMetricRow(facts, key, label, displayPeriods, 'currency', group as any)
    );

    const rowsByKey = {
      revenue: metricRow('revenue', 'Revenue'),
      grossProfit: metricRow('grossProfit', 'Gross Profit'),
      rnd: metricRow('rnd', 'R&D Expense'),
      sga: metricRow('sga', 'SG&A Expense'),
      operatingIncome: metricRow('operatingIncome', 'Operating Income'),
      pretaxIncome: metricRow('pretaxIncome', 'Pre-tax Income'),
      incomeTax: metricRow('incomeTax', 'Income Tax'),
      netIncome: metricRow('netIncome', 'Net Income'),
      operatingCashFlow: metricRow('operatingCashFlow', 'Operating Cash Flow'),
      capex: metricRow('capex', 'Capital Expenditures'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const magnitude = (item: MetricPoint | null) => {
      const value = num(item);
      return value == null ? null : Math.abs(value);
    };
    const pct = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return (numerator / denominator) * 100;
    };
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, item]) => sourceFact(label, item))
        .filter((source): source is SourceFact & { label: string } => {
          if (!source?.tag) return false;
          const key = `${source.label}:${source.tag}:${source.end}:${source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );

    const valueForPeriod = (index: number) => {
      const revenuePoint = point('revenue', index);
      const grossProfitPoint = point('grossProfit', index);
      const rndPoint = point('rnd', index);
      const sgaPoint = point('sga', index);
      const operatingIncomePoint = point('operatingIncome', index);
      const pretaxIncomePoint = point('pretaxIncome', index);
      const incomeTaxPoint = point('incomeTax', index);
      const netIncomePoint = point('netIncome', index);
      const ocfPoint = point('operatingCashFlow', index);
      const capexPoint = point('capex', index);

      const revenue = num(revenuePoint);
      const grossProfit = num(grossProfitPoint);
      const rnd = num(rndPoint);
      const sga = num(sgaPoint);
      const operatingIncome = num(operatingIncomePoint);
      const pretaxIncome = num(pretaxIncomePoint);
      const incomeTax = num(incomeTaxPoint);
      const netIncome = num(netIncomePoint);
      const ocf = num(ocfPoint);
      const capex = magnitude(capexPoint);
      const fcf = ocf != null && capex != null ? ocf - capex : null;

      return {
        revenuePoint,
        grossProfitPoint,
        rndPoint,
        sgaPoint,
        operatingIncomePoint,
        pretaxIncomePoint,
        incomeTaxPoint,
        netIncomePoint,
        ocfPoint,
        capexPoint,
        revenue,
        grossProfit,
        rnd,
        sga,
        operatingIncome,
        pretaxIncome,
        incomeTax,
        netIncome,
        ocf,
        capex,
        fcf,
        grossMargin: pct(grossProfit, revenue),
        rndRevenue: pct(rnd, revenue),
        sgaRevenue: pct(sga, revenue),
        operatingMargin: pct(operatingIncome, revenue),
        pretaxMargin: pct(pretaxIncome, revenue),
        taxRate: pretaxIncome != null && pretaxIncome > 0 ? pct(incomeTax, pretaxIncome) : null,
        netMargin: pct(netIncome, revenue),
        fcfMargin: pct(fcf, revenue),
      };
    };

    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => {
      const sources = sourceFacts(inputs);
      return {
        period: displayPeriods[index],
        value,
        source: sources[0] || null,
        sources,
      };
    };

    const tableRows = [
      {
        key: 'revenue',
        label: 'Revenue',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const revenuePoint = point('revenue', index);
          return {
            ...rowsByKey.revenue.values[index],
            sources: sourceFacts([['Revenue', revenuePoint]]),
          };
        }),
      },
      {
        key: 'grossMargin',
        label: 'Gross Margin',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.grossMargin, [
            ['Gross Profit', v.grossProfitPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'rndRevenue',
        label: 'R&D / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.rndRevenue, [
            ['R&D', v.rndPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'sgaRevenue',
        label: 'SG&A / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.sgaRevenue, [
            ['SG&A', v.sgaPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'operatingMargin',
        label: 'Operating Margin',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.operatingMargin, [
            ['Operating Income', v.operatingIncomePoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'pretaxMargin',
        label: 'Pre-tax Margin',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.pretaxMargin, [
            ['Pre-tax Income', v.pretaxIncomePoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'taxRate',
        label: 'Tax Rate',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.taxRate, [
            ['Income Tax', v.incomeTaxPoint],
            ['Pre-tax Income', v.pretaxIncomePoint],
          ]);
        }),
      },
      {
        key: 'netMargin',
        label: 'Net Margin',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.netMargin, [
            ['Net Income', v.netIncomePoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'fcfMargin',
        label: 'FCF Margin',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcfMargin, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: SnapshotTile[] = [];
    const addTile = (
      tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }
    ) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.grossMargin != null) {
      addTile({
        key: 'profitability-gross-margin',
        label: 'Gross Margin',
        value: latest.grossMargin,
        format: 'percent',
        detail: 'Gross profit divided by revenue',
        tone: latest.grossMargin >= 40 ? 'good' : latest.grossMargin >= 20 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Gross Profit', latest.grossProfitPoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.operatingMargin != null) {
      addTile({
        key: 'profitability-operating-margin',
        label: 'Operating Margin',
        value: latest.operatingMargin,
        format: 'percent',
        detail: 'Operating income divided by revenue',
        tone: latest.operatingMargin >= 15 ? 'good' : latest.operatingMargin >= 5 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Income', latest.operatingIncomePoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.netMargin != null) {
      addTile({
        key: 'profitability-net-margin',
        label: 'Net Margin',
        value: latest.netMargin,
        format: 'percent',
        detail: 'Net income divided by revenue',
        tone: latest.netMargin >= 10 ? 'good' : latest.netMargin >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Net Income', latest.netIncomePoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.fcfMargin != null) {
      addTile({
        key: 'profitability-fcf-margin',
        label: 'FCF Margin',
        value: latest.fcfMargin,
        format: 'percent',
        detail: `Free cash flow: ${formatValue(latest.fcf, 'currency')}`,
        tone: latest.fcfMargin >= 10 ? 'good' : latest.fcfMargin >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Capex', latest.capexPoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.rndRevenue != null) {
      addTile({
        key: 'profitability-rnd-revenue',
        label: 'R&D / Revenue',
        value: latest.rndRevenue,
        format: 'percent',
        detail: 'Research and development intensity',
        tone: 'neutral',
        sources: snapshotSources([
          ['R&D', latest.rndPoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    return { tiles: tiles.slice(0, 4), tableRows, displayPeriods, latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Percent className="w-4 h-4 text-violet-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Profitability Bridge
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked margin stack from revenue through free cash flow for {industryLabel(group)} companies.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {latestPeriod ? periodLabel(latestPeriod) : 'Annual'} inputs
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <QualityTile key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Five-Year Margin Bridge
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Revenue', 'Gross Margin', 'Operating Margin', 'Net Margin', 'FCF Margin'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Derived margins divide annual SEC XBRL values by annual revenue. Free cash flow margin subtracts capital expenditures from operating cash flow before dividing by revenue; linked values open the reported source tags.
          </p>
        </div>
      )}
    </div>
  );
}

function EarningsQualityPanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}) {
  const { tiles, tableRows, displayPeriods, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 5);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as SnapshotTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
        group,
      };
    }

    const metricRow = (key: string, label: string) => (
      buildMetricRow(facts, key, label, displayPeriods, 'currency', group as any)
    );

    const rowsByKey = {
      revenue: metricRow('revenue', 'Revenue'),
      netIncome: metricRow('netIncome', 'Net Income'),
      operatingCashFlow: metricRow('operatingCashFlow', 'Operating Cash Flow'),
      capex: metricRow('capex', 'Capital Expenditures'),
      totalAssets: metricRow('totalAssets', 'Total Assets'),
      currentAssets: metricRow('currentAssets', 'Current Assets'),
      currentLiabilities: metricRow('currentLiabilities', 'Current Liabilities'),
      receivables: metricRow('receivables', 'Accounts Receivable'),
      inventory: metricRow('inventory', 'Inventory'),
      accountsPayable: metricRow('accountsPayable', 'Accounts Payable'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const magnitude = (item: MetricPoint | null) => {
      const value = num(item);
      return value == null ? null : Math.abs(value);
    };
    const pct = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return (numerator / denominator) * 100;
    };
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, item]) => sourceFact(label, item))
        .filter((source): source is SourceFact & { label: string } => {
          if (!source?.tag) return false;
          const key = `${source.label}:${source.tag}:${source.end}:${source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );

    const valueForPeriod = (index: number) => {
      const revenuePoint = point('revenue', index);
      const netIncomePoint = point('netIncome', index);
      const ocfPoint = point('operatingCashFlow', index);
      const capexPoint = point('capex', index);
      const assetsPoint = point('totalAssets', index);
      const currentAssetsPoint = point('currentAssets', index);
      const currentLiabilitiesPoint = point('currentLiabilities', index);
      const receivablesPoint = point('receivables', index);
      const inventoryPoint = point('inventory', index);
      const payablesPoint = point('accountsPayable', index);

      const revenue = num(revenuePoint);
      const netIncome = num(netIncomePoint);
      const ocf = num(ocfPoint);
      const capex = magnitude(capexPoint);
      const assets = num(assetsPoint);
      const currentAssets = num(currentAssetsPoint);
      const currentLiabilities = num(currentLiabilitiesPoint);
      const receivables = num(receivablesPoint);
      const inventory = num(inventoryPoint);
      const payables = num(payablesPoint);
      const fcf = ocf != null && capex != null ? ocf - capex : null;
      const accruals = netIncome != null && ocf != null ? netIncome - ocf : null;
      const workingCapital = currentAssets != null && currentLiabilities != null
        ? currentAssets - currentLiabilities
        : null;

      return {
        revenuePoint,
        netIncomePoint,
        ocfPoint,
        capexPoint,
        assetsPoint,
        currentAssetsPoint,
        currentLiabilitiesPoint,
        receivablesPoint,
        inventoryPoint,
        payablesPoint,
        revenue,
        netIncome,
        ocf,
        capex,
        assets,
        currentAssets,
        currentLiabilities,
        receivables,
        inventory,
        payables,
        fcf,
        accruals,
        workingCapital,
        cfoConversion: netIncome != null && netIncome > 0 ? pct(ocf, netIncome) : null,
        fcfConversion: netIncome != null && netIncome > 0 ? pct(fcf, netIncome) : null,
        accrualsAssets: pct(accruals, assets),
        fcfMargin: pct(fcf, revenue),
        workingCapitalRevenue: pct(workingCapital, revenue),
        receivablesRevenue: pct(receivables, revenue),
        inventoryRevenue: pct(inventory, revenue),
        payablesRevenue: pct(payables, revenue),
      };
    };

    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => {
      const sources = sourceFacts(inputs);
      return {
        period: displayPeriods[index],
        value,
        source: sources[0] || null,
        sources,
      };
    };

    const tableRows = [
      {
        key: 'netIncome',
        label: 'Net Income',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const netIncomePoint = point('netIncome', index);
          return {
            ...rowsByKey.netIncome.values[index],
            sources: sourceFacts([['Net Income', netIncomePoint]]),
          };
        }),
      },
      {
        key: 'operatingCashFlow',
        label: 'Operating Cash Flow',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const ocfPoint = point('operatingCashFlow', index);
          return {
            ...rowsByKey.operatingCashFlow.values[index],
            sources: sourceFacts([['Operating Cash Flow', ocfPoint]]),
          };
        }),
      },
      {
        key: 'freeCashFlow',
        label: 'Free Cash Flow',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcf, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
          ]);
        }),
      },
      {
        key: 'accruals',
        label: 'Accruals',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.accruals, [
            ['Net Income', v.netIncomePoint],
            ['Operating Cash Flow', v.ocfPoint],
          ]);
        }),
      },
      {
        key: 'cfoConversion',
        label: 'CFO / Net Income',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cfoConversion, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Net Income', v.netIncomePoint],
          ]);
        }),
      },
      {
        key: 'fcfConversion',
        label: 'FCF / Net Income',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcfConversion, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
            ['Net Income', v.netIncomePoint],
          ]);
        }),
      },
      {
        key: 'accrualsAssets',
        label: 'Accruals / Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.accrualsAssets, [
            ['Net Income', v.netIncomePoint],
            ['Operating Cash Flow', v.ocfPoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'fcfMargin',
        label: 'FCF Margin',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcfMargin, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'workingCapitalRevenue',
        label: 'Working Capital / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.workingCapitalRevenue, [
            ['Current Assets', v.currentAssetsPoint],
            ['Current Liabilities', v.currentLiabilitiesPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'receivablesRevenue',
        label: 'Receivables / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.receivablesRevenue, [
            ['Receivables', v.receivablesPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'inventoryRevenue',
        label: 'Inventory / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.inventoryRevenue, [
            ['Inventory', v.inventoryPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'payablesRevenue',
        label: 'Payables / Revenue',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.payablesRevenue, [
            ['Payables', v.payablesPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: SnapshotTile[] = [];
    const addTile = (
      tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }
    ) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.cfoConversion != null) {
      addTile({
        key: 'earnings-quality-cfo-conversion',
        label: 'CFO / Net Income',
        value: latest.cfoConversion,
        format: 'percent',
        detail: 'Operating cash flow compared with net income',
        tone: latest.cfoConversion >= 100 ? 'good' : latest.cfoConversion >= 75 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Net Income', latest.netIncomePoint],
        ]),
      });
    }

    if (latest.fcfConversion != null) {
      addTile({
        key: 'earnings-quality-fcf-conversion',
        label: 'FCF / Net Income',
        value: latest.fcfConversion,
        format: 'percent',
        detail: `Free cash flow: ${formatValue(latest.fcf, 'currency')}`,
        tone: latest.fcfConversion >= 80 ? 'good' : latest.fcfConversion >= 50 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Capex', latest.capexPoint],
          ['Net Income', latest.netIncomePoint],
        ]),
      });
    }

    if (latest.accrualsAssets != null) {
      addTile({
        key: 'earnings-quality-accruals',
        label: 'Accruals / Assets',
        value: latest.accrualsAssets,
        format: 'percent',
        detail: `Accruals: ${formatValue(latest.accruals, 'currency')}`,
        tone: latest.accrualsAssets <= 0 ? 'good' : latest.accrualsAssets <= 5 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Net Income', latest.netIncomePoint],
          ['Operating Cash Flow', latest.ocfPoint],
          ['Assets', latest.assetsPoint],
        ]),
      });
    }

    if (latest.fcfMargin != null) {
      addTile({
        key: 'earnings-quality-fcf-margin',
        label: 'FCF Margin',
        value: latest.fcfMargin,
        format: 'percent',
        detail: 'Free cash flow divided by revenue',
        tone: latest.fcfMargin >= 10 ? 'good' : latest.fcfMargin >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Capex', latest.capexPoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    if (latest.workingCapitalRevenue != null) {
      addTile({
        key: 'earnings-quality-working-capital',
        label: 'Working Capital / Revenue',
        value: latest.workingCapitalRevenue,
        format: 'percent',
        detail: `Working capital: ${formatValue(latest.workingCapital, 'currency')}`,
        tone: 'neutral',
        sources: snapshotSources([
          ['Current Assets', latest.currentAssetsPoint],
          ['Current Liabilities', latest.currentLiabilitiesPoint],
          ['Revenue', latest.revenuePoint],
        ]),
      });
    }

    return { tiles: tiles.slice(0, 4), tableRows, displayPeriods, latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Earnings Quality
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked checks on cash conversion, accrual burden, free cash flow, and working-capital absorption for {industryLabel(group)} companies.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {latestPeriod ? periodLabel(latestPeriod) : 'Annual'} inputs
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <QualityTile key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Five-Year Earnings Quality Bridge
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Net Income', 'Operating Cash Flow', 'Free Cash Flow', 'Accruals / Assets', 'FCF Margin'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Accruals equal net income less operating cash flow. Free cash flow subtracts capital expenditures from operating cash flow using capex payment magnitudes where SEC tags report outflows; linked values open the reported source tags.
          </p>
        </div>
      )}
    </div>
  );
}

function GrowthDurabilityPanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}) {
  const { tiles, tableRows, displayPeriods, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 5);
    const calculationPeriods = periods.slice(0, 6);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as SnapshotTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
        group,
      };
    }

    const metricRow = (key: string, label: string) => (
      buildMetricRow(facts, key, label, calculationPeriods, 'currency', group as any)
    );

    const rowsByKey = {
      revenue: metricRow('revenue', 'Revenue'),
      grossProfit: metricRow('grossProfit', 'Gross Profit'),
      operatingIncome: metricRow('operatingIncome', 'Operating Income'),
      netIncome: metricRow('netIncome', 'Net Income'),
      operatingCashFlow: metricRow('operatingCashFlow', 'Operating Cash Flow'),
      capex: metricRow('capex', 'Capital Expenditures'),
      totalAssets: metricRow('totalAssets', 'Total Assets'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const magnitude = (item: MetricPoint | null) => {
      const value = num(item);
      return value == null ? null : Math.abs(value);
    };
    const pct = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return (numerator / denominator) * 100;
    };
    const ratio = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return numerator / denominator;
    };
    const growth = (current: number | null, prior: number | null) => {
      if (current == null || prior == null || prior === 0) return null;
      return ((current - prior) / Math.abs(prior)) * 100;
    };
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, item]) => sourceFact(label, item))
        .filter((source): source is SourceFact & { label: string } => {
          if (!source?.tag) return false;
          const key = `${source.label}:${source.tag}:${source.end}:${source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );

    const valueForPeriod = (index: number) => {
      const revenuePoint = point('revenue', index);
      const grossProfitPoint = point('grossProfit', index);
      const operatingIncomePoint = point('operatingIncome', index);
      const netIncomePoint = point('netIncome', index);
      const ocfPoint = point('operatingCashFlow', index);
      const capexPoint = point('capex', index);
      const assetsPoint = point('totalAssets', index);

      const priorRevenuePoint = point('revenue', index + 1);
      const priorGrossProfitPoint = point('grossProfit', index + 1);
      const priorOperatingIncomePoint = point('operatingIncome', index + 1);
      const priorNetIncomePoint = point('netIncome', index + 1);
      const priorOcfPoint = point('operatingCashFlow', index + 1);
      const priorCapexPoint = point('capex', index + 1);
      const priorAssetsPoint = point('totalAssets', index + 1);

      const revenue = num(revenuePoint);
      const grossProfit = num(grossProfitPoint);
      const operatingIncome = num(operatingIncomePoint);
      const netIncome = num(netIncomePoint);
      const ocf = num(ocfPoint);
      const capex = magnitude(capexPoint);
      const assets = num(assetsPoint);
      const priorRevenue = num(priorRevenuePoint);
      const priorGrossProfit = num(priorGrossProfitPoint);
      const priorOperatingIncome = num(priorOperatingIncomePoint);
      const priorNetIncome = num(priorNetIncomePoint);
      const priorOcf = num(priorOcfPoint);
      const priorCapex = magnitude(priorCapexPoint);
      const priorAssets = num(priorAssetsPoint);
      const fcf = ocf != null && capex != null ? ocf - capex : null;
      const priorFcf = priorOcf != null && priorCapex != null ? priorOcf - priorCapex : null;
      const fcfMargin = pct(fcf, revenue);
      const priorFcfMargin = pct(priorFcf, priorRevenue);
      const assetTurnover = ratio(revenue, assets);
      const priorAssetTurnover = ratio(priorRevenue, priorAssets);
      const revenueGrowth = growth(revenue, priorRevenue);
      const operatingIncomeGrowth = growth(operatingIncome, priorOperatingIncome);

      return {
        revenuePoint,
        grossProfitPoint,
        operatingIncomePoint,
        netIncomePoint,
        ocfPoint,
        capexPoint,
        assetsPoint,
        priorRevenuePoint,
        priorGrossProfitPoint,
        priorOperatingIncomePoint,
        priorNetIncomePoint,
        priorOcfPoint,
        priorCapexPoint,
        priorAssetsPoint,
        revenue,
        grossProfit,
        operatingIncome,
        netIncome,
        ocf,
        capex,
        assets,
        priorRevenue,
        priorGrossProfit,
        priorOperatingIncome,
        priorNetIncome,
        priorOcf,
        priorCapex,
        priorAssets,
        fcf,
        priorFcf,
        fcfMargin,
        priorFcfMargin,
        assetTurnover,
        priorAssetTurnover,
        revenueGrowth,
        grossProfitGrowth: growth(grossProfit, priorGrossProfit),
        operatingIncomeGrowth,
        netIncomeGrowth: growth(netIncome, priorNetIncome),
        fcfGrowth: growth(fcf, priorFcf),
        operatingLeverageSpread: operatingIncomeGrowth != null && revenueGrowth != null
          ? operatingIncomeGrowth - revenueGrowth
          : null,
        fcfMarginChange: fcfMargin != null && priorFcfMargin != null ? fcfMargin - priorFcfMargin : null,
        assetTurnoverChange: assetTurnover != null && priorAssetTurnover != null
          ? assetTurnover - priorAssetTurnover
          : null,
      };
    };

    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => {
      const sources = sourceFacts(inputs);
      return {
        period: displayPeriods[index],
        value,
        source: sources[0] || null,
        sources,
      };
    };

    const tableRows = [
      {
        key: 'revenue',
        label: 'Revenue',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const revenuePoint = point('revenue', index);
          return {
            ...rowsByKey.revenue.values[index],
            sources: sourceFacts([['Revenue', revenuePoint]]),
          };
        }),
      },
      {
        key: 'revenueGrowth',
        label: 'Revenue Growth',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.revenueGrowth, [
            ['Revenue', v.revenuePoint],
            ['Prior Revenue', v.priorRevenuePoint],
          ]);
        }),
      },
      {
        key: 'grossProfitGrowth',
        label: 'Gross Profit Growth',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.grossProfitGrowth, [
            ['Gross Profit', v.grossProfitPoint],
            ['Prior Gross Profit', v.priorGrossProfitPoint],
          ]);
        }),
      },
      {
        key: 'operatingIncomeGrowth',
        label: 'Operating Income Growth',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.operatingIncomeGrowth, [
            ['Operating Income', v.operatingIncomePoint],
            ['Prior Operating Income', v.priorOperatingIncomePoint],
          ]);
        }),
      },
      {
        key: 'netIncomeGrowth',
        label: 'Net Income Growth',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.netIncomeGrowth, [
            ['Net Income', v.netIncomePoint],
            ['Prior Net Income', v.priorNetIncomePoint],
          ]);
        }),
      },
      {
        key: 'freeCashFlow',
        label: 'Free Cash Flow',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcf, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
          ]);
        }),
      },
      {
        key: 'fcfGrowth',
        label: 'Free Cash Flow Growth',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcfGrowth, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
            ['Prior Operating Cash Flow', v.priorOcfPoint],
            ['Prior Capex', v.priorCapexPoint],
          ]);
        }),
      },
      {
        key: 'operatingLeverageSpread',
        label: 'Operating Leverage Spread',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.operatingLeverageSpread, [
            ['Revenue', v.revenuePoint],
            ['Prior Revenue', v.priorRevenuePoint],
            ['Operating Income', v.operatingIncomePoint],
            ['Prior Operating Income', v.priorOperatingIncomePoint],
          ]);
        }),
      },
      {
        key: 'fcfMargin',
        label: 'FCF Margin',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcfMargin, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
            ['Revenue', v.revenuePoint],
          ]);
        }),
      },
      {
        key: 'fcfMarginChange',
        label: 'FCF Margin Change',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcfMarginChange, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
            ['Revenue', v.revenuePoint],
            ['Prior Operating Cash Flow', v.priorOcfPoint],
            ['Prior Capex', v.priorCapexPoint],
            ['Prior Revenue', v.priorRevenuePoint],
          ]);
        }),
      },
      {
        key: 'assetTurnover',
        label: 'Asset Turnover',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.assetTurnover, [
            ['Revenue', v.revenuePoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'assetTurnoverChange',
        label: 'Asset Turnover Change',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.assetTurnoverChange, [
            ['Revenue', v.revenuePoint],
            ['Assets', v.assetsPoint],
            ['Prior Revenue', v.priorRevenuePoint],
            ['Prior Assets', v.priorAssetsPoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: SnapshotTile[] = [];
    const addTile = (
      tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }
    ) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.revenueGrowth != null) {
      addTile({
        key: 'growth-durability-revenue-growth',
        label: 'Revenue Growth',
        value: latest.revenueGrowth,
        format: 'percent',
        detail: 'Latest annual revenue versus prior annual revenue',
        tone: latest.revenueGrowth >= 10 ? 'good' : latest.revenueGrowth >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Revenue', latest.revenuePoint],
          ['Prior Revenue', latest.priorRevenuePoint],
        ]),
      });
    }

    if (latest.operatingLeverageSpread != null) {
      addTile({
        key: 'growth-durability-operating-leverage',
        label: 'Operating Leverage',
        value: latest.operatingLeverageSpread,
        format: 'percent',
        detail: 'Operating income growth less revenue growth',
        tone: latest.operatingLeverageSpread >= 0 ? 'good' : latest.operatingLeverageSpread >= -5 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Revenue', latest.revenuePoint],
          ['Prior Revenue', latest.priorRevenuePoint],
          ['Operating Income', latest.operatingIncomePoint],
          ['Prior Operating Income', latest.priorOperatingIncomePoint],
        ]),
      });
    }

    if (latest.fcfGrowth != null) {
      addTile({
        key: 'growth-durability-fcf-growth',
        label: 'FCF Growth',
        value: latest.fcfGrowth,
        format: 'percent',
        detail: `Free cash flow: ${formatValue(latest.fcf, 'currency')}`,
        tone: latest.fcfGrowth >= 10 ? 'good' : latest.fcfGrowth >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Capex', latest.capexPoint],
          ['Prior Operating Cash Flow', latest.priorOcfPoint],
          ['Prior Capex', latest.priorCapexPoint],
        ]),
      });
    }

    if (latest.fcfMarginChange != null) {
      addTile({
        key: 'growth-durability-fcf-margin-change',
        label: 'FCF Margin Change',
        value: latest.fcfMarginChange,
        format: 'percent',
        detail: `Current FCF margin: ${formatValue(latest.fcfMargin, 'percent')}`,
        tone: latest.fcfMarginChange >= 0 ? 'good' : latest.fcfMarginChange >= -2 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Capex', latest.capexPoint],
          ['Revenue', latest.revenuePoint],
          ['Prior Operating Cash Flow', latest.priorOcfPoint],
          ['Prior Capex', latest.priorCapexPoint],
          ['Prior Revenue', latest.priorRevenuePoint],
        ]),
      });
    }

    if (latest.assetTurnoverChange != null) {
      addTile({
        key: 'growth-durability-asset-turnover-change',
        label: 'Asset Turnover Change',
        value: latest.assetTurnoverChange,
        format: 'decimal',
        detail: `Current turnover: ${formatValue(latest.assetTurnover, 'decimal')}`,
        tone: latest.assetTurnoverChange >= 0 ? 'good' : 'warn',
        sources: snapshotSources([
          ['Revenue', latest.revenuePoint],
          ['Assets', latest.assetsPoint],
          ['Prior Revenue', latest.priorRevenuePoint],
          ['Prior Assets', latest.priorAssetsPoint],
        ]),
      });
    }

    return { tiles: tiles.slice(0, 4), tableRows, displayPeriods, latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Growth Durability
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked view of whether growth is broadening through profits, free cash flow, margins, and asset productivity for {industryLabel(group)} companies.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {latestPeriod ? periodLabel(latestPeriod) : 'Annual'} inputs
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <QualityTile key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Five-Year Growth Durability Bridge
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Revenue', 'Revenue Growth', 'Operating Income Growth', 'Free Cash Flow', 'Operating Leverage Spread', 'FCF Margin'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Growth rows compare each annual SEC XBRL amount with the prior annual period. Free cash flow subtracts capital expenditures from operating cash flow using payment magnitudes where SEC tags report outflows; linked values open the current and prior source tags.
          </p>
        </div>
      )}
    </div>
  );
}

function PerShareEconomicsPanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}) {
  const { tiles, tableRows, displayPeriods, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 5);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as SnapshotTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
        group,
      };
    }

    const metricRow = (key: string, label: string, format = 'currency') => (
      buildMetricRow(facts, key, label, displayPeriods, format, group as any)
    );

    const rowsByKey = {
      revenue: metricRow('revenue', 'Revenue'),
      netIncome: metricRow('netIncome', 'Net Income'),
      operatingCashFlow: metricRow('operatingCashFlow', 'Operating Cash Flow'),
      capex: metricRow('capex', 'Capital Expenditures'),
      stockholdersEquity: metricRow('stockholdersEquity', "Stockholders' Equity"),
      sharesDiluted: metricRow('sharesDiluted', 'Diluted Shares', 'shares'),
      epsDiluted: metricRow('epsDiluted', 'Diluted EPS', 'eps'),
      stockRepurchased: metricRow('stockRepurchased', 'Share Repurchases'),
      dividendsPaid: metricRow('dividendsPaid', 'Dividends Paid'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const magnitude = (item: MetricPoint | null) => {
      const value = num(item);
      return value == null ? null : Math.abs(value);
    };
    const perShare = (numerator: number | null, shares: number | null) => {
      if (numerator == null || shares == null || shares <= 0) return null;
      return numerator / shares;
    };
    const growth = (current: number | null, prior: number | null) => {
      if (current == null || prior == null || prior === 0) return null;
      return ((current - prior) / Math.abs(prior)) * 100;
    };
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, item]) => sourceFact(label, item))
        .filter((source): source is SourceFact & { label: string } => {
          if (!source?.tag) return false;
          const key = `${source.label}:${source.tag}:${source.end}:${source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );

    const valueForPeriod = (index: number) => {
      const revenuePoint = point('revenue', index);
      const netIncomePoint = point('netIncome', index);
      const ocfPoint = point('operatingCashFlow', index);
      const capexPoint = point('capex', index);
      const equityPoint = point('stockholdersEquity', index);
      const sharesPoint = point('sharesDiluted', index);
      const epsPoint = point('epsDiluted', index);
      const buybackPoint = point('stockRepurchased', index);
      const dividendPoint = point('dividendsPaid', index);
      const priorSharesPoint = point('sharesDiluted', index + 1);

      const revenue = num(revenuePoint);
      const netIncome = num(netIncomePoint);
      const ocf = num(ocfPoint);
      const capex = magnitude(capexPoint);
      const equity = num(equityPoint);
      const shares = num(sharesPoint);
      const eps = num(epsPoint);
      const buybacks = magnitude(buybackPoint);
      const dividends = magnitude(dividendPoint);
      const priorShares = num(priorSharesPoint);
      const fcf = ocf != null && capex != null ? ocf - capex : null;
      const cashReturned = buybacks != null || dividends != null ? (buybacks || 0) + (dividends || 0) : null;

      return {
        revenuePoint,
        netIncomePoint,
        ocfPoint,
        capexPoint,
        equityPoint,
        sharesPoint,
        epsPoint,
        buybackPoint,
        dividendPoint,
        priorSharesPoint,
        revenue,
        netIncome,
        ocf,
        capex,
        equity,
        shares,
        eps,
        buybacks,
        dividends,
        fcf,
        cashReturned,
        revenuePerShare: perShare(revenue, shares),
        netIncomePerShare: perShare(netIncome, shares),
        fcfPerShare: perShare(fcf, shares),
        bookValuePerShare: perShare(equity, shares),
        cashReturnedPerShare: perShare(cashReturned, shares),
        shareCountChange: growth(shares, priorShares),
      };
    };

    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => {
      const sources = sourceFacts(inputs);
      return {
        period: displayPeriods[index],
        value,
        source: sources[0] || null,
        sources,
      };
    };

    const tableRows = [
      {
        key: 'sharesDiluted',
        label: 'Diluted Shares',
        format: 'shares',
        values: displayPeriods.map((_, index) => {
          const sharesPoint = point('sharesDiluted', index);
          return {
            ...rowsByKey.sharesDiluted.values[index],
            sources: sourceFacts([['Diluted Shares', sharesPoint]]),
          };
        }),
      },
      {
        key: 'revenuePerShare',
        label: 'Revenue / Diluted Share',
        format: 'eps',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.revenuePerShare, [
            ['Revenue', v.revenuePoint],
            ['Diluted Shares', v.sharesPoint],
          ]);
        }),
      },
      {
        key: 'netIncomePerShare',
        label: 'Net Income / Diluted Share',
        format: 'eps',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.netIncomePerShare, [
            ['Net Income', v.netIncomePoint],
            ['Diluted Shares', v.sharesPoint],
          ]);
        }),
      },
      {
        key: 'reportedDilutedEps',
        label: 'Reported Diluted EPS',
        format: 'eps',
        values: displayPeriods.map((_, index) => {
          const epsPoint = point('epsDiluted', index);
          return {
            ...rowsByKey.epsDiluted.values[index],
            sources: sourceFacts([['Diluted EPS', epsPoint]]),
          };
        }),
      },
      {
        key: 'fcfPerShare',
        label: 'Free Cash Flow / Diluted Share',
        format: 'eps',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcfPerShare, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
            ['Diluted Shares', v.sharesPoint],
          ]);
        }),
      },
      {
        key: 'bookValuePerShare',
        label: 'Book Value / Diluted Share',
        format: 'eps',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.bookValuePerShare, [
            ['Equity', v.equityPoint],
            ['Diluted Shares', v.sharesPoint],
          ]);
        }),
      },
      {
        key: 'cashReturnedPerShare',
        label: 'Cash Returned / Diluted Share',
        format: 'eps',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cashReturnedPerShare, [
            ['Buybacks', v.buybackPoint],
            ['Dividends', v.dividendPoint],
            ['Diluted Shares', v.sharesPoint],
          ]);
        }),
      },
      {
        key: 'shareCountChange',
        label: 'Share Count Change',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.shareCountChange, [
            ['Diluted Shares', v.sharesPoint],
            ['Prior Diluted Shares', v.priorSharesPoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: SnapshotTile[] = [];
    const addTile = (
      tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }
    ) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.revenuePerShare != null) {
      addTile({
        key: 'per-share-revenue',
        label: 'Revenue / Share',
        value: latest.revenuePerShare,
        format: 'eps',
        detail: 'Revenue divided by diluted weighted-average shares',
        tone: 'neutral',
        sources: snapshotSources([
          ['Revenue', latest.revenuePoint],
          ['Diluted Shares', latest.sharesPoint],
        ]),
      });
    }

    if (latest.fcfPerShare != null) {
      addTile({
        key: 'per-share-fcf',
        label: 'FCF / Share',
        value: latest.fcfPerShare,
        format: 'eps',
        detail: `Free cash flow: ${formatValue(latest.fcf, 'currency')}`,
        tone: latest.fcfPerShare > 0 ? 'good' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Capex', latest.capexPoint],
          ['Diluted Shares', latest.sharesPoint],
        ]),
      });
    }

    if (latest.bookValuePerShare != null) {
      addTile({
        key: 'per-share-book-value',
        label: 'Book Value / Share',
        value: latest.bookValuePerShare,
        format: 'eps',
        detail: "Stockholders' equity divided by diluted shares",
        tone: latest.bookValuePerShare >= 0 ? 'neutral' : 'bad',
        sources: snapshotSources([
          ['Equity', latest.equityPoint],
          ['Diluted Shares', latest.sharesPoint],
        ]),
      });
    }

    if (latest.shareCountChange != null) {
      addTile({
        key: 'per-share-dilution',
        label: 'Share Count Change',
        value: latest.shareCountChange,
        format: 'percent',
        detail: 'Diluted shares versus prior annual period',
        tone: latest.shareCountChange <= 0 ? 'good' : latest.shareCountChange <= 2 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Diluted Shares', latest.sharesPoint],
          ['Prior Diluted Shares', latest.priorSharesPoint],
        ]),
      });
    }

    if (latest.cashReturnedPerShare != null) {
      addTile({
        key: 'per-share-cash-returned',
        label: 'Cash Returned / Share',
        value: latest.cashReturnedPerShare,
        format: 'eps',
        detail: `Cash returned: ${formatValue(latest.cashReturned, 'currency')}`,
        tone: 'neutral',
        sources: snapshotSources([
          ['Buybacks', latest.buybackPoint],
          ['Dividends', latest.dividendPoint],
          ['Diluted Shares', latest.sharesPoint],
        ]),
      });
    }

    return { tiles: tiles.slice(0, 4), tableRows, displayPeriods, latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Per-Share Economics
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked view of what each diluted share received across revenue, earnings, free cash flow, book value, and capital returns for {industryLabel(group)} companies.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {latestPeriod ? periodLabel(latestPeriod) : 'Annual'} inputs
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <QualityTile key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Five-Year Per-Share Bridge
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Diluted Shares', 'Revenue / Diluted Share', 'Free Cash Flow / Diluted Share', 'Book Value / Diluted Share'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Derived per-share values divide annual SEC XBRL amounts by diluted weighted-average shares. Cash returns use payment magnitudes where SEC tags report outflow concepts; linked values open the reported source tags.
          </p>
        </div>
      )}
    </div>
  );
}

function CapitalEfficiencyPanel({
  facts,
  periods,
  sicCode,
  cik,
  onTraceRow,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  onTraceRow: (row: any) => void;
}) {
  const { tiles, tableRows, displayPeriods, latestPeriod, group } = useMemo(() => {
    const displayPeriods = periods.slice(0, 5);
    const latestPeriod = displayPeriods[0];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod || displayPeriods.length === 0) {
      return {
        tiles: [] as SnapshotTile[],
        tableRows: [] as any[],
        displayPeriods,
        latestPeriod,
        group,
      };
    }

    const metricRow = (key: string, label: string, format = 'currency') => (
      buildMetricRow(facts, key, label, displayPeriods, format, group as any)
    );

    const rowsByKey = {
      revenue: metricRow('revenue', 'Revenue'),
      operatingIncome: metricRow('operatingIncome', 'Operating Income'),
      pretaxIncome: metricRow('pretaxIncome', 'Pre-tax Income'),
      incomeTax: metricRow('incomeTax', 'Income Tax'),
      netIncome: metricRow('netIncome', 'Net Income'),
      totalAssets: metricRow('totalAssets', 'Total Assets'),
      stockholdersEquity: metricRow('stockholdersEquity', "Stockholders' Equity"),
      cash: metricRow('cash', 'Cash & Equivalents'),
      shortTermDebt: metricRow('shortTermDebt', 'Short-term Debt'),
      longTermDebt: metricRow('longTermDebt', 'Long-term Debt'),
      operatingCashFlow: metricRow('operatingCashFlow', 'Operating Cash Flow'),
      capex: metricRow('capex', 'Capital Expenditures'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const magnitude = (item: MetricPoint | null) => {
      const value = num(item);
      return value == null ? null : Math.abs(value);
    };
    const pct = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return (numerator / denominator) * 100;
    };
    const ratio = (numerator: number | null, denominator: number | null) => {
      if (numerator == null || denominator == null || denominator === 0) return null;
      return numerator / denominator;
    };
    const sourceFact = (label: string, item: MetricPoint | null) => (
      item?.source?.tag ? { ...item.source, label } : null
    );
    const sourceFacts = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, item]) => sourceFact(label, item))
        .filter((source): source is SourceFact & { label: string } => {
          if (!source?.tag) return false;
          const key = `${source.label}:${source.tag}:${source.end}:${source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    const snapshotSources = (items: Array<[string, MetricPoint | null]>) => (
      items
        .map(([label, item]) => ({ label, point: item }))
        .filter((item) => item.point?.source?.tag) as SnapshotSource[]
    );

    const valueForPeriod = (index: number) => {
      const revenuePoint = point('revenue', index);
      const operatingIncomePoint = point('operatingIncome', index);
      const pretaxIncomePoint = point('pretaxIncome', index);
      const incomeTaxPoint = point('incomeTax', index);
      const netIncomePoint = point('netIncome', index);
      const assetsPoint = point('totalAssets', index);
      const equityPoint = point('stockholdersEquity', index);
      const cashPoint = point('cash', index);
      const shortDebtPoint = point('shortTermDebt', index);
      const longDebtPoint = point('longTermDebt', index);
      const ocfPoint = point('operatingCashFlow', index);
      const capexPoint = point('capex', index);

      const revenue = num(revenuePoint);
      const operatingIncome = num(operatingIncomePoint);
      const pretaxIncome = num(pretaxIncomePoint);
      const incomeTax = num(incomeTaxPoint);
      const netIncome = num(netIncomePoint);
      const assets = num(assetsPoint);
      const equity = num(equityPoint);
      const cash = num(cashPoint);
      const shortDebt = num(shortDebtPoint);
      const longDebt = num(longDebtPoint);
      const ocf = num(ocfPoint);
      const capex = magnitude(capexPoint);
      const totalDebt = shortDebt != null || longDebt != null ? (shortDebt || 0) + (longDebt || 0) : null;
      const capitalEmployed = equity != null && totalDebt != null && cash != null
        ? equity + totalDebt - cash
        : null;
      const taxRate = pretaxIncome != null && pretaxIncome > 0 && incomeTax != null
        ? Math.min(Math.max(incomeTax / pretaxIncome, 0), 1)
        : null;
      const nopat = operatingIncome != null && taxRate != null
        ? operatingIncome * (1 - taxRate)
        : null;
      const fcf = ocf != null && capex != null ? ocf - capex : null;

      return {
        revenuePoint,
        operatingIncomePoint,
        pretaxIncomePoint,
        incomeTaxPoint,
        netIncomePoint,
        assetsPoint,
        equityPoint,
        cashPoint,
        shortDebtPoint,
        longDebtPoint,
        ocfPoint,
        capexPoint,
        revenue,
        operatingIncome,
        pretaxIncome,
        incomeTax,
        netIncome,
        assets,
        equity,
        cash,
        shortDebt,
        longDebt,
        totalDebt,
        capitalEmployed,
        taxRate,
        nopat,
        fcf,
        roe: pct(netIncome, equity),
        roa: pct(netIncome, assets),
        assetTurnover: ratio(revenue, assets),
        equityMultiplier: ratio(assets, equity),
        debtEquity: ratio(totalDebt, equity),
        operatingReturnOnAssets: pct(operatingIncome, assets),
        operatingReturnOnCapital: pct(operatingIncome, capitalEmployed),
        roic: pct(nopat, capitalEmployed),
        fcfReturnOnCapital: pct(fcf, capitalEmployed),
      };
    };

    const capitalInputs = (v: ReturnType<typeof valueForPeriod>) => [
      ['Equity', v.equityPoint],
      ['ST Debt', v.shortDebtPoint],
      ['LT Debt', v.longDebtPoint],
      ['Cash', v.cashPoint],
    ] as Array<[string, MetricPoint | null]>;
    const nopatInputs = (v: ReturnType<typeof valueForPeriod>) => [
      ['Operating Income', v.operatingIncomePoint],
      ['Income Tax', v.incomeTaxPoint],
      ['Pre-tax Income', v.pretaxIncomePoint],
    ] as Array<[string, MetricPoint | null]>;
    const rowValue = (
      index: number,
      value: number | null,
      inputs: Array<[string, MetricPoint | null]>
    ) => {
      const sources = sourceFacts(inputs);
      return {
        period: displayPeriods[index],
        value,
        source: sources[0] || null,
        sources,
      };
    };

    const tableRows = [
      {
        key: 'revenue',
        label: 'Revenue',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const revenuePoint = point('revenue', index);
          return {
            ...rowsByKey.revenue.values[index],
            sources: sourceFacts([['Revenue', revenuePoint]]),
          };
        }),
      },
      {
        key: 'netIncome',
        label: 'Net Income',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const netIncomePoint = point('netIncome', index);
          return {
            ...rowsByKey.netIncome.values[index],
            sources: sourceFacts([['Net Income', netIncomePoint]]),
          };
        }),
      },
      {
        key: 'capitalEmployed',
        label: 'Capital Employed',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.capitalEmployed, capitalInputs(v));
        }),
      },
      {
        key: 'roe',
        label: 'Return on Equity',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.roe, [
            ['Net Income', v.netIncomePoint],
            ['Equity', v.equityPoint],
          ]);
        }),
      },
      {
        key: 'roa',
        label: 'Return on Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.roa, [
            ['Net Income', v.netIncomePoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'assetTurnover',
        label: 'Asset Turnover',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.assetTurnover, [
            ['Revenue', v.revenuePoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'equityMultiplier',
        label: 'Equity Multiplier',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.equityMultiplier, [
            ['Assets', v.assetsPoint],
            ['Equity', v.equityPoint],
          ]);
        }),
      },
      {
        key: 'operatingReturnOnAssets',
        label: 'Operating Return on Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.operatingReturnOnAssets, [
            ['Operating Income', v.operatingIncomePoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'nopat',
        label: 'NOPAT Proxy',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.nopat, nopatInputs(v));
        }),
      },
      {
        key: 'roic',
        label: 'ROIC Proxy',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.roic, [
            ...nopatInputs(v),
            ...capitalInputs(v),
          ]);
        }),
      },
      {
        key: 'operatingReturnOnCapital',
        label: 'Operating Return on Capital',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.operatingReturnOnCapital, [
            ['Operating Income', v.operatingIncomePoint],
            ...capitalInputs(v),
          ]);
        }),
      },
      {
        key: 'fcfReturnOnCapital',
        label: 'FCF Return on Capital',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.fcfReturnOnCapital, [
            ['Operating Cash Flow', v.ocfPoint],
            ['Capex', v.capexPoint],
            ...capitalInputs(v),
          ]);
        }),
      },
      {
        key: 'debtEquity',
        label: 'Debt / Equity',
        format: 'decimal',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.debtEquity, [
            ['ST Debt', v.shortDebtPoint],
            ['LT Debt', v.longDebtPoint],
            ['Equity', v.equityPoint],
          ]);
        }),
      },
    ].filter((row) => row.values.some((value: MetricPoint) => value.value != null && hasPointSource(value)));

    const latest = valueForPeriod(0);
    const tiles: SnapshotTile[] = [];
    const addTile = (
      tile: Omit<SnapshotTile, 'sources'> & { sources: SnapshotSource[] }
    ) => {
      if (!Number.isFinite(tile.value)) return;
      const sources = tile.sources.filter((source) => source.point?.source?.tag);
      if (!sources.length) return;
      tiles.push({ ...tile, sources });
    };

    if (latest.roe != null) {
      addTile({
        key: 'capital-efficiency-roe',
        label: 'Return on Equity',
        value: latest.roe,
        format: 'percent',
        detail: 'Net income divided by stockholders equity',
        tone: latest.roe >= 15 ? 'good' : latest.roe >= 8 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Net Income', latest.netIncomePoint],
          ['Equity', latest.equityPoint],
        ]),
      });
    }

    if (latest.roic != null) {
      addTile({
        key: 'capital-efficiency-roic',
        label: 'ROIC Proxy',
        value: latest.roic,
        format: 'percent',
        detail: 'Tax-adjusted operating income over capital employed',
        tone: latest.roic >= 12 ? 'good' : latest.roic >= 6 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Income', latest.operatingIncomePoint],
          ['Income Tax', latest.incomeTaxPoint],
          ['Pre-tax Income', latest.pretaxIncomePoint],
          ['Equity', latest.equityPoint],
          ['Debt', latest.longDebtPoint || latest.shortDebtPoint],
          ['Cash', latest.cashPoint],
        ]),
      });
    }

    if (latest.fcfReturnOnCapital != null) {
      addTile({
        key: 'capital-efficiency-fcf-return',
        label: 'FCF Return on Capital',
        value: latest.fcfReturnOnCapital,
        format: 'percent',
        detail: `Free cash flow: ${formatValue(latest.fcf, 'currency')}`,
        tone: latest.fcfReturnOnCapital >= 8 ? 'good' : latest.fcfReturnOnCapital >= 0 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Operating Cash Flow', latest.ocfPoint],
          ['Capex', latest.capexPoint],
          ['Equity', latest.equityPoint],
          ['Debt', latest.longDebtPoint || latest.shortDebtPoint],
          ['Cash', latest.cashPoint],
        ]),
      });
    }

    if (latest.assetTurnover != null) {
      addTile({
        key: 'capital-efficiency-asset-turnover',
        label: 'Asset Turnover',
        value: latest.assetTurnover,
        format: 'decimal',
        detail: 'Revenue divided by total assets',
        tone: 'neutral',
        sources: snapshotSources([
          ['Revenue', latest.revenuePoint],
          ['Assets', latest.assetsPoint],
        ]),
      });
    }

    if (latest.debtEquity != null) {
      addTile({
        key: 'capital-efficiency-debt-equity',
        label: 'Debt / Equity',
        value: latest.debtEquity,
        format: 'decimal',
        detail: `Total debt: ${formatValue(latest.totalDebt, 'currency')}`,
        tone: latest.debtEquity <= 0.5 ? 'good' : latest.debtEquity <= 1.5 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['ST Debt', latest.shortDebtPoint],
          ['LT Debt', latest.longDebtPoint],
          ['Equity', latest.equityPoint],
        ]),
      });
    }

    return { tiles: tiles.slice(0, 4), tableRows, displayPeriods, latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!tiles.length && !tableRows.length) return null;

  return (
    <div className="mt-6 border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Capital Efficiency
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked returns, turnover, leverage, and capital-employed signals for {industryLabel(group)} companies.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {latestPeriod ? periodLabel(latestPeriod) : 'Annual'} inputs
        </div>
      </div>

      {tiles.length > 0 && (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {tiles.map((tile) => (
            <QualityTile key={tile.key} tile={tile} cik={cik} />
          ))}
        </div>
      )}

      {tableRows.length > 0 && displayPeriods.length > 0 && (
        <div className="border-t border-stone-800 p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Five-Year Return on Capital Bridge
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Revenue', 'Net Income', 'Capital Employed', 'Return on Equity', 'ROIC Proxy', 'FCF Return on Capital'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Capital employed is stockholders equity plus reported short- and long-term debt less cash. ROIC proxy applies the latest period's reported tax rate to operating income before dividing by capital employed; linked values open the SEC source tags used in each calculation.
          </p>
        </div>
      )}
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
