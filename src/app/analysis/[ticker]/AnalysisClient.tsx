'use client';

import React, { useState, useContext, useMemo, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart3, Download, TrendingUp, Wallet, ArrowRightLeft, Percent,
  Link as LinkIcon, GitCompare, ExternalLink,
  LayoutDashboard, LineChart, Users, DollarSign, History, Building2,
  Loader2, AlertCircle, ShieldCheck, FileText, Search, Clock,
} from 'lucide-react';
import { MetricChart as MetricChartImpl } from '../../../components/MetricChart.jsx';
import CompanyOverview from '../../../components/research/CompanyOverview';
import FilingChangesPanel from '../../../components/research/FilingChangesPanel';
import EvidenceProvider, { useEvidence } from '../../../components/research/EvidenceProvider';
import StockPriceChartImpl from '../../../components/StockPriceChart.jsx';
import InsiderActivityImpl from '../../../components/InsiderActivity.jsx';
import HoldersSectionImpl from '../../../components/HoldersSection.jsx';
import ConceptHistoryModalImpl from '../../../components/ConceptHistoryModal.jsx';
import { TickerContext } from '../../../contexts/TickerContext';
import { secDataUrl } from '../../../utils/secApi.js';
import { checkIsFund } from '../../../utils/fundCheck.js';
import { getItemsInfo } from '../../../utils/formItems.js';
import { PEER_GROUPS } from '../../../utils/peerGroups.js';
import {
  withPeriodKind,
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
const MetricChart = MetricChartImpl as any;
const StockPriceChart = StockPriceChartImpl as any;
const InsiderActivity = InsiderActivityImpl as any;
const HoldersSection = HoldersSectionImpl as any;
const ConceptHistoryModal = ConceptHistoryModalImpl as any;

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
  { id: 'snapshot', label: 'Overview & Notes', icon: LayoutDashboard, eyebrow: 'Company summary' },
  { id: 'changes', label: 'What changed?', icon: History, eyebrow: 'Filing comparisons' },
  { id: 'filings-risk', label: 'Filings & Risk', icon: FileText, eyebrow: 'Events and disclosure' },
  { id: 'quality', label: 'Quality', icon: ShieldCheck, eyebrow: 'Operating diagnostics' },
  { id: 'financials', label: 'Financials', icon: DollarSign, eyebrow: 'Statements and ratios' },
  { id: 'market', label: 'Market', icon: LineChart, eyebrow: 'Price and filing markers' },
  { id: 'ownership', label: 'Ownership', icon: Users, eyebrow: 'Insiders and holders' },
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

interface DisclosureRiskPrompt {
  title: string;
  query: string;
  detail: string;
}

const BASE_DISCLOSURE_RISKS: DisclosureRiskPrompt[] = [
  {
    title: 'Liquidity Stress',
    query: 'going concern, substantial doubt, liquidity, covenant',
    detail: 'Cash runway, covenant, and near-term funding language',
  },
  {
    title: 'Customer Concentration',
    query: 'major customer, significant customer, customer concentration',
    detail: 'Revenue dependency and counterparty concentration language',
  },
  {
    title: 'Cybersecurity',
    query: 'cybersecurity, data breach, ransomware, unauthorized access',
    detail: 'Operational, incident, and risk-factor cyber language',
  },
];

const INDUSTRY_DISCLOSURE_RISKS: Record<string, DisclosureRiskPrompt[]> = {
  [INDUSTRY_GROUPS.BANKING]: [
    {
      title: 'Credit Quality',
      query: 'nonperforming loans, allowance for credit losses, charge-offs',
      detail: 'Loan-loss, allowance, and credit deterioration language',
    },
    {
      title: 'Deposit Pressure',
      query: 'uninsured deposits, deposit outflows, liquidity coverage',
      detail: 'Funding base stability and deposit sensitivity language',
    },
  ],
  [INDUSTRY_GROUPS.INSURANCE]: [
    {
      title: 'Catastrophe Losses',
      query: 'catastrophe losses, reinsurance, reserve development',
      detail: 'Claims severity, reinsurance, and reserve adequacy language',
    },
    {
      title: 'Investment Portfolio',
      query: 'unrealized losses, investment portfolio, credit impairments',
      detail: 'Portfolio marks, credit losses, and investment risk language',
    },
  ],
  [INDUSTRY_GROUPS.REIT]: [
    {
      title: 'Occupancy + Rent',
      query: 'occupancy, rent collections, tenant concentration',
      detail: 'Property demand, rent collection, and tenant risk language',
    },
    {
      title: 'Refinancing Risk',
      query: 'debt maturities, refinancing, interest rate risk',
      detail: 'Rate exposure, debt maturities, and refinancing language',
    },
  ],
  [INDUSTRY_GROUPS.OIL_GAS]: [
    {
      title: 'Reserves',
      query: 'proved reserves, reserve estimates, depletion',
      detail: 'Reserve base, depletion, and estimation language',
    },
    {
      title: 'Commodity Exposure',
      query: 'commodity prices, hedging, price volatility',
      detail: 'Price sensitivity, hedge book, and commodity-cycle language',
    },
  ],
  [INDUSTRY_GROUPS.AIRLINES]: [
    {
      title: 'Fuel + Capacity',
      query: 'fuel prices, capacity, load factor',
      detail: 'Fuel cost exposure and capacity planning language',
    },
    {
      title: 'Labor + Fleet',
      query: 'labor costs, collective bargaining, aircraft delivery',
      detail: 'Labor, aircraft delivery, and fleet disruption language',
    },
  ],
  [INDUSTRY_GROUPS.TECH]: [
    {
      title: 'Platform + Antitrust',
      query: 'App Store, antitrust, Digital Markets Act',
      detail: 'Platform rules, app marketplace, and competition language',
    },
    {
      title: 'Privacy + Services',
      query: 'privacy, App Store, services',
      detail: 'Privacy regulation, services revenue, and ecosystem language',
    },
  ],
  [INDUSTRY_GROUPS.RETAIL]: [
    {
      title: 'Inventory + Demand',
      query: 'inventory, markdowns, consumer demand',
      detail: 'Inventory quality, markdown, and demand weakness language',
    },
    {
      title: 'Supply Chain',
      query: 'supply chain, tariffs, freight costs',
      detail: 'Tariff, freight, vendor, and supply disruption language',
    },
  ],
  [INDUSTRY_GROUPS.PHARMA]: [
    {
      title: 'Clinical Pipeline',
      query: 'clinical trial, FDA, regulatory approval',
      detail: 'Trial, approval, and regulator-dependent value drivers',
    },
    {
      title: 'Patent + Exclusivity',
      query: 'patent expiration, exclusivity, generic competition',
      detail: 'IP cliff, exclusivity, and competitive entry language',
    },
  ],
  [INDUSTRY_GROUPS.MANUFACTURING]: [
    {
      title: 'Input Costs',
      query: 'raw material costs, supply chain, tariffs',
      detail: 'Input inflation, supplier risk, and tariff language',
    },
    {
      title: 'Backlog + Orders',
      query: 'backlog, orders, cancellations',
      detail: 'Demand visibility, order flow, and cancellation language',
    },
  ],
  [INDUSTRY_GROUPS.UTILITIES]: [
    {
      title: 'Regulatory Recovery',
      query: 'rate case, regulatory recovery, allowed return',
      detail: 'Rate-case, allowed-return, and cost-recovery language',
    },
    {
      title: 'Capital Program',
      query: 'capital expenditures, transmission, grid modernization',
      detail: 'Capex, grid investment, and regulatory execution language',
    },
  ],
  [INDUSTRY_GROUPS.GENERAL]: [
    {
      title: 'Restructuring',
      query: 'restructuring, impairment, cost reduction',
      detail: 'Turnaround, asset write-down, and cost action language',
    },
    {
      title: 'Litigation',
      query: 'litigation, investigations, legal proceedings',
      detail: 'Material legal, investigation, and proceeding language',
    },
  ],
};

interface PeerGroupPreset {
  id: string;
  label: string;
  description: string;
  tickers: string[];
}

const INDUSTRY_PEER_GROUP_IDS: Record<string, string[]> = {
  [INDUSTRY_GROUPS.BANKING]: ['big-banks', 'regional-banks', 'credit-cards'],
  [INDUSTRY_GROUPS.INSURANCE]: ['insurance'],
  [INDUSTRY_GROUPS.REIT]: ['insurance', 'big-banks'],
  [INDUSTRY_GROUPS.OIL_GAS]: ['big-oil'],
  [INDUSTRY_GROUPS.AIRLINES]: ['us-airlines'],
  [INDUSTRY_GROUPS.TECH]: ['mega-tech', 'semiconductors', 'streaming'],
  [INDUSTRY_GROUPS.RETAIL]: ['mega-retail'],
  [INDUSTRY_GROUPS.PHARMA]: ['big-pharma'],
  [INDUSTRY_GROUPS.MANUFACTURING]: ['ev-autos', 'semiconductors', 'big-oil'],
  [INDUSTRY_GROUPS.UTILITIES]: ['big-oil', 'big-banks'],
  [INDUSTRY_GROUPS.GENERAL]: ['mega-tech', 'big-banks', 'mega-retail'],
};

const PEER_GROUP_PRESETS = PEER_GROUPS as PeerGroupPreset[];

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
  const [periodType, setPeriodType] = useState<'annual' | 'quarterly' | 'ytd' | 'ttm'>('quarterly');
  const [statementView, setStatementView] = useState<StatementViewMode>('reported');
  const [showGrowth, setShowGrowth] = useState(true);
  const [activeWorkspace, setActiveWorkspace] = useState('snapshot');
  useEffect(() => {
    const view = new URL(window.location.href).searchParams.get('view');
    setActiveWorkspace(SECTIONS.some((s) => s.id === view) ? view! : 'snapshot');
  }, [urlTicker]);
  function selectWorkspace(view: string) {
    setActiveWorkspace(view);
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    window.history.replaceState(null, '', url);
  }

  const [insiderMarkers, setInsiderMarkers] = useState<InsiderMarker[]>([]);
  const handleInsiderMarkers = useCallback((markers: InsiderMarker[]) => {
    setInsiderMarkers(markers || []);
  }, []);

  const [conceptToTrace, setConceptToTrace] = useState<ConceptToTrace | null>(null);

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
          exchanges: [...new Set(submissions.exchanges || [])].join(', ') || 'N/A',
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
  const periods = useMemo(() => periodType === 'annual' ? annualPeriods : periodType === 'quarterly' ? quarterlyPeriods : withPeriodKind(quarterlyPeriods, periodType), [periodType, annualPeriods, quarterlyPeriods]);

  const statementDef = STATEMENTS.find((s) => s.id === statement) || STATEMENTS[0];
  const rows = useMemo(
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
    () => (facts && periods.length > 0 ? buildRatios(facts, periods, sicCode as any) : []),
    [facts, periods, sicCode]
  );

  const coverageStatementRows = useMemo(
    () => (facts && annualPeriods.length > 0 ? STATEMENTS.flatMap((s) => s.build(facts, annualPeriods, sicCode as any)) : []),
    [facts, annualPeriods, sicCode]
  );

  const coverageRatioRows = useMemo(
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
    const url = `${window.location.origin}/analysis/${t}?view=${activeWorkspace}`;
    navigator.clipboard.writeText(url);
  };

  const goToCompare = () => {
    const t = urlTicker || company?.tickers?.split(',')[0]?.trim();
    if (t) router.push(`/compare/${t}`);
    else router.push('/compare');
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
    <EvidenceProvider cik={company?.cik} ticker={chartTicker} filings={filings}>
    <div className="research-workspace">
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
            disclosure risk radar, quarterly momentum, expense discipline, profitability bridge, earnings quality, growth durability, per-share economics, capital efficiency, asset composition, balance sheet risk, cash conversion, payout coverage, and insider trading activity.
          </p>
          <p className="text-stone-700 text-[10px] max-w-md mx-auto mt-3">
            Mutual fund and ETF tickers are automatically routed to the Funds page.
          </p>
        </div>
      )}

      {facts && (
        <div className="space-y-6">
          <section className="professional-card relative overflow-hidden p-4 sm:p-5">
            <div className="absolute -right-24 -top-24 h-64 w-64 rounded-full bg-amber-400/10 blur-3xl" />
            <div className="relative flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
              <div className="min-w-0">
                <div className="eyebrow">Company analysis workspace</div>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                    {company?.name || chartTicker}
                  </h1>
                  <span className="mb-1 rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs font-black uppercase tracking-[0.18em] text-amber-200">
                    {chartTicker}
                  </span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  {company?.cik && <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5">CIK {company.cik}</span>}
                  {company?.exchanges && <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5">{company.exchanges}</span>}
                  {company?.fiscalYearEnd && <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5">FY end {company.fiscalYearEnd.slice(0, 2)}/{company.fiscalYearEnd.slice(2)}</span>}
                  <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5">{industryLabel(group)}{sicCode ? ` · SIC ${sicCode}` : ''}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button onClick={copyShareLink} className="secondary-button" type="button">
                  <LinkIcon className="h-4 w-4" /> Share
                </button>
                <button onClick={goToCompare} className="secondary-button" type="button">
                  <GitCompare className="h-4 w-4" /> Compare
                </button>
                {company?.cik && (
                  <a
                    href={`https://www.sec.gov/edgar/browse/?CIK=${company.cik}`}
                    target="_blank"
                    rel="noreferrer"
                    className="primary-button"
                  >
                    <ExternalLink className="h-4 w-4" /> SEC source
                  </a>
                )}
              </div>
            </div>
          </section>

          <div className="space-y-5">
            <nav aria-label="Company research" className="flex flex-wrap gap-2 rounded-xl border border-white/10 bg-slate-950/80 p-2">
              {SECTIONS.map((section) => <button type="button" key={section.id} aria-pressed={activeWorkspace === section.id} onClick={() => selectWorkspace(section.id)} className={`rounded-lg px-4 py-3 text-sm font-semibold transition ${activeWorkspace === section.id ? 'bg-amber-300 text-slate-950' : 'text-slate-300 hover:bg-white/10'}`}>{section.label}{section.id === 'ownership' && form4Count > 0 ? ` (${form4Count})` : ''}</button>)}
            </nav>

            <div id="analysis-workspace" className="min-w-0 space-y-6 scroll-mt-28">
              <section id="snapshot" hidden={activeWorkspace !== 'snapshot'} className="space-y-6 scroll-mt-28">
                  <CompanyOverview key={chartTicker} ticker={chartTicker} company={company} facts={facts} sic={sicCode} filings={filings} onChanges={() => selectWorkspace('changes')} />
                  {annualPeriods.length > 0 && <details className="rounded-xl border border-white/10 p-5"><summary className="cursor-pointer text-sm font-semibold text-slate-300">Annual diligence and data coverage</summary><div className="mt-5 space-y-6"><AnalystChecklist facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} /><DataCoveragePanel statementRows={coverageStatementRows} ratioRows={coverageRatioRows} periods={annualPeriods} filings={filings} cik={company?.cik} /></div></details>}
                  <details className="rounded-xl border border-white/10 p-5"><summary className="cursor-pointer text-sm font-semibold text-slate-300">Source filings and methodology</summary><div className="mt-4 space-y-4"><p className="text-sm leading-6 text-slate-400">Values require compatible periods and units. Calculated quarters retain their cumulative source inputs. Click a value to inspect its evidence. {disclosure?.body}</p><AnalysisSourcePack company={company} filings={filings} ticker={chartTicker} /></div></details>
                </section>
              {activeWorkspace === 'changes' && <FilingChangesPanel key={chartTicker} ticker={chartTicker} />}

              {activeWorkspace === 'filings-risk' && (
                <section id="filings-risk" className="space-y-6 scroll-mt-28">
                  <SectionHeader icon={FileText} title="Filings & Risk" />
                  {annualPeriods.length > 0 ? (
                    <>
                      <FilingActivityPanel filings={filings} ticker={chartTicker} />
                      <DisclosureRiskRadar ticker={chartTicker} companyName={company?.name} sicCode={sicCode} />
                      <PeerContextWorkbench ticker={chartTicker} companyName={company?.name} sicCode={sicCode} />
                      <IndustryResearchPlaybook facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} ticker={chartTicker} companyName={company?.name} />
                      <FinancialInflectionMonitor statementRows={coverageStatementRows} ratioRows={coverageRatioRows} periods={annualPeriods} cik={company?.cik} ticker={chartTicker} />
                    </>
                  ) : (
                    <div className="panel-card p-8 text-center text-sm text-slate-500">No annual XBRL periods are available for this company yet.</div>
                  )}
                </section>
              )}

              {activeWorkspace === 'quality' && (
                <section id="quality" className="space-y-6 scroll-mt-28">
                  <SectionHeader icon={ShieldCheck} title="Quality Diagnostics" />
                  {annualPeriods.length > 0 ? (
                    <>
                      <QuarterlyMomentumPanel facts={facts} periods={quarterlyPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <QualitySnapshot facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} />
                      <ExpenseDisciplinePanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <ProfitabilityBridgePanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <EarningsQualityPanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <GrowthDurabilityPanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <PerShareEconomicsPanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <CapitalEfficiencyPanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <AssetCompositionPanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <BalanceSheetRiskPanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <CashConversionPanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                      <CapitalAllocationPanel facts={facts} periods={annualPeriods} sicCode={sicCode} cik={company?.cik} onTraceRow={traceRowHistory} />
                    </>
                  ) : (
                    <div className="panel-card p-8 text-center text-sm text-slate-500">No annual XBRL periods are available for this company yet.</div>
                  )}
                </section>
              )}

              {activeWorkspace === 'financials' && (
                <section id="financials" className="space-y-10 scroll-mt-28">
                  <div>
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
                              className={`flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-black uppercase tracking-[0.15em] transition-colors ${
                                active
                                  ? 'bg-amber-300 text-slate-950 border-amber-300'
                                  : 'bg-white/[0.035] text-slate-400 border-white/10 hover:border-white/20 hover:text-slate-200'
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
                          className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border rounded-full transition-colors ${
                            periodType === 'annual' ? 'bg-slate-100 text-slate-950 border-slate-100' : 'bg-white/[0.035] text-slate-400 border-white/10 hover:border-white/20'
                          }`}
                          type="button"
                        >
                          Annual (10-K)
                        </button>
                        <button
                          onClick={() => setPeriodType('quarterly')}
                          className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border rounded-full transition-colors ${
                            periodType === 'quarterly' ? 'bg-slate-100 text-slate-950 border-slate-100' : 'bg-white/[0.035] text-slate-400 border-white/10 hover:border-white/20'
                          }`}
                          type="button"
                        >
                          Quarterly (10-Q)
                        </button>
                        {(['ytd', 'ttm'] as const).map((basis) => <button key={basis} type="button" aria-pressed={periodType === basis} onClick={() => setPeriodType(basis)} className={`rounded-full border px-3 py-2 text-sm ${periodType === basis ? 'bg-slate-100 text-slate-950' : 'border-white/10 text-slate-300'}`}>{basis === 'ytd' ? 'Year to date' : 'Trailing 12 months'}</button>)}

                        <button
                          onClick={() => setStatementView('reported')}
                          className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border rounded-full transition-colors ${
                            activeStatementView === 'reported' ? 'bg-slate-100 text-slate-950 border-slate-100' : 'bg-white/[0.035] text-slate-400 border-white/10 hover:border-white/20'
                          }`}
                          type="button"
                        >
                          Values
                        </button>
                        <button
                          onClick={() => setStatementView('commonSize')}
                          disabled={!commonSizeAvailable}
                          title={commonSizeBasis ? `Divide statement rows by ${commonSizeBasis.label}` : 'Common-size view unavailable'}
                          className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                            activeStatementView === 'commonSize' ? 'bg-sky-300 text-slate-950 border-sky-300' : 'bg-white/[0.035] text-slate-400 border-white/10 hover:border-white/20'
                          }`}
                          type="button"
                        >
                          {commonSizeBasis?.buttonLabel || 'Common Size'}
                        </button>

                        {periodType === 'annual' && activeStatementView === 'reported' && (
                          <button
                            onClick={() => setShowGrowth((s) => !s)}
                            className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border rounded-full transition-colors ${
                              showGrowth ? 'bg-emerald-300 text-slate-950 border-emerald-300' : 'bg-white/[0.035] text-slate-400 border-white/10 hover:border-white/20'
                            }`}
                            type="button"
                          >
                            Growth {showGrowth ? 'ON' : 'OFF'}
                          </button>
                        )}

                        <button
                          onClick={() => exportCsv(displayedRows, activeStatementView === 'commonSize' ? `${statement}_common_size` : statement)}
                          className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest font-bold border rounded-full border-white/10 text-slate-400 hover:border-amber-300/50 hover:text-amber-200 transition-colors"
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
                          <MetricChart key={row.label} title={row.label} data={row.values} format={row.format} chartType="bar" />
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

                    <p className="mt-4 text-[11px] text-slate-500 leading-relaxed">
                      Source: SEC XBRL Company Facts. Hover any value for the source XBRL tag; click to open SEC's concept endpoint.
                      {activeStatementView === 'commonSize' && commonSizeBasis ? (
                        <span> Common-size values divide each reported row by {commonSizeBasis.label}; computed cells link both inputs.</span>
                      ) : null}{' '}
                      Click the <History className="inline w-3 h-3 text-amber-300" /> icon next to any metric to trace its full reporting history including restatements.
                      Industry group: <span className="text-amber-200 font-bold">{industryLabel(group)}</span>
                      {sicCode ? <span> · SIC {sicCode}</span> : null}
                    </p>
                  </div>

                  <div>
                    <SectionHeader icon={Percent} title="Ratios" />

                    <div className="mb-4 flex gap-1 justify-end flex-wrap">
                      {periodType === 'annual' && (
                        <button
                          onClick={() => setShowGrowth((s) => !s)}
                          className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border rounded-full transition-colors ${
                            showGrowth ? 'bg-emerald-300 text-slate-950 border-emerald-300' : 'bg-white/[0.035] text-slate-400 border-white/10 hover:border-white/20'
                          }`}
                          type="button"
                        >
                          Growth {showGrowth ? 'ON' : 'OFF'}
                        </button>
                      )}
                      <button
                        onClick={() => exportCsv(ratioRows, 'ratios')}
                        className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest font-bold border rounded-full border-white/10 text-slate-400 hover:border-amber-300/50 hover:text-amber-200 transition-colors"
                        type="button"
                      >
                        <Download className="w-3.5 h-3.5" />
                        CSV
                      </button>
                    </div>

                    {featuredRatioRows.length > 0 && (
                      <div className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {featuredRatioRows.map((row: { label: string; values: any[]; format: string }) => (
                          <MetricChart key={row.label} title={row.label} data={row.values} format={row.format} chartType="line" />
                        ))}
                      </div>
                    )}

                    <FinancialTable rows={ratioRows} periods={periods} growthVisible={growthVisible} cik={company?.cik} onTraceRow={traceRowHistory} isHeaderRow={() => false} />

                    <p className="mt-4 text-[11px] text-slate-500 leading-relaxed">
                      Industry-specific ratios auto-selected based on SIC {sicCode}
                      ({industryLabel(group)}). Ratios are computed from reported XBRL values and may differ slightly from company-reported non-GAAP versions.
                    </p>
                  </div>
                </section>
              )}

              {activeWorkspace === 'market' && (
                <section id="market" className="space-y-6 scroll-mt-28">
                  <SectionHeader icon={LineChart} title="Market Timeline" />
                  {company?.cik && <div hidden><InsiderActivity cik={company.cik} filings={filings} onMarkersReady={handleInsiderMarkers} /></div>}
                  {chartTicker && filings.length > 0 ? (
                    <StockPriceChart ticker={chartTicker} filings={filings} insiderMarkers={insiderMarkers} />
                  ) : (
                    <div className="panel-card p-8 text-center">
                      <p className="text-slate-500 text-xs uppercase tracking-widest">Stock chart unavailable</p>
                    </div>
                  )}
                </section>
              )}

              {activeWorkspace === 'ownership' && (
                <section id="ownership" className="space-y-6 scroll-mt-28">
                  <SectionHeader icon={Users} title="Ownership" />
                  {company?.cik ? (
                    <InsiderActivity cik={company.cik} filings={filings} onMarkersReady={handleInsiderMarkers} />
                  ) : (
                    <div className="panel-card p-8 text-center">
                      <p className="text-slate-500 text-xs uppercase tracking-widest">Loading insider data...</p>
                    </div>
                  )}
                  {chartTicker && <HoldersSection ticker={chartTicker} cik={company?.cik} companyName={company?.name} />}
                </section>
              )}
            </div>
          </div>
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
    </div>
    </EvidenceProvider>
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

type LabeledSourceFact = SourceFact & { label?: string };

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
        classification: 'calculated',
        formula: `${row.label} / ${basisLabel} × 100`,
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

function AssetCompositionPanel({
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
      totalAssets: metricRow('totalAssets', 'Total Assets'),
      currentAssets: metricRow('currentAssets', 'Current Assets'),
      cash: metricRow('cash', 'Cash & Equivalents'),
      shortTermInvestments: metricRow('shortTermInvestments', 'Short-term Investments'),
      receivables: metricRow('receivables', 'Accounts Receivable'),
      inventory: metricRow('inventory', 'Inventory'),
      ppe: metricRow('ppe', 'Property, Plant & Equipment'),
      goodwill: metricRow('goodwill', 'Goodwill'),
      intangibles: metricRow('intangibles', 'Intangible Assets'),
    };

    const point = (key: keyof typeof rowsByKey, index: number): MetricPoint | null => (
      rowsByKey[key]?.values?.[index] || null
    );
    const num = (item: MetricPoint | null) => (
      typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : null
    );
    const positive = (item: MetricPoint | null) => {
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
      const assetsPoint = point('totalAssets', index);
      const currentAssetsPoint = point('currentAssets', index);
      const cashPoint = point('cash', index);
      const investmentsPoint = point('shortTermInvestments', index);
      const receivablesPoint = point('receivables', index);
      const inventoryPoint = point('inventory', index);
      const ppePoint = point('ppe', index);
      const goodwillPoint = point('goodwill', index);
      const intangiblesPoint = point('intangibles', index);

      const assets = num(assetsPoint);
      const currentAssets = positive(currentAssetsPoint);
      const cash = positive(cashPoint);
      const investments = positive(investmentsPoint);
      const receivables = positive(receivablesPoint);
      const inventory = positive(inventoryPoint);
      const ppe = positive(ppePoint);
      const goodwill = positive(goodwillPoint);
      const intangibles = positive(intangiblesPoint);
      const cashAndInvestments = cash != null || investments != null ? (cash || 0) + (investments || 0) : null;
      const goodwillAndIntangibles = goodwill != null || intangibles != null ? (goodwill || 0) + (intangibles || 0) : null;
      const tangibleAssets = assets != null && goodwillAndIntangibles != null ? assets - goodwillAndIntangibles : null;

      return {
        assetsPoint,
        currentAssetsPoint,
        cashPoint,
        investmentsPoint,
        receivablesPoint,
        inventoryPoint,
        ppePoint,
        goodwillPoint,
        intangiblesPoint,
        assets,
        currentAssets,
        cash,
        investments,
        receivables,
        inventory,
        ppe,
        goodwill,
        intangibles,
        cashAndInvestments,
        goodwillAndIntangibles,
        tangibleAssets,
        currentAssetsAssets: pct(currentAssets, assets),
        cashAssets: pct(cash, assets),
        cashAndInvestmentsAssets: pct(cashAndInvestments, assets),
        receivablesAssets: pct(receivables, assets),
        inventoryAssets: pct(inventory, assets),
        ppeAssets: pct(ppe, assets),
        goodwillAssets: pct(goodwill, assets),
        intangiblesAssets: pct(intangibles, assets),
        goodwillAndIntangiblesAssets: pct(goodwillAndIntangibles, assets),
        tangibleAssetsAssets: pct(tangibleAssets, assets),
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
        key: 'totalAssets',
        label: 'Total Assets',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const assetsPoint = point('totalAssets', index);
          return {
            ...rowsByKey.totalAssets.values[index],
            sources: sourceFacts([['Assets', assetsPoint]]),
          };
        }),
      },
      {
        key: 'currentAssets',
        label: 'Current Assets',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.currentAssets, [
            ['Current Assets', v.currentAssetsPoint],
          ]);
        }),
      },
      {
        key: 'currentAssetsAssets',
        label: 'Current Assets / Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.currentAssetsAssets, [
            ['Current Assets', v.currentAssetsPoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'cashAndInvestments',
        label: 'Cash + Short-term Investments',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cashAndInvestments, [
            ['Cash', v.cashPoint],
            ['Short-term Investments', v.investmentsPoint],
          ]);
        }),
      },
      {
        key: 'cashAndInvestmentsAssets',
        label: 'Cash + Investments / Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.cashAndInvestmentsAssets, [
            ['Cash', v.cashPoint],
            ['Short-term Investments', v.investmentsPoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'receivablesAssets',
        label: 'Receivables / Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.receivablesAssets, [
            ['Receivables', v.receivablesPoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'inventoryAssets',
        label: 'Inventory / Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.inventoryAssets, [
            ['Inventory', v.inventoryPoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'ppeAssets',
        label: 'PP&E / Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.ppeAssets, [
            ['PP&E', v.ppePoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'goodwill',
        label: 'Goodwill',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.goodwill, [
            ['Goodwill', v.goodwillPoint],
          ]);
        }),
      },
      {
        key: 'intangibles',
        label: 'Intangible Assets',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.intangibles, [
            ['Intangibles', v.intangiblesPoint],
          ]);
        }),
      },
      {
        key: 'goodwillAndIntangibles',
        label: 'Goodwill + Intangibles',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.goodwillAndIntangibles, [
            ['Goodwill', v.goodwillPoint],
            ['Intangibles', v.intangiblesPoint],
          ]);
        }),
      },
      {
        key: 'goodwillAndIntangiblesAssets',
        label: 'Goodwill + Intangibles / Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.goodwillAndIntangiblesAssets, [
            ['Goodwill', v.goodwillPoint],
            ['Intangibles', v.intangiblesPoint],
            ['Assets', v.assetsPoint],
          ]);
        }),
      },
      {
        key: 'tangibleAssets',
        label: 'Tangible Assets',
        format: 'currency',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.tangibleAssets, [
            ['Assets', v.assetsPoint],
            ['Goodwill', v.goodwillPoint],
            ['Intangibles', v.intangiblesPoint],
          ]);
        }),
      },
      {
        key: 'tangibleAssetsAssets',
        label: 'Tangible Assets / Assets',
        format: 'percent',
        values: displayPeriods.map((_, index) => {
          const v = valueForPeriod(index);
          return rowValue(index, v.tangibleAssetsAssets, [
            ['Assets', v.assetsPoint],
            ['Goodwill', v.goodwillPoint],
            ['Intangibles', v.intangiblesPoint],
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

    if (latest.cashAndInvestmentsAssets != null) {
      addTile({
        key: 'asset-composition-cash-investments',
        label: 'Cash + Investments / Assets',
        value: latest.cashAndInvestmentsAssets,
        format: 'percent',
        detail: `Liquid assets: ${formatValue(latest.cashAndInvestments, 'currency')}`,
        tone: latest.cashAndInvestmentsAssets >= 20 ? 'good' : latest.cashAndInvestmentsAssets >= 8 ? 'neutral' : 'warn',
        sources: snapshotSources([
          ['Cash', latest.cashPoint],
          ['Short-term Investments', latest.investmentsPoint],
          ['Assets', latest.assetsPoint],
        ]),
      });
    }

    if (latest.goodwillAndIntangiblesAssets != null) {
      addTile({
        key: 'asset-composition-goodwill-intangibles',
        label: 'Goodwill + Intangibles / Assets',
        value: latest.goodwillAndIntangiblesAssets,
        format: 'percent',
        detail: `Goodwill + intangibles: ${formatValue(latest.goodwillAndIntangibles, 'currency')}`,
        tone: latest.goodwillAndIntangiblesAssets <= 15 ? 'good' : latest.goodwillAndIntangiblesAssets <= 35 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Goodwill', latest.goodwillPoint],
          ['Intangibles', latest.intangiblesPoint],
          ['Assets', latest.assetsPoint],
        ]),
      });
    }

    if (latest.tangibleAssetsAssets != null) {
      addTile({
        key: 'asset-composition-tangible-assets',
        label: 'Tangible Assets / Assets',
        value: latest.tangibleAssetsAssets,
        format: 'percent',
        detail: 'Total assets less reported goodwill and intangibles',
        tone: latest.tangibleAssetsAssets >= 75 ? 'good' : latest.tangibleAssetsAssets >= 50 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Assets', latest.assetsPoint],
          ['Goodwill', latest.goodwillPoint],
          ['Intangibles', latest.intangiblesPoint],
        ]),
      });
    }

    if (latest.receivablesAssets != null) {
      addTile({
        key: 'asset-composition-receivables',
        label: 'Receivables / Assets',
        value: latest.receivablesAssets,
        format: 'percent',
        detail: 'Receivables concentration in the reported asset base',
        tone: latest.receivablesAssets <= 20 ? 'good' : latest.receivablesAssets <= 35 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Receivables', latest.receivablesPoint],
          ['Assets', latest.assetsPoint],
        ]),
      });
    }

    if (latest.inventoryAssets != null) {
      addTile({
        key: 'asset-composition-inventory',
        label: 'Inventory / Assets',
        value: latest.inventoryAssets,
        format: 'percent',
        detail: 'Inventory concentration in the reported asset base',
        tone: latest.inventoryAssets <= 20 ? 'good' : latest.inventoryAssets <= 35 ? 'warn' : 'bad',
        sources: snapshotSources([
          ['Inventory', latest.inventoryPoint],
          ['Assets', latest.assetsPoint],
        ]),
      });
    }

    if (latest.ppeAssets != null) {
      addTile({
        key: 'asset-composition-ppe',
        label: 'PP&E / Assets',
        value: latest.ppeAssets,
        format: 'percent',
        detail: 'Property, plant, and equipment concentration',
        tone: 'neutral',
        sources: snapshotSources([
          ['PP&E', latest.ppePoint],
          ['Assets', latest.assetsPoint],
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
            <Building2 className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Asset Composition
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-linked view of liquid assets, operating assets, PP&E, goodwill, intangibles, and tangible asset mix for {industryLabel(group)} companies.
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
            Five-Year Asset Composition Bridge
          </div>
          <FinancialTable
            rows={tableRows}
            periods={displayPeriods}
            growthVisible={false}
            cik={cik}
            onTraceRow={onTraceRow}
            isHeaderRow={(label: string) => ['Total Assets', 'Current Assets', 'Cash + Short-term Investments', 'Goodwill + Intangibles', 'Tangible Assets'].includes(label)}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
            Composition rows divide reported SEC XBRL balance-sheet concepts by total assets. Tangible assets subtract reported goodwill and intangible assets from total assets; linked values open each source tag.
          </p>
        </div>
      )}
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

function findMostRecentFiling(filings: FilingEntry[]) {
  return [...filings].sort((a, b) => filingDateTime(b) - filingDateTime(a))[0] || null;
}

type SourcePackTone = 'emerald' | 'sky' | 'amber' | 'violet' | 'stone';

interface SourcePackItem {
  key: string;
  label: string;
  title: string;
  detail: string;
  url: string | null;
  badge: string;
  tone: SourcePackTone;
}

function AnalysisSourcePack({
  company,
  filings,
  ticker,
}: {
  company?: CompanyState | null;
  filings: FilingEntry[];
  ticker?: string;
}) {
  const pack = useMemo(() => {
    const cik = company?.cik ? String(company.cik).padStart(10, '0') : '';
    const latestAnnual = findLatestFiling(filings, ['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);
    const latestQuarterly = findLatestFiling(filings, ['10-Q', '10-Q/A', '6-K']);
    const latestCurrent = findLatestFiling(filings, ['8-K', '8-K/A', '6-K']);
    const latestProxy = filings.find((filing) => filing.form.includes('DEF 14A') || filing.form.includes('PRE 14A')) || null;
    const latestAny = findMostRecentFiling(filings);
    const browseUrl = cik ? `https://www.sec.gov/edgar/browse/?CIK=${encodeURIComponent(cik)}` : null;
    const companyFactsUrl = cik ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json` : null;
    const submissionsUrl = cik ? `https://data.sec.gov/submissions/CIK${cik}.json` : null;
    const disclosureUrl = ticker ? disclosureSearchHref('liquidity, revenue, risk factors', ticker) : null;

    const filingDetail = (filing: FilingEntry | null, fallback: string) => {
      if (!filing) return fallback;
      const period = filing.reportDate ? ` / period ${filing.reportDate}` : '';
      return `${filing.form} filed ${filing.filingDate}${period}`;
    };

    return [
      {
        key: 'sec-browser',
        label: 'Registrant',
        title: company?.name || ticker || 'SEC registrant',
        detail: cik ? `SEC CIK ${cik}` : 'SEC registrant profile',
        url: browseUrl,
        badge: 'SEC',
        tone: 'emerald',
      },
      {
        key: 'company-facts',
        label: 'XBRL Facts',
        title: 'Company Facts JSON',
        detail: 'Raw SEC XBRL facts used for statement values, ratios, and source tags',
        url: companyFactsUrl,
        badge: 'XBRL',
        tone: 'sky',
      },
      {
        key: 'submissions',
        label: 'Filing Feed',
        title: 'Submissions JSON',
        detail: latestAny ? `Latest filing in feed: ${latestAny.form} on ${latestAny.filingDate}` : 'Raw SEC submissions feed',
        url: submissionsUrl,
        badge: 'FEED',
        tone: 'stone',
      },
      {
        key: 'annual-report',
        label: 'Annual Source',
        title: latestAnnual?.primaryDescription || latestAnnual?.primaryDoc || 'Latest annual report',
        detail: filingDetail(latestAnnual, 'No recent annual report found in SEC submissions feed'),
        url: latestAnnual?.documentUrl || null,
        badge: latestAnnual?.form || '10-K',
        tone: 'amber',
      },
      {
        key: 'quarterly-update',
        label: 'Quarterly Source',
        title: latestQuarterly?.primaryDescription || latestQuarterly?.primaryDoc || 'Latest quarterly update',
        detail: filingDetail(latestQuarterly, 'No recent quarterly update found in SEC submissions feed'),
        url: latestQuarterly?.documentUrl || null,
        badge: latestQuarterly?.form || '10-Q',
        tone: 'sky',
      },
      {
        key: 'event-report',
        label: 'Event Trail',
        title: latestCurrent?.primaryDescription || latestCurrent?.primaryDoc || 'Latest current report',
        detail: filingDetail(latestCurrent, 'No recent current report found in SEC submissions feed'),
        url: latestCurrent?.documentUrl || null,
        badge: latestCurrent?.form || '8-K',
        tone: 'violet',
      },
      {
        key: 'proxy',
        label: 'Governance',
        title: latestProxy?.primaryDescription || latestProxy?.primaryDoc || 'Latest proxy statement',
        detail: filingDetail(latestProxy, 'No recent proxy statement found in SEC submissions feed'),
        url: latestProxy?.documentUrl || null,
        badge: latestProxy?.form || 'DEF 14A',
        tone: 'violet',
      },
      {
        key: 'disclosure-search',
        label: 'Narrative Search',
        title: 'Company-focused disclosure search',
        detail: ticker
          ? `Search SEC filings for ${ticker} risk, liquidity, and revenue language`
          : 'Search SEC filings for company-specific disclosure language',
        url: disclosureUrl,
        badge: 'SEARCH',
        tone: 'emerald',
      },
    ] satisfies SourcePackItem[];
  }, [company, filings, ticker]);

  if (!pack.some((item) => item.url)) return null;

  return (
    <div className="mb-6 border-2 border-stone-800 bg-stone-950/50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Analysis Source Pack
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Direct SEC links behind this company page: raw XBRL facts, filings feed, primary reports, events, governance, and disclosure search.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          No sign-in / public SEC sources
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
        {pack.map((item) => (
          <SourcePackCard key={item.key} item={item} />
        ))}
      </div>
    </div>
  );
}

function SourcePackCard({ item }: { item: SourcePackItem }) {
  const toneClass = sourcePackToneClass(item.tone);
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500 font-bold">
            {item.label}
          </div>
          <div className="mt-2 line-clamp-2 text-sm font-black leading-snug text-stone-100">
            {item.title}
          </div>
        </div>
        <span className={`shrink-0 border px-2 py-1 text-[9px] font-black uppercase tracking-[0.12em] ${toneClass.badge}`}>
          {item.badge}
        </span>
      </div>
      <div className="mt-3 text-xs leading-relaxed text-stone-400">
        {item.detail}
      </div>
      <div className={`mt-3 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] font-bold ${item.url ? toneClass.link : 'text-stone-600'}`}>
        {item.url ? 'Open source' : 'Source unavailable'}
        {item.url && <ExternalLink className="w-3 h-3" />}
      </div>
    </>
  );

  if (!item.url) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-4 opacity-75">
        {content}
      </div>
    );
  }

  return (
    <a
      href={item.url}
      target={item.url.startsWith('http') ? '_blank' : undefined}
      rel={item.url.startsWith('http') ? 'noopener noreferrer' : undefined}
      className={`group block min-h-[176px] border-2 bg-stone-900/30 p-4 transition-colors ${toneClass.card}`}
    >
      {content}
    </a>
  );
}

function sourcePackToneClass(tone: SourcePackTone) {
  const classes = {
    emerald: {
      card: 'border-stone-800 hover:border-emerald-500 hover:bg-emerald-500/5',
      badge: 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200',
      link: 'text-emerald-300 group-hover:text-emerald-200',
    },
    sky: {
      card: 'border-stone-800 hover:border-sky-500 hover:bg-sky-500/5',
      badge: 'border-sky-700/60 bg-sky-950/40 text-sky-200',
      link: 'text-sky-300 group-hover:text-sky-200',
    },
    amber: {
      card: 'border-stone-800 hover:border-amber-500 hover:bg-amber-500/5',
      badge: 'border-amber-700/60 bg-amber-950/40 text-amber-200',
      link: 'text-amber-300 group-hover:text-amber-200',
    },
    violet: {
      card: 'border-stone-800 hover:border-violet-500 hover:bg-violet-500/5',
      badge: 'border-violet-700/60 bg-violet-950/40 text-violet-200',
      link: 'text-violet-300 group-hover:text-violet-200',
    },
    stone: {
      card: 'border-stone-800 hover:border-stone-600 hover:bg-stone-800/30',
      badge: 'border-stone-700 bg-stone-950 text-stone-300',
      link: 'text-stone-300 group-hover:text-stone-100',
    },
  };
  return classes[tone];
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
  const [activityReferenceTime] = useState(() => Date.now());

  const activity = useMemo(() => {
    const latestAnnual = findLatestFiling(filings, ['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);
    const latestQuarterly = findLatestFiling(filings, ['10-Q', '10-Q/A', '6-K']);
    const latestCurrent = findLatestFiling(filings, ['8-K', '8-K/A', '6-K']);
    const latestAny = findMostRecentFiling(filings);
    const latestProxy = filings.find((filing) => filing.form.includes('DEF 14A') || filing.form.includes('PRE 14A')) || null;
    const insiderForms = filings.filter((filing) => ['3', '3/A', '4', '4/A', '5', '5/A'].includes(filing.form));
    const cutoff = activityReferenceTime - 90 * 24 * 60 * 60 * 1000;
    const last90Days = filings.filter((filing) => {
      const time = new Date(filing.filingDate).getTime();
      return Number.isFinite(time) && time >= cutoff;
    }).length;
    const eventCutoff = activityReferenceTime - 180 * 24 * 60 * 60 * 1000;
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
      latestAny,
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
  }, [activityReferenceTime, filings]);

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

      <FilingFreshnessPanel
        latestAny={activity.latestAny}
        latestAnnual={activity.latestAnnual}
        latestQuarterly={activity.latestQuarterly}
        latestCurrent={activity.latestCurrent}
      />

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

function FilingFreshnessPanel({
  latestAny,
  latestAnnual,
  latestQuarterly,
  latestCurrent,
}: {
  latestAny?: FilingEntry | null;
  latestAnnual?: FilingEntry | null;
  latestQuarterly?: FilingEntry | null;
  latestCurrent?: FilingEntry | null;
}) {
  const tiles = [
    {
      key: 'latest',
      label: 'Latest Filing Age',
      filing: latestAny,
      fallback: 'No dated filing found in SEC submissions feed',
      goodDays: 45,
      warnDays: 120,
    },
    {
      key: 'annual',
      label: 'Annual Report Age',
      filing: latestAnnual,
      fallback: 'No recent annual report found in SEC submissions feed',
      goodDays: 455,
      warnDays: 550,
    },
    {
      key: 'quarterly',
      label: 'Quarterly Update Age',
      filing: latestQuarterly,
      fallback: 'No recent quarterly update found in SEC submissions feed',
      goodDays: 140,
      warnDays: 220,
    },
    {
      key: 'current',
      label: 'Current Report Age',
      filing: latestCurrent,
      fallback: 'No current report found in SEC submissions feed',
      goodDays: 90,
      warnDays: 180,
    },
  ];

  return (
    <div className="border-t border-stone-800 px-4 py-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            <Clock className="w-3.5 h-3.5 text-sky-400" />
            Reporting Freshness
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Days since the latest source filing in each reporting lane. Each tile opens the SEC document behind the date.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">
          Source: SEC submissions feed
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <FilingFreshnessTile
            key={tile.key}
            label={tile.label}
            filing={tile.filing}
            fallback={tile.fallback}
            goodDays={tile.goodDays}
            warnDays={tile.warnDays}
          />
        ))}
      </div>
    </div>
  );
}

function FilingFreshnessTile({
  label,
  filing,
  fallback,
  goodDays,
  warnDays,
}: {
  label: string;
  filing?: FilingEntry | null;
  fallback: string;
  goodDays: number;
  warnDays: number;
}) {
  const ageDays = filing ? daysSinceFiling(filing) : null;
  const tone = ageDays == null ? 'missing' : ageDays <= goodDays ? 'fresh' : ageDays <= warnDays ? 'watch' : 'stale';
  const toneClass = freshnessToneClass(tone);
  const content = (
    <>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-stone-500 font-bold">
        <FileText className="w-3.5 h-3.5 text-stone-500" />
        {label}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-2xl font-black tabular-nums text-stone-100">
        {ageDays == null ? 'N/A' : formatAgeDays(ageDays)}
        {filing && <ExternalLink className="w-3.5 h-3.5 text-stone-600" />}
      </div>
      <div className="mt-2 text-xs leading-relaxed text-stone-400">
        {filing ? (
          <>
            {filing.form} filed {filing.filingDate}
            {filing.reportDate && <span className="block text-stone-500">Period {filing.reportDate}</span>}
            <span className="block font-mono text-[10px] text-stone-600">{filing.accession}</span>
          </>
        ) : (
          fallback
        )}
      </div>
    </>
  );

  if (!filing?.documentUrl) {
    return (
      <div className={`border-2 bg-stone-950/60 p-4 ${toneClass}`}>
        {content}
      </div>
    );
  }

  return (
    <a
      href={filing.documentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`group block border-2 bg-stone-950/60 p-4 transition-colors hover:border-sky-500 hover:bg-sky-950/20 ${toneClass}`}
      title={`Open ${filing.form} filed ${filing.filingDate} on SEC.gov`}
    >
      {content}
    </a>
  );
}

function daysSinceFiling(filing: FilingEntry) {
  const time = filingDateTime(filing);
  if (!time) return null;
  const days = Math.floor((Date.now() - time) / (24 * 60 * 60 * 1000));
  return Math.max(days, 0);
}

function formatAgeDays(days: number) {
  if (days < 1) return '0d';
  if (days < 365) return `${days}d`;
  return `${(days / 365).toFixed(1)}y`;
}

function freshnessToneClass(tone: 'fresh' | 'watch' | 'stale' | 'missing') {
  if (tone === 'fresh') return 'border-emerald-800/70 text-emerald-300';
  if (tone === 'watch') return 'border-amber-800/70 text-amber-300';
  if (tone === 'stale') return 'border-rose-800/70 text-rose-300';
  return 'border-stone-800 text-stone-400';
}

function disclosureSearchHref(query: string, ticker?: string) {
  const params = new URLSearchParams({ query });
  if (ticker) params.set('focus', ticker);
  return `/disclosures?${params.toString()}`;
}

function DisclosureRiskRadar({
  ticker,
  companyName,
  sicCode,
}: {
  ticker?: string;
  companyName?: string;
  sicCode?: string | number | null;
}) {
  const group = classifyIndustry(sicCode);
  const prompts = useMemo(() => {
    const industryPrompts = INDUSTRY_DISCLOSURE_RISKS[group] || INDUSTRY_DISCLOSURE_RISKS[INDUSTRY_GROUPS.GENERAL] || [];
    return [...industryPrompts, ...BASE_DISCLOSURE_RISKS].slice(0, 6);
  }, [group]);

  if (!ticker || prompts.length === 0) return null;

  return (
    <div className="mb-6 border-2 border-stone-800 bg-stone-950/50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Disclosure Risk Radar
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Industry-aware disclosure themes for {companyName || ticker}, routed into company-focused SEC EDGAR keyword searches.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {industryLabel(group)} / Focus {ticker}
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
        {prompts.map((prompt) => (
          <a
            key={`${ticker}-${prompt.title}`}
            href={disclosureSearchHref(prompt.query, ticker)}
            className="group flex min-h-[156px] flex-col justify-between border-2 border-stone-800 bg-stone-900/30 p-4 transition-colors hover:border-amber-500 hover:bg-amber-500/5"
          >
            <div>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-black tracking-wider text-stone-100 group-hover:text-amber-300 transition-colors">
                    {prompt.title}
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-stone-400">
                    {prompt.detail}
                  </p>
                </div>
                <ExternalLink className="w-3.5 h-3.5 shrink-0 text-stone-600 group-hover:text-amber-300 transition-colors" />
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-2 text-[9px] uppercase tracking-[0.18em] text-stone-600">
                SEC keyword query
              </div>
              <div className="flex flex-wrap gap-1">
                {prompt.query.split(',').slice(0, 4).map((term) => (
                  <span
                    key={`${prompt.title}-${term.trim()}`}
                    className="border border-stone-700 bg-stone-950/70 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-stone-400"
                  >
                    {term.trim()}
                  </span>
                ))}
              </div>
            </div>
          </a>
        ))}
      </div>

      <div className="border-t border-stone-800 px-4 py-3 text-[11px] leading-relaxed text-stone-500">
        These are research paths, not model-generated conclusions. The linked searches use the SEC full-text index with company focus and return direct SEC archive sources for verification.
      </div>
    </div>
  );
}

function PeerContextWorkbench({
  ticker,
  companyName,
  sicCode,
}: {
  ticker?: string;
  companyName?: string;
  sicCode?: string | number | null;
}) {
  const group = classifyIndustry(sicCode);
  const peerGroups = useMemo(() => selectPeerContextGroups(group, ticker), [group, ticker]);
  const disclosureThemes = useMemo(() => {
    const industryPrompts = INDUSTRY_DISCLOSURE_RISKS[group] || INDUSTRY_DISCLOSURE_RISKS[INDUSTRY_GROUPS.GENERAL] || [];
    return [...industryPrompts, ...BASE_DISCLOSURE_RISKS].slice(0, 4);
  }, [group]);

  if (!ticker || (!peerGroups.length && !disclosureThemes.length)) return null;

  return (
    <div className="mb-6 border-2 border-stone-800 bg-stone-950/50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <GitCompare className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Peer Context Workbench
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Jump from {companyName || ticker} into source-linked peer comparisons and company-focused disclosure searches for the {industryLabel(group)} context.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          Compare / Search / Verify
        </div>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Recommended Peer Sets
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {peerGroups.map((groupPreset) => {
              const compareTickers = peerCompareTickers(ticker, groupPreset);
              const includesTicker = groupPreset.tickers.some((peerTicker) => peerTicker.toUpperCase() === ticker.toUpperCase());
              return (
                <a
                  key={groupPreset.id}
                  href={`/compare/${compareTickers.join(',')}`}
                  className="group block min-h-[158px] border-2 border-stone-800 bg-stone-900/30 p-4 transition-colors hover:border-sky-500 hover:bg-sky-500/5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-black tracking-wider text-stone-100 group-hover:text-sky-300 transition-colors">
                        {groupPreset.label}
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-stone-400">
                        {includesTicker
                          ? 'Benchmark against the curated peer set that already includes this ticker.'
                          : 'Benchmark this ticker against the closest curated peer set for its industry.'}
                      </p>
                    </div>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0 text-stone-600 group-hover:text-sky-300 transition-colors" />
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1">
                    {compareTickers.map((peerTicker) => (
                      <span
                        key={`${groupPreset.id}-${peerTicker}`}
                        className={`border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] ${
                          peerTicker.toUpperCase() === ticker.toUpperCase()
                            ? 'border-sky-500 bg-sky-500 text-stone-950 font-black'
                            : 'border-stone-700 bg-stone-950/70 text-stone-400'
                        }`}
                      >
                        {peerTicker}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 text-[10px] uppercase tracking-[0.14em] font-bold text-sky-300 group-hover:text-sky-200">
                    Open source-linked comparison
                  </div>
                </a>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Peer Research Searches
          </div>
          <div className="space-y-2">
            {disclosureThemes.map((theme) => (
              <a
                key={`${ticker}-${theme.title}-peer-workbench`}
                href={disclosureSearchHref(theme.query, ticker)}
                className="group block border border-stone-800 bg-stone-900/30 px-3 py-3 transition-colors hover:border-emerald-500 hover:bg-emerald-500/5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-black text-stone-100 group-hover:text-emerald-300 transition-colors">
                      {theme.title}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-stone-500">
                      {theme.detail}
                    </p>
                  </div>
                  <Search className="w-3.5 h-3.5 shrink-0 text-stone-600 group-hover:text-emerald-300 transition-colors" />
                </div>
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-stone-800 px-4 py-3 text-[11px] leading-relaxed text-stone-500">
        Peer comparison pages use SEC XBRL Company Facts with linked source tags. Disclosure searches return SEC archive links and should be read as source discovery, not conclusions.
      </div>
    </div>
  );
}

function selectPeerContextGroups(group: string, ticker?: string): PeerGroupPreset[] {
  const upperTicker = ticker?.toUpperCase();
  const byId = new Map(PEER_GROUP_PRESETS.map((preset) => [preset.id, preset]));
  const selected: PeerGroupPreset[] = [];

  const add = (preset?: PeerGroupPreset) => {
    if (!preset || selected.some((item) => item.id === preset.id)) return;
    selected.push(preset);
  };

  if (upperTicker) {
    PEER_GROUP_PRESETS
      .filter((preset) => preset.tickers.some((peerTicker) => peerTicker.toUpperCase() === upperTicker))
      .forEach(add);
  }

  (INDUSTRY_PEER_GROUP_IDS[group] || INDUSTRY_PEER_GROUP_IDS[INDUSTRY_GROUPS.GENERAL] || [])
    .map((id) => byId.get(id))
    .forEach(add);

  return selected.slice(0, 4);
}

function peerCompareTickers(ticker: string, groupPreset: PeerGroupPreset) {
  const upperTicker = ticker.toUpperCase();
  const tickers = groupPreset.tickers.map((peerTicker) => peerTicker.toUpperCase());
  if (tickers.includes(upperTicker)) return tickers.slice(0, 5);
  return [upperTicker, ...tickers.filter((peerTicker) => peerTicker !== upperTicker)].slice(0, 5);
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

interface XbrlConceptAuditRow {
  tag: string;
  label: string;
  count: number;
  latestFiled: string;
  latestEnd: string;
  units: string[];
  url: string | null;
}

interface XbrlFilingAuditRow {
  accession: string;
  filed: string;
  count: number;
  concepts: string[];
  url: string | null;
}

interface XbrlSourceAudit {
  sourceLinkCount: number;
  sourceFactCount: number;
  conceptCount: number;
  filingCount: number;
  latestFiled: string;
  concepts: XbrlConceptAuditRow[];
  filings: XbrlFilingAuditRow[];
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

  const sourceAudit = useMemo(() => buildXbrlSourceAudit(coverage.rows, cik), [coverage.rows, cik]);

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

      {sourceAudit.sourceLinkCount > 0 && (
        <div className="border-t border-stone-800 px-4 py-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
                XBRL Source Audit
              </div>
              <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-stone-500">
                Filing accessions and SEC XBRL concepts behind the visible statement and ratio values.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-right sm:grid-cols-4">
              <div className="border border-stone-800 bg-stone-950/70 px-3 py-2">
                <div className="text-lg font-black tabular-nums text-stone-100">{sourceAudit.conceptCount}</div>
                <div className="text-[9px] uppercase tracking-[0.16em] text-stone-600">Concepts</div>
              </div>
              <div className="border border-stone-800 bg-stone-950/70 px-3 py-2">
                <div className="text-lg font-black tabular-nums text-stone-100">{sourceAudit.filingCount}</div>
                <div className="text-[9px] uppercase tracking-[0.16em] text-stone-600">Filings</div>
              </div>
              <div className="border border-stone-800 bg-stone-950/70 px-3 py-2">
                <div className="text-lg font-black tabular-nums text-stone-100">{sourceAudit.sourceFactCount}</div>
                <div className="text-[9px] uppercase tracking-[0.16em] text-stone-600">Facts</div>
              </div>
              <div className="border border-stone-800 bg-stone-950/70 px-3 py-2">
                <div className="text-sm font-black tabular-nums text-stone-100">{sourceAudit.latestFiled || 'N/A'}</div>
                <div className="text-[9px] uppercase tracking-[0.16em] text-stone-600">Latest</div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.65fr)]">
            <div className="border border-stone-800 bg-stone-950/40">
              <div className="border-b border-stone-800 px-3 py-2 text-[10px] uppercase tracking-[0.18em] font-bold text-stone-500">
                Most Used Concepts
              </div>
              <div className="divide-y divide-stone-800/80">
                {sourceAudit.concepts.map((concept) => (
                  <SourceConceptAuditRow key={concept.tag} concept={concept} />
                ))}
              </div>
            </div>
            <div className="border border-stone-800 bg-stone-950/40">
              <div className="border-b border-stone-800 px-3 py-2 text-[10px] uppercase tracking-[0.18em] font-bold text-stone-500">
                Recent Source Filings
              </div>
              <div className="divide-y divide-stone-800/80">
                {sourceAudit.filings.map((filing) => (
                  <SourceFilingAuditRow key={filing.accession} filing={filing} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

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

function SourceConceptAuditRow({ concept }: { concept: XbrlConceptAuditRow }) {
  const content = (
    <>
      <div className="min-w-0">
        <div className="truncate text-xs font-bold text-stone-200">{concept.label}</div>
        <div className="mt-1 truncate font-mono text-[10px] text-stone-600">{concept.tag}</div>
      </div>
      <div className="text-right">
        <div className="text-xs font-black tabular-nums text-amber-300">{concept.count}</div>
        <div className="mt-1 text-[10px] text-stone-500">
          Filed {concept.latestFiled || 'N/A'}
        </div>
      </div>
      <div className="col-span-2 flex flex-wrap items-center gap-2 text-[10px] text-stone-500">
        <span>Period {concept.latestEnd || 'N/A'}</span>
        {concept.units.slice(0, 3).map((unit) => (
          <span key={unit} className="font-mono text-stone-600">{unit}</span>
        ))}
      </div>
    </>
  );

  if (!concept.url) {
    return <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-3 py-3">{content}</div>;
  }

  return (
    <a
      href={concept.url}
      target="_blank"
      rel="noopener noreferrer"
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-3 py-3 hover:bg-amber-500/5 transition-colors"
    >
      {content}
    </a>
  );
}

function SourceFilingAuditRow({ filing }: { filing: XbrlFilingAuditRow }) {
  const content = (
    <>
      <div className="min-w-0">
        <div className="truncate font-mono text-[11px] font-bold text-stone-200">{filing.accession}</div>
        <div className="mt-1 text-[10px] text-stone-500">Filed {filing.filed || 'N/A'}</div>
      </div>
      <div className="text-right">
        <div className="text-xs font-black tabular-nums text-emerald-300">{filing.count}</div>
        <div className="mt-1 text-[10px] text-stone-500">
          {filing.concepts.length} concepts
        </div>
      </div>
      {filing.concepts.length > 0 && (
        <div className="col-span-2 truncate font-mono text-[10px] text-stone-600">
          {filing.concepts.slice(0, 4).join(', ')}
        </div>
      )}
    </>
  );

  if (!filing.url) {
    return <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-3 py-3">{content}</div>;
  }

  return (
    <a
      href={filing.url}
      target="_blank"
      rel="noopener noreferrer"
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-3 py-3 hover:bg-emerald-500/5 transition-colors"
    >
      {content}
    </a>
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

function buildXbrlSourceAudit(rows: any[], cik?: string): XbrlSourceAudit {
  const conceptMap = new Map<string, {
    tag: string;
    label: string;
    count: number;
    latestFiled: string;
    latestEnd: string;
    units: Set<string>;
    source: LabeledSourceFact;
  }>();
  const filingMap = new Map<string, {
    accession: string;
    filed: string;
    count: number;
    concepts: Set<string>;
  }>();
  const sourceFacts = new Set<string>();
  let sourceLinkCount = 0;
  let latestFiled = '';

  rows.forEach((row) => {
    const values = Array.isArray(row?.values) ? row.values : [];
    values.forEach((point: MetricPoint) => {
      if (point?.value == null) return;
      getPointSources(point).forEach((source) => {
        if (!source?.tag) return;

        sourceLinkCount += 1;
        const label = source.label || row?.label || source.tag;
        const factKey = `${source.tag}:${source.unit || ''}:${source.end || ''}:${source.filed || ''}:${source.accession || ''}`;
        sourceFacts.add(factKey);
        if (isLaterDate(source.filed, latestFiled)) latestFiled = source.filed;

        const concept = conceptMap.get(source.tag) || {
          tag: source.tag,
          label,
          count: 0,
          latestFiled: '',
          latestEnd: '',
          units: new Set<string>(),
          source,
        };
        concept.count += 1;
        if (source.unit) concept.units.add(source.unit);
        if (isLaterDate(source.filed, concept.latestFiled)) {
          concept.latestFiled = source.filed;
          concept.latestEnd = source.end || concept.latestEnd;
          concept.source = source;
        }
        conceptMap.set(source.tag, concept);

        if (source.accession) {
          const filing = filingMap.get(source.accession) || {
            accession: source.accession,
            filed: source.filed || '',
            count: 0,
            concepts: new Set<string>(),
          };
          filing.count += 1;
          filing.concepts.add(source.tag);
          if (isLaterDate(source.filed, filing.filed)) filing.filed = source.filed;
          filingMap.set(source.accession, filing);
        }
      });
    });
  });

  const concepts = Array.from(conceptMap.values())
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 8)
    .map((concept) => ({
      tag: concept.tag,
      label: concept.label,
      count: concept.count,
      latestFiled: concept.latestFiled,
      latestEnd: concept.latestEnd,
      units: Array.from(concept.units),
      url: cik ? buildSourceUrl(cik, concept.source) : null,
    }));

  const filings = Array.from(filingMap.values())
    .sort((a, b) => sourceDateTime(b.filed) - sourceDateTime(a.filed) || b.count - a.count)
    .slice(0, 5)
    .map((filing) => ({
      accession: filing.accession,
      filed: filing.filed,
      count: filing.count,
      concepts: Array.from(filing.concepts).sort(),
      url: buildFilingArchiveUrl(cik, filing.accession),
    }));

  return {
    sourceLinkCount,
    sourceFactCount: sourceFacts.size,
    conceptCount: conceptMap.size,
    filingCount: filingMap.size,
    latestFiled,
    concepts,
    filings,
  };
}

function hasPointSource(point?: MetricPoint | null) {
  return Boolean(
    point?.source?.tag
      || point?.sources?.some((source) => source?.tag)
  );
}

function getPointSources(point?: MetricPoint | null): LabeledSourceFact[] {
  const sources = point?.sources?.length ? point.sources : point?.source ? [point.source] : [];
  return sources.filter((source): source is LabeledSourceFact => Boolean(source?.tag));
}

function findLatestFiling(filings: FilingEntry[], forms: string[]) {
  return filings.find((filing) => forms.includes(filing.form)) || null;
}

function pctText(numerator: number, denominator: number) {
  if (!denominator) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function sourceDateTime(value?: string) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function isLaterDate(candidate?: string, current?: string) {
  return sourceDateTime(candidate) > sourceDateTime(current);
}

function buildFilingArchiveUrl(cik?: string, accession?: string) {
  const cikNumber = Number.parseInt(String(cik || ''), 10);
  if (!Number.isFinite(cikNumber) || !accession) return null;
  return `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accession.replace(/-/g, '')}/`;
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

interface InflectionSignal {
  key: string;
  label: string;
  changeLabel: string;
  latestValue: number;
  priorValue: number;
  latestLabel: string;
  priorLabel: string;
  format: string;
  direction: 'up' | 'down';
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  detail: string;
  query: string;
  sources: SnapshotSource[];
  score: number;
}

function FinancialInflectionMonitor({
  statementRows,
  ratioRows,
  periods,
  cik,
  ticker,
}: {
  statementRows: any[];
  ratioRows: any[];
  periods: any[];
  cik?: string;
  ticker?: string;
}) {
  const signals = useMemo(() => {
    if (!periods?.length || periods.length < 2) return [] as InflectionSignal[];
    return buildInflectionSignals([...statementRows, ...ratioRows], periods).slice(0, 6);
  }, [statementRows, ratioRows, periods]);

  if (!signals.length) return null;

  return (
    <div className="mb-6 border-2 border-stone-800 bg-stone-950/50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Financial Inflection Monitor
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Largest latest annual changes across source-linked statement and ratio rows, ranked by absolute movement.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {periodLabel(periods[0])} vs {periodLabel(periods[1])}
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
        {signals.map((signal) => (
          <InflectionSignalCard key={signal.key} signal={signal} cik={cik} ticker={ticker} />
        ))}
      </div>

      <div className="border-t border-stone-800 px-4 py-3 text-[11px] leading-relaxed text-stone-500">
        The monitor only displays changes where both compared periods have linked SEC XBRL source facts. Disclosure links open company-focused EDGAR searches for the narrative behind the movement.
      </div>
    </div>
  );
}

function InflectionSignalCard({
  signal,
  cik,
  ticker,
}: {
  signal: InflectionSignal;
  cik?: string;
  ticker?: string;
}) {
  const toneClasses = {
    good: 'border-emerald-800/70 bg-emerald-950/10',
    warn: 'border-amber-800/70 bg-amber-950/10',
    bad: 'border-rose-800/70 bg-rose-950/10',
    neutral: 'border-sky-800/70 bg-sky-950/10',
  }[signal.tone];
  const directionText = signal.direction === 'up' ? 'Increased' : 'Decreased';

  return (
    <div className={`min-h-[258px] border-2 p-4 flex flex-col justify-between ${toneClasses}`}>
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[10px] uppercase tracking-[0.18em] font-bold text-stone-500">
              {signal.label}
            </div>
            <div className="mt-2 text-2xl font-black tabular-nums text-stone-100">
              {signal.changeLabel}
            </div>
          </div>
          <span className="shrink-0 border border-stone-700 bg-stone-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-stone-400">
            {directionText}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="border border-stone-800 bg-stone-950/60 p-2">
            <div className="text-[9px] uppercase tracking-[0.16em] text-stone-600">{signal.latestLabel}</div>
            <div className="mt-1 text-sm font-black tabular-nums text-stone-200">
              {formatValue(signal.latestValue, signal.format)}
            </div>
          </div>
          <div className="border border-stone-800 bg-stone-950/60 p-2">
            <div className="text-[9px] uppercase tracking-[0.16em] text-stone-600">{signal.priorLabel}</div>
            <div className="mt-1 text-sm font-black tabular-nums text-stone-400">
              {formatValue(signal.priorValue, signal.format)}
            </div>
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-stone-400">
          {signal.detail}
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {signal.sources.slice(0, 5).map((source) => (
            <SourceChip key={`${signal.key}-${source.label}-${source.point?.source?.tag}-${source.point?.source?.end}`} source={source} cik={cik} />
          ))}
        </div>
        <a
          href={disclosureSearchHref(signal.query, ticker)}
          className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] font-bold text-amber-300 hover:text-amber-200 transition-colors"
        >
          Search the filing narrative
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

function buildInflectionSignals(rows: any[], periods: any[]): InflectionSignal[] {
  const latestPeriod = periods[0];
  const priorPeriod = periods[1];
  const latestLabel = latestPeriod ? periodLabel(latestPeriod) : 'Latest';
  const priorLabel = priorPeriod ? periodLabel(priorPeriod) : 'Prior';
  const seen = new Set<string>();
  const signals: InflectionSignal[] = [];

  rows.forEach((row) => {
    if (!row?.label || !Array.isArray(row.values) || row.values.length < 2) return;
    const label = String(row.label);
    if (seen.has(label)) return;
    seen.add(label);

    const latestPoint = row.values[0] as MetricPoint | null;
    const priorPoint = row.values[1] as MetricPoint | null;
    const latestValue = numericPointValue(latestPoint);
    const priorValue = numericPointValue(priorPoint);
    if (latestValue == null || priorValue == null || latestValue === priorValue) return;
    if (!hasPointSource(latestPoint) || !hasPointSource(priorPoint)) return;

    const format = row.format || 'currency';
    const delta = latestValue - priorValue;
    const pctChange = priorValue !== 0 ? (delta / Math.abs(priorValue)) * 100 : null;
    const score = inflectionScore(delta, pctChange, format);
    if (score == null || score < 1) return;

    const sources = uniqueSnapshotSources([
      ...snapshotSourcesFromPoint(latestLabel, latestPoint),
      ...snapshotSourcesFromPoint(priorLabel, priorPoint),
    ]);
    if (!sources.length) return;

    signals.push({
      key: `${label}-${latestPoint?.source?.tag || sources[0]?.point?.source?.tag || signals.length}`,
      label,
      changeLabel: formatInflectionChange(delta, pctChange, format),
      latestValue,
      priorValue,
      latestLabel,
      priorLabel,
      format,
      direction: delta >= 0 ? 'up' : 'down',
      tone: inflectionTone(label, delta),
      detail: inflectionDetail(label, delta, latestLabel, priorLabel),
      query: inflectionDisclosureQuery(label),
      sources,
      score,
    });
  });

  return signals.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

function numericPointValue(point?: MetricPoint | null) {
  return typeof point?.value === 'number' && Number.isFinite(point.value) ? point.value : null;
}

function inflectionScore(delta: number, pctChange: number | null, format: string) {
  if (format === 'percent') return Math.abs(delta);
  if (format === 'decimal') return Math.abs(delta) * 25;
  if (pctChange == null || !Number.isFinite(pctChange)) return null;
  return Math.abs(pctChange);
}

function formatInflectionChange(delta: number, pctChange: number | null, format: string) {
  const sign = delta > 0 ? '+' : '';
  if (format === 'percent') return `${sign}${delta.toFixed(1)} pts`;
  if (format === 'decimal') return `${sign}${delta.toFixed(2)}`;
  if (pctChange == null || !Number.isFinite(pctChange)) return `${sign}${formatValue(delta, format)}`;
  return `${pctChange > 0 ? '+' : ''}${pctChange.toFixed(1)}%`;
}

function inflectionTone(label: string, delta: number): 'good' | 'warn' | 'bad' | 'neutral' {
  const lower = label.toLowerCase();
  const lowerBetter = /(debt|liabilit|expense|cost|days|ratio|inventory|receivable|capex|capital expenditures|diluted shares)/i.test(lower)
    && !/(current ratio|combined ratio|cash returned|asset turnover|inventory turnover|return)/i.test(lower);
  const higherBetter = /(revenue|gross profit|operating income|net income|cash flow|free cash flow|margin|return|roe|roa|cash|equity|asset turnover|inventory turnover|eps)/i.test(lower);
  if (lowerBetter) return delta > 0 ? 'bad' : 'good';
  if (higherBetter) return delta > 0 ? 'good' : 'bad';
  return 'neutral';
}

function inflectionDetail(label: string, delta: number, latestLabel: string, priorLabel: string) {
  const direction = delta >= 0 ? 'moved higher' : 'moved lower';
  return `${label} ${direction} from ${priorLabel} to ${latestLabel}. Use the linked SEC facts for the numeric trail and the search link for MD&A, risk-factor, or footnote context.`;
}

function inflectionDisclosureQuery(label: string) {
  const lower = label.toLowerCase();
  if (/revenue|sales/.test(lower)) return 'revenue, demand, pricing, customers, competition';
  if (/gross|cost of revenue|margin/.test(lower)) return 'gross margin, pricing, cost inflation, supply chain';
  if (/operating income|operating expense|sga|r&d/.test(lower)) return 'operating expenses, restructuring, margin pressure, investment';
  if (/net income|tax|pretax|eps/.test(lower)) return 'net income, tax, impairment, litigation, earnings';
  if (/cash flow|free cash flow|capex|capital/.test(lower)) return 'cash flow, capital expenditures, working capital, liquidity';
  if (/debt|liabilit|current ratio/.test(lower)) return 'debt maturities, refinancing, covenant, liquidity';
  if (/inventory|receivable|payable|working capital|days/.test(lower)) return 'inventory, receivables, working capital, supply chain, demand';
  if (/goodwill|intangible|asset/.test(lower)) return 'impairment, asset value, acquisitions, goodwill';
  return `${label}, management discussion, risk factors`;
}

function snapshotSourcesFromPoint(prefix: string, point?: MetricPoint | null): SnapshotSource[] {
  return getPointSources(point).map((source) => ({
    label: `${prefix} ${source.label || source.tag}`,
    point: {
      period: point?.period,
      value: point?.value ?? null,
      source,
    },
  }));
}

function uniqueSnapshotSources(sources: SnapshotSource[]) {
  const seen = new Set<string>();
  return sources.filter((item) => {
    const source = item.point?.source;
    if (!source?.tag) return false;
    const key = `${item.label}:${source.tag}:${source.end}:${source.accession || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface IndustryPlaybookCard {
  key: string;
  label: string;
  value: number;
  format: string;
  question: string;
  detail: string;
  query: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  sources: SnapshotSource[];
}

type IndustryPlaybookDraftCard = Omit<IndustryPlaybookCard, 'value' | 'sources'> & {
  value: number | null;
  sources: SnapshotSource[];
};

function IndustryResearchPlaybook({
  facts,
  periods,
  sicCode,
  cik,
  ticker,
  companyName,
}: {
  facts: any;
  periods: any[];
  sicCode?: string | number | null;
  cik?: string;
  ticker?: string;
  companyName?: string;
}) {
  const { cards, latestPeriod, group } = useMemo(() => {
    const latestPeriod = periods[0];
    const priorPeriod = periods[1];
    const group = classifyIndustry(sicCode);
    if (!facts || !latestPeriod) {
      return { cards: [] as IndustryPlaybookCard[], latestPeriod, group };
    }

    const metric = (key: string, label: string, format = 'currency', period = latestPeriod): MetricPoint | null => {
      const row = buildMetricRow(facts, key, label, [period], format, group as any);
      return row.values?.[0] || null;
    };
    const value = (point: MetricPoint | null) => (
      typeof point?.value === 'number' && Number.isFinite(point.value) ? point.value : null
    );
    const magnitude = (point: MetricPoint | null) => {
      const v = value(point);
      return v == null ? null : Math.abs(v);
    };
    const pct = (numerator: number | null, denominator: number | null) => (
      numerator != null && denominator != null && denominator !== 0 ? (numerator / denominator) * 100 : null
    );
    const ratio = (numerator: number | null, denominator: number | null) => (
      numerator != null && denominator != null && denominator !== 0 ? numerator / denominator : null
    );
    const pctChange = (current: number | null, prior: number | null) => (
      current != null && prior != null && prior !== 0 ? ((current - prior) / Math.abs(prior)) * 100 : null
    );
    const sources = (items: Array<[string, MetricPoint | null]>) => {
      const seen = new Set<string>();
      return items
        .map(([label, point]) => ({ label, point }))
        .filter((item) => {
          if (!item.point?.source?.tag) return false;
          const key = `${item.label}:${item.point.source.tag}:${item.point.source.end}:${item.point.source.accession || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }) as SnapshotSource[];
    };

    const rows = {
      revenue: metric('revenue', 'Revenue'),
      priorRevenue: priorPeriod ? metric('revenue', 'Revenue', 'currency', priorPeriod) : null,
      grossProfit: metric('grossProfit', 'Gross Profit'),
      costOfRevenue: metric('costOfRevenue', 'Cost of Revenue'),
      operatingIncome: metric('operatingIncome', 'Operating Income'),
      netIncome: metric('netIncome', 'Net Income'),
      operatingCashFlow: metric('operatingCashFlow', 'Operating Cash Flow'),
      capex: metric('capex', 'Capital Expenditures'),
      rnd: metric('rnd', 'Research and Development'),
      inventory: metric('inventory', 'Inventory'),
      cash: metric('cash', 'Cash and Equivalents'),
      shortTermInvestments: metric('shortTermInvestments', 'Short-term Investments'),
      totalAssets: metric('totalAssets', 'Total Assets'),
      totalLiabilities: metric('totalLiabilities', 'Total Liabilities'),
      stockholdersEquity: metric('stockholdersEquity', "Stockholders' Equity"),
      shortTermDebt: metric('shortTermDebt', 'Short-term Debt'),
      longTermDebt: metric('longTermDebt', 'Long-term Debt'),
      loans: metric('loans', 'Loans'),
      deposits: metric('deposits', 'Deposits'),
      provisionForLoanLoss: metric('provisionForLoanLoss', 'Provision for Loan Losses'),
      premiumsEarned: metric('premiumsEarned', 'Premiums Earned'),
      lossesIncurred: metric('lossesIncurred', 'Losses Incurred'),
      underwritingExpenses: metric('underwritingExpenses', 'Underwriting Expenses'),
      investmentIncome: metric('investmentIncome', 'Investment Income'),
    };

    const revenue = value(rows.revenue);
    const priorRevenue = value(rows.priorRevenue);
    const grossProfit = value(rows.grossProfit);
    const costOfRevenue = magnitude(rows.costOfRevenue);
    const operatingIncome = value(rows.operatingIncome);
    const operatingCashFlow = value(rows.operatingCashFlow);
    const capex = magnitude(rows.capex);
    const rnd = magnitude(rows.rnd);
    const inventory = value(rows.inventory);
    const cash = value(rows.cash);
    const shortTermInvestments = value(rows.shortTermInvestments);
    const totalAssets = value(rows.totalAssets);
    const totalLiabilities = value(rows.totalLiabilities);
    const equity = value(rows.stockholdersEquity);
    const loans = value(rows.loans);
    const deposits = value(rows.deposits);
    const provision = magnitude(rows.provisionForLoanLoss);
    const premiums = value(rows.premiumsEarned);
    const losses = magnitude(rows.lossesIncurred);
    const underwritingExpenses = magnitude(rows.underwritingExpenses);
    const investmentIncome = value(rows.investmentIncome);
    const debt = (value(rows.shortTermDebt) != null || value(rows.longTermDebt) != null)
      ? (value(rows.shortTermDebt) || 0) + (value(rows.longTermDebt) || 0)
      : null;
    const fcf = operatingCashFlow != null && capex != null ? operatingCashFlow - capex : null;
    const cashAndInvestments = cash != null || shortTermInvestments != null ? (cash || 0) + (shortTermInvestments || 0) : null;
    const revenueGrowth = pctChange(revenue, priorRevenue);
    const grossMargin = pct(grossProfit, revenue);
    const operatingMargin = pct(operatingIncome, revenue);
    const fcfMargin = pct(fcf, revenue);
    const rndIntensity = pct(rnd, revenue);
    const capexRevenue = pct(capex, revenue);
    const liabilitiesAssets = pct(totalLiabilities, totalAssets);
    const debtEquity = pct(debt, equity);
    const equityAssets = pct(equity, totalAssets);
    const inventoryRevenue = pct(inventory, revenue);
    const inventoryTurnover = ratio(costOfRevenue, inventory);
    const loansDeposits = pct(loans, deposits);
    const provisionLoans = pct(provision, loans);
    const combinedRatio = pct(
      losses != null || underwritingExpenses != null ? (losses || 0) + (underwritingExpenses || 0) : null,
      premiums,
    );
    const investmentBase = shortTermInvestments || totalAssets;
    const investmentYield = pct(investmentIncome, investmentBase);
    const cfoCapex = ratio(operatingCashFlow, capex);
    const cashAssets = pct(cashAndInvestments, totalAssets);
    const ruleOf40 = revenueGrowth != null && fcfMargin != null ? revenueGrowth + fcfMargin : null;
    const cards: IndustryPlaybookCard[] = [];
    const addCard = (card: IndustryPlaybookDraftCard) => {
      if (card.value == null || !Number.isFinite(card.value)) return;
      const cardSources = card.sources.filter((source) => source.point?.source?.tag);
      if (!cardSources.length) return;
      cards.push({ ...card, value: card.value, sources: cardSources });
    };

    const commonCards = () => {
      addCard({
        key: 'operating-margin',
        label: 'Operating Margin',
        value: operatingMargin,
        format: 'percent',
        question: 'Is profitability widening or compressing?',
        detail: 'Operating income divided by revenue for the latest annual period.',
        query: 'pricing, operating expenses, margin pressure, inflation',
        tone: (operatingMargin || 0) >= 20 ? 'good' : (operatingMargin || 0) >= 8 ? 'warn' : 'bad',
        sources: sources([['Operating Income', rows.operatingIncome], ['Revenue', rows.revenue]]),
      });
      addCard({
        key: 'fcf-margin',
        label: 'FCF Margin',
        value: fcfMargin,
        format: 'percent',
        question: 'Does earnings power convert into cash?',
        detail: `Free cash flow: ${formatValue(fcf, 'currency')}.`,
        query: 'cash flow, capital expenditures, working capital, liquidity',
        tone: (fcfMargin || 0) >= 15 ? 'good' : (fcfMargin || 0) >= 0 ? 'warn' : 'bad',
        sources: sources([['Operating Cash Flow', rows.operatingCashFlow], ['Capex', rows.capex], ['Revenue', rows.revenue]]),
      });
      addCard({
        key: 'liabilities-assets',
        label: 'Liabilities / Assets',
        value: liabilitiesAssets,
        format: 'percent',
        question: 'How leveraged is the reported asset base?',
        detail: 'Total liabilities divided by total assets.',
        query: 'debt, liquidity, covenant, capital resources',
        tone: (liabilitiesAssets || 0) <= 60 ? 'good' : (liabilitiesAssets || 0) <= 80 ? 'warn' : 'bad',
        sources: sources([['Liabilities', rows.totalLiabilities], ['Assets', rows.totalAssets]]),
      });
    };

    switch (group) {
      case INDUSTRY_GROUPS.BANKING:
        addCard({
          key: 'equity-assets',
          label: 'Equity / Assets',
          value: equityAssets,
          format: 'percent',
          question: 'How much capital cushions the balance sheet?',
          detail: 'Stockholders equity divided by total assets.',
          query: 'capital ratios, credit losses, allowance, regulatory capital',
          tone: (equityAssets || 0) >= 9 ? 'good' : (equityAssets || 0) >= 6 ? 'warn' : 'bad',
          sources: sources([["Stockholders' Equity", rows.stockholdersEquity], ['Assets', rows.totalAssets]]),
        });
        addCard({
          key: 'loans-deposits',
          label: 'Loans / Deposits',
          value: loansDeposits,
          format: 'percent',
          question: 'Is loan growth leaning heavily on deposit funding?',
          detail: 'Reported loans divided by reported deposits.',
          query: 'deposits, uninsured deposits, funding, loan growth',
          tone: (loansDeposits || 0) <= 90 ? 'good' : (loansDeposits || 0) <= 110 ? 'warn' : 'bad',
          sources: sources([['Loans', rows.loans], ['Deposits', rows.deposits]]),
        });
        addCard({
          key: 'provision-loans',
          label: 'Provision / Loans',
          value: provisionLoans,
          format: 'percent',
          question: 'Are credit costs material relative to loans?',
          detail: 'Loan-loss provision divided by reported loans.',
          query: 'nonperforming loans, allowance for credit losses, charge-offs',
          tone: (provisionLoans || 0) <= 1 ? 'good' : (provisionLoans || 0) <= 2.5 ? 'warn' : 'bad',
          sources: sources([['Provision', rows.provisionForLoanLoss], ['Loans', rows.loans]]),
        });
        break;
      case INDUSTRY_GROUPS.INSURANCE:
        addCard({
          key: 'combined-ratio',
          label: 'Combined Ratio',
          value: combinedRatio,
          format: 'percent',
          question: 'Is underwriting profitable before investment income?',
          detail: 'Losses plus underwriting expenses divided by earned premiums.',
          query: 'loss ratio, combined ratio, catastrophe losses, reserve development',
          tone: (combinedRatio || 0) < 95 ? 'good' : (combinedRatio || 0) <= 105 ? 'warn' : 'bad',
          sources: sources([['Losses', rows.lossesIncurred], ['Expenses', rows.underwritingExpenses], ['Premiums', rows.premiumsEarned]]),
        });
        addCard({
          key: 'investment-yield',
          label: 'Investment Yield',
          value: investmentYield,
          format: 'percent',
          question: 'How much yield is the portfolio producing?',
          detail: 'Net investment income divided by short-term investments where available, otherwise assets.',
          query: 'investment portfolio, unrealized losses, credit impairments',
          tone: (investmentYield || 0) >= 4 ? 'good' : (investmentYield || 0) >= 2 ? 'warn' : 'neutral',
          sources: sources([['Investment Income', rows.investmentIncome], ['Investment Base', rows.shortTermInvestments || rows.totalAssets]]),
        });
        addCard({
          key: 'equity-assets',
          label: 'Equity / Assets',
          value: equityAssets,
          format: 'percent',
          question: 'How much balance-sheet cushion backs policy risk?',
          detail: 'Stockholders equity divided by total assets.',
          query: 'capital adequacy, reinsurance, reserve adequacy',
          tone: (equityAssets || 0) >= 15 ? 'good' : (equityAssets || 0) >= 8 ? 'warn' : 'bad',
          sources: sources([["Stockholders' Equity", rows.stockholdersEquity], ['Assets', rows.totalAssets]]),
        });
        break;
      case INDUSTRY_GROUPS.TECH:
        addCard({
          key: 'rnd-intensity',
          label: 'R&D / Revenue',
          value: rndIntensity,
          format: 'percent',
          question: 'How much revenue is reinvested into product and platform?',
          detail: 'Research and development expense divided by revenue.',
          query: 'research and development, artificial intelligence, platform investment',
          tone: (rndIntensity || 0) >= 8 ? 'good' : (rndIntensity || 0) >= 3 ? 'neutral' : 'warn',
          sources: sources([['R&D', rows.rnd], ['Revenue', rows.revenue]]),
        });
        addCard({
          key: 'rule-of-40',
          label: 'Growth + FCF Margin',
          value: ruleOf40,
          format: 'percent',
          question: 'Is growth balanced with free-cash-flow discipline?',
          detail: `Revenue growth: ${formatValue(revenueGrowth, 'percent')}; FCF margin: ${formatValue(fcfMargin, 'percent')}.`,
          query: 'growth, revenue, cash flow, capital expenditures',
          tone: (ruleOf40 || 0) >= 40 ? 'good' : (ruleOf40 || 0) >= 20 ? 'warn' : 'bad',
          sources: sources([['Revenue', rows.revenue], ['Prior Revenue', rows.priorRevenue], ['CFO', rows.operatingCashFlow], ['Capex', rows.capex]]),
        });
        commonCards();
        break;
      case INDUSTRY_GROUPS.RETAIL:
        addCard({
          key: 'gross-margin',
          label: 'Gross Margin',
          value: grossMargin,
          format: 'percent',
          question: 'Is merchandise profitability holding up?',
          detail: 'Gross profit divided by revenue.',
          query: 'gross margin, markdowns, consumer demand, inventory',
          tone: (grossMargin || 0) >= 35 ? 'good' : (grossMargin || 0) >= 20 ? 'warn' : 'bad',
          sources: sources([['Gross Profit', rows.grossProfit], ['Revenue', rows.revenue]]),
        });
        addCard({
          key: 'inventory-revenue',
          label: 'Inventory / Revenue',
          value: inventoryRevenue,
          format: 'percent',
          question: 'Is inventory building faster than sales?',
          detail: 'Inventory divided by annual revenue.',
          query: 'inventory, markdowns, supply chain, consumer demand',
          tone: (inventoryRevenue || 0) <= 15 ? 'good' : (inventoryRevenue || 0) <= 25 ? 'warn' : 'bad',
          sources: sources([['Inventory', rows.inventory], ['Revenue', rows.revenue]]),
        });
        commonCards();
        break;
      case INDUSTRY_GROUPS.PHARMA:
        addCard({
          key: 'rnd-intensity',
          label: 'R&D / Revenue',
          value: rndIntensity,
          format: 'percent',
          question: 'How much revenue funds pipeline development?',
          detail: 'Research and development expense divided by revenue.',
          query: 'clinical trial, FDA, regulatory approval, research and development',
          tone: (rndIntensity || 0) >= 15 ? 'good' : (rndIntensity || 0) >= 8 ? 'neutral' : 'warn',
          sources: sources([['R&D', rows.rnd], ['Revenue', rows.revenue]]),
        });
        addCard({
          key: 'cash-assets',
          label: 'Cash + Investments / Assets',
          value: cashAssets,
          format: 'percent',
          question: 'How much balance-sheet liquidity supports the pipeline?',
          detail: `Cash plus short-term investments: ${formatValue(cashAndInvestments, 'currency')}.`,
          query: 'cash runway, clinical trial, liquidity, regulatory approval',
          tone: (cashAssets || 0) >= 25 ? 'good' : (cashAssets || 0) >= 10 ? 'warn' : 'bad',
          sources: sources([['Cash', rows.cash], ['Investments', rows.shortTermInvestments], ['Assets', rows.totalAssets]]),
        });
        commonCards();
        break;
      case INDUSTRY_GROUPS.OIL_GAS:
      case INDUSTRY_GROUPS.AIRLINES:
      case INDUSTRY_GROUPS.UTILITIES:
        addCard({
          key: 'capex-revenue',
          label: 'Capex / Revenue',
          value: capexRevenue,
          format: 'percent',
          question: 'How capital-intensive is the current operating model?',
          detail: `Capital expenditures: ${formatValue(capex, 'currency')}.`,
          query: 'capital expenditures, maintenance capital, capacity, infrastructure',
          tone: (capexRevenue || 0) <= 8 ? 'good' : (capexRevenue || 0) <= 20 ? 'warn' : 'neutral',
          sources: sources([['Capex', rows.capex], ['Revenue', rows.revenue]]),
        });
        addCard({
          key: 'cfo-capex',
          label: 'CFO / Capex',
          value: cfoCapex,
          format: 'decimal',
          question: 'Does operating cash flow cover reinvestment needs?',
          detail: 'Operating cash flow divided by capital expenditures.',
          query: 'capital expenditures, operating cash flow, liquidity, financing',
          tone: (cfoCapex || 0) >= 2 ? 'good' : (cfoCapex || 0) >= 1 ? 'warn' : 'bad',
          sources: sources([['CFO', rows.operatingCashFlow], ['Capex', rows.capex]]),
        });
        addCard({
          key: 'debt-equity',
          label: 'Debt / Equity',
          value: debtEquity,
          format: 'percent',
          question: 'How much leverage sits behind the capital program?',
          detail: `Total debt: ${formatValue(debt, 'currency')}.`,
          query: 'debt maturities, refinancing, interest rate risk, liquidity',
          tone: (debtEquity || 0) <= 80 ? 'good' : (debtEquity || 0) <= 150 ? 'warn' : 'bad',
          sources: sources([['Short-term Debt', rows.shortTermDebt], ['Long-term Debt', rows.longTermDebt], ["Stockholders' Equity", rows.stockholdersEquity]]),
        });
        commonCards();
        break;
      case INDUSTRY_GROUPS.MANUFACTURING:
        addCard({
          key: 'gross-margin',
          label: 'Gross Margin',
          value: grossMargin,
          format: 'percent',
          question: 'Is production profitability resilient?',
          detail: 'Gross profit divided by revenue.',
          query: 'raw material costs, pricing, supply chain, tariffs',
          tone: (grossMargin || 0) >= 30 ? 'good' : (grossMargin || 0) >= 15 ? 'warn' : 'bad',
          sources: sources([['Gross Profit', rows.grossProfit], ['Revenue', rows.revenue]]),
        });
        addCard({
          key: 'inventory-turnover',
          label: 'Inventory Turnover',
          value: inventoryTurnover,
          format: 'decimal',
          question: 'Is inventory moving through the system?',
          detail: 'Cost of revenue divided by inventory.',
          query: 'inventory, backlog, orders, supply chain',
          tone: (inventoryTurnover || 0) >= 4 ? 'good' : (inventoryTurnover || 0) >= 2 ? 'warn' : 'bad',
          sources: sources([['Cost of Revenue', rows.costOfRevenue], ['Inventory', rows.inventory]]),
        });
        commonCards();
        break;
      default:
        addCard({
          key: 'revenue-growth',
          label: 'Revenue Growth',
          value: revenueGrowth,
          format: 'percent',
          question: 'Is the top line expanding against last year?',
          detail: 'Latest annual revenue compared with the prior annual period.',
          query: 'demand, pricing, revenue, competition',
          tone: (revenueGrowth || 0) >= 10 ? 'good' : (revenueGrowth || 0) >= 0 ? 'warn' : 'bad',
          sources: sources([['Revenue', rows.revenue], ['Prior Revenue', rows.priorRevenue]]),
        });
        commonCards();
        break;
    }

    return { cards: cards.slice(0, 4), latestPeriod, group };
  }, [facts, periods, sicCode]);

  if (!cards.length) return null;

  return (
    <div className="mb-6 border-2 border-stone-800 bg-stone-950/50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Industry Research Playbook
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Source-backed questions tailored to {industryLabel(group)} companies, with XBRL inputs and disclosure-search handoffs for {companyName || ticker || 'this company'}.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-stone-500">
          {latestPeriod ? periodLabel(latestPeriod) : 'Annual'} / SIC {sicCode || 'N/A'}
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <IndustryPlaybookCardView key={card.key} card={card} cik={cik} ticker={ticker} />
        ))}
      </div>

      <div className="border-t border-stone-800 px-4 py-3 text-[11px] leading-relaxed text-stone-500">
        The values above are computed from linked SEC XBRL facts. The search links open company-focused EDGAR keyword searches for the narrative that explains or challenges each metric.
      </div>
    </div>
  );
}

function IndustryPlaybookCardView({
  card,
  cik,
  ticker,
}: {
  card: IndustryPlaybookCard;
  cik?: string;
  ticker?: string;
}) {
  const toneClasses = {
    good: 'border-emerald-800/70 bg-emerald-950/10',
    warn: 'border-amber-800/70 bg-amber-950/10',
    bad: 'border-rose-800/70 bg-rose-950/10',
    neutral: 'border-sky-800/70 bg-sky-950/10',
  }[card.tone];

  return (
    <div className={`min-h-[256px] border-2 p-4 flex flex-col justify-between ${toneClasses}`}>
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-stone-500">
          {card.label}
        </div>
        <div className="mt-2 text-2xl font-black tabular-nums text-stone-100">
          {formatValue(card.value, card.format)}
        </div>
        <div className="mt-3 text-sm font-black leading-snug text-stone-100">
          {card.question}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-stone-400">
          {card.detail}
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {card.sources.map((source) => (
            <SourceChip key={`${card.key}-${source.label}`} source={source} cik={cik} />
          ))}
        </div>
        <a
          href={disclosureSearchHref(card.query, ticker)}
          className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] font-bold text-emerald-300 hover:text-emerald-200 transition-colors"
        >
          Search disclosure context
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
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
  const openEvidence = useEvidence();
  const sourceUrl = source.point?.source && cik ? buildSourceUrl(cik, source.point.source) : null;
  if (!sourceUrl || !source.point?.source) return null;

  const factSource = source.point.source;
  return (
    <a
      href={sourceUrl}
      onClick={(event) => { if (openEvidence && !event.ctrlKey && !event.metaKey) { event.preventDefault(); openEvidence({ label: source.label, point: source.point }); } }}
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
                  <ValueCell key={i} point={v} label={row.label} value={v.value} source={v.source} sources={v.sources} cik={cik} format={row.format} isHeader={header} />
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
  point?: any;
  label?: string;
  value: number | null;
  source?: { label?: string; tag: string; unit: string; end: string; filed: string; accession: string };
  sources?: { label?: string; tag: string; unit: string; end: string; filed: string; accession: string }[];
  cik?: string;
  format: string;
  isHeader: boolean;
}

function ValueCell({ value, source, sources, cik, format, isHeader, point, label }: ValueCellProps) {
  const openEvidence = useEvidence();
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
  if (openEvidence && point) {
    return <td className={cellClasses}><button type="button" title="Inspect value, calculation, and SEC evidence" onClick={() => openEvidence({ label: label || 'Financial value', point, format })} className="inline-flex items-center gap-1 underline decoration-amber-300/30 underline-offset-4 hover:text-amber-300">{formatValue(value, format)}{point.classification === 'calculated' && <span aria-label="Calculated" className="text-xs text-slate-500">ƒ</span>}</button></td>;
  }
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
