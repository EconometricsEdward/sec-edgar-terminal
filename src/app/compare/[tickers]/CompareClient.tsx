'use client';

import React, { useState, useEffect, useContext, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  GitCompare, X, Plus, Loader2, AlertCircle, Search, Link as LinkIcon,
  AlertTriangle, Download, Sparkles, TrendingUp, Percent, BarChart3,
  Trophy, LayoutGrid, ExternalLink, FileSearch, FileText, ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { ComparisonChart as ComparisonChartImpl } from '../../../components/MetricChart.jsx';
import { TickerContext } from '../../../contexts/TickerContext';
import { secDataUrl, secFilesUrl } from '../../../utils/secApi.js';
import {
  extractAnnualPeriods, buildMetricRow, computeGrowth, buildSourceUrl,
} from '../../../utils/xbrlParser.js';
import { classifyIndustry } from '../../../utils/industry.js';
import { PEER_GROUPS, COMPANY_COLORS } from '../../../utils/peerGroups.js';
import type { TickerMap } from '../../../contexts/TickerContext';

const noopSetTickerMap = (_map: TickerMap | null) => {};

// ============================================================================
// JS-component prop interop (same pattern as AnalysisClient)
//
// ComparisonChart is a plain .jsx file with no TypeScript prop types.
// Casting at the import boundary tells TS "trust the runtime here".
// ============================================================================
const ComparisonChart = ComparisonChartImpl as any;

// ============================================================================
// Exported types — server page imports PreloadedCompany
// ============================================================================
export interface PreloadedCompany {
  ticker: string;
  cik: string;
  name: string;
}

interface CompareClientProps {
  initialTickers: string[];
  preloadedCompanies: PreloadedCompany[];
}

// ============================================================================
// Internal types
// ============================================================================
interface CompanyState {
  ticker: string;
  name: string;
  cik: string;
  color: string;
  facts: any | null;
  sicCode: string | number | null;
  sicDescription: string | null;
  loading: boolean;
  error: string | null;
}

type AnyValue = any;

function PeerResearchWorkbench({
  companies,
  spreadPrompts,
}: {
  companies: CompanyState[];
  spreadPrompts: AnyValue[];
}) {
  const loadedCompanies = companies.filter((c) => c.facts && !c.error);
  const tickers = loadedCompanies.map((c) => c.ticker);
  const broadDisclosureHref = disclosureSearchHref(
    'risk factors, competition, demand, pricing, margin pressure',
    tickers
  );

  return (
    <section className="mb-8 border-2 border-stone-800 bg-stone-950/50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <FileSearch className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Peer Research Workbench
            </h3>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Turn source-linked peer spreads into SEC filing trails, company analysis pages, and focused disclosure searches.
          </p>
        </div>
        <a
          href={broadDisclosureHref}
          className="inline-flex items-center gap-1.5 border border-emerald-800/70 bg-emerald-950/30 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.16em] text-emerald-200 transition-colors hover:border-emerald-500 hover:text-emerald-100"
        >
          Search peer set
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Explain the largest spreads
          </div>
          {spreadPrompts.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {spreadPrompts.map((prompt: AnyValue) => (
                <SpreadPromptCard
                  key={`${prompt.metric}-${prompt.high.ticker}-${prompt.low.ticker}`}
                  prompt={prompt}
                  tickers={tickers}
                />
              ))}
            </div>
          ) : (
            <div className="border border-dashed border-stone-800 px-4 py-8 text-center text-xs text-stone-500">
              No comparable source-linked snapshot spreads are available for this peer set yet.
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
            Peer source trails
          </div>
          <div className="space-y-2">
            {loadedCompanies.map((company) => (
              <PeerSourceTrail key={`${company.ticker}-${company.cik}`} company={company} />
            ))}
          </div>

          <div className="mt-3 grid gap-2">
            <WorkbenchLink
              icon={GitCompare}
              title="Keep comparing this set"
              detail={`Return to this peer set: ${tickers.join(', ')}.`}
              href={`/compare/${tickers.join(',')}`}
              tone="sky"
            />
            <WorkbenchLink
              icon={ShieldCheck}
              title="Audit the public source trail"
              detail="Open each company's raw Company Facts JSON from data.sec.gov in the source trail above."
              href="https://www.sec.gov/search-filings/edgar-application-programming-interfaces"
              tone="stone"
              external
            />
          </div>
        </div>
      </div>

      <div className="border-t border-stone-800 px-4 py-3 text-[11px] leading-relaxed text-stone-500">
        Spread prompts are generated from the source-linked snapshot table above. They are research starting points, not conclusions; verify each metric through the linked XBRL source or SEC filing.
      </div>
    </section>
  );
}

function SpreadPromptCard({
  prompt,
  tickers,
}: {
  prompt: AnyValue;
  tickers: string[];
}) {
  const href = disclosureSearchHref(prompt.query, tickers);
  const spreadLabel = prompt.format === 'percent'
    ? `${Math.abs(prompt.diff).toFixed(1)} pts`
    : formatSnapshotValue(Math.abs(prompt.diff), prompt.format);

  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-stone-500">
            {prompt.metric}
          </div>
          <div className="mt-2 text-sm font-black leading-snug text-stone-100">
            {prompt.high.ticker} vs {prompt.low.ticker}
          </div>
        </div>
        <span className="shrink-0 border border-amber-700/60 bg-amber-950/40 px-2 py-1 text-[9px] font-black uppercase tracking-[0.12em] text-amber-200">
          {spreadLabel}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <SpreadValue label="High" value={prompt.high} format={prompt.format} />
        <SpreadValue label="Low" value={prompt.low} format={prompt.format} />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-stone-400">
        {prompt.detail}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <SourcePills label="High" sources={prompt.highSources} />
        <SourcePills label="Low" sources={prompt.lowSources} />
      </div>

      <a
        href={href}
        className="mt-3 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] font-bold text-emerald-300 transition-colors hover:text-emerald-200"
      >
        Search filings for explanation
        <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}

function SpreadValue({
  label,
  value,
  format,
}: {
  label: string;
  value: AnyValue;
  format: string;
}) {
  return (
    <div className="border border-stone-800 bg-stone-950/70 px-3 py-2">
      <div className="text-[9px] uppercase tracking-[0.16em] text-stone-600 font-bold">
        {label} / {value.ticker}
      </div>
      <div className="mt-1 text-sm font-black tabular-nums text-stone-100">
        {formatSnapshotValue(value.value, format)}
      </div>
    </div>
  );
}

function SourcePills({
  label,
  sources,
}: {
  label: string;
  sources: AnyValue[];
}) {
  if (!sources.length) {
    return (
      <span className="border border-stone-800 bg-stone-950/70 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-stone-600">
        {label}: no source link
      </span>
    );
  }

  return (
    <>
      {sources.slice(0, 2).map((item: AnyValue, index: number) => (
        <a
          key={`${label}-${item.label}-${index}`}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 border border-stone-700 bg-stone-950/70 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-stone-400 transition-colors hover:border-amber-500 hover:text-amber-300"
          title={`Open ${label.toLowerCase()} source: ${item.label}`}
        >
          {label}: {item.label}
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
      ))}
    </>
  );
}

function PeerSourceTrail({ company }: { company: CompanyState }) {
  return (
    <div className="border border-stone-800 bg-stone-900/30 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-black tracking-wider text-stone-100">
            {company.ticker}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-stone-500">
            {company.name}
          </div>
        </div>
        <span className="shrink-0 text-[9px] uppercase tracking-[0.16em] text-stone-600">
          CIK {company.cik}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <a
          href={`/analysis/${company.ticker}`}
          className="inline-flex items-center gap-1 border border-stone-700 bg-stone-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-stone-400 transition-colors hover:border-amber-500 hover:text-amber-300"
        >
          <BarChart3 className="w-3 h-3" />
          Analysis
        </a>
        <a
          href={`/filings/${company.ticker}`}
          className="inline-flex items-center gap-1 border border-stone-700 bg-stone-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-stone-400 transition-colors hover:border-sky-500 hover:text-sky-300"
        >
          <FileText className="w-3 h-3" />
          Filings
        </a>
        <a
          href={companyFactsUrl(company.cik)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 border border-stone-700 bg-stone-950/70 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-stone-400 transition-colors hover:border-emerald-500 hover:text-emerald-300"
        >
          <ShieldCheck className="w-3 h-3" />
          Facts JSON
        </a>
      </div>
    </div>
  );
}

function WorkbenchLink({
  icon: Icon,
  title,
  detail,
  href,
  tone,
  external = false,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  href: string;
  tone: 'sky' | 'stone';
  external?: boolean;
}) {
  const toneClass = tone === 'sky'
    ? 'hover:border-sky-500 hover:bg-sky-500/5 hover:text-sky-300'
    : 'hover:border-stone-600 hover:bg-stone-800/30 hover:text-stone-100';

  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className={`group block border border-stone-800 bg-stone-900/30 px-3 py-3 text-stone-300 transition-colors ${toneClass}`}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500 group-hover:text-current" />
        <div>
          <div className="text-xs font-black text-stone-100 group-hover:text-current">
            {title}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-stone-500">
            {detail}
          </p>
        </div>
      </div>
    </a>
  );
}

// ============================================================================
// Constants — preserved from original ComparePage.jsx
// ============================================================================
const ABSOLUTE_METRICS = [
  { key: 'revenue', label: 'Revenue', format: 'currency' },
  { key: 'netIncome', label: 'Net Income', format: 'currency' },
  { key: 'operatingIncome', label: 'Operating Income', format: 'currency' },
  { key: 'totalAssets', label: 'Total Assets', format: 'currency' },
  { key: 'stockholdersEquity', label: "Stockholders' Equity", format: 'currency' },
  { key: 'operatingCashFlow', label: 'Operating Cash Flow', format: 'currency' },
];

interface RatioMetric {
  key: string;
  label: string;
  format: string;
  compute: (vals: any) => number | null;
  sourceMetricKeys: string[];
  formulaLabel: string;
}

const RATIO_METRICS: RatioMetric[] = [
  { key: 'roe', label: 'Return on Equity (ROE)', format: 'percent',
    compute: (vals) => {
      const r = safeDiv(vals.netIncome, vals.stockholdersEquity);
      return r == null ? null : r * 100;
    },
    sourceMetricKeys: ['netIncome', 'stockholdersEquity'], formulaLabel: 'Net Income ÷ Stockholders\' Equity' },
  { key: 'roa', label: 'Return on Assets (ROA)', format: 'percent',
    compute: (vals) => {
      const r = safeDiv(vals.netIncome, vals.totalAssets);
      return r == null ? null : r * 100;
    },
    sourceMetricKeys: ['netIncome', 'totalAssets'], formulaLabel: 'Net Income ÷ Total Assets' },
  { key: 'netMargin', label: 'Net Margin', format: 'percent',
    compute: (vals) => {
      const r = safeDiv(vals.netIncome, vals.revenue);
      return r == null ? null : r * 100;
    },
    sourceMetricKeys: ['netIncome', 'revenue'], formulaLabel: 'Net Income ÷ Revenue' },
  { key: 'operatingMargin', label: 'Operating Margin', format: 'percent',
    compute: (vals) => {
      const r = safeDiv(vals.operatingIncome, vals.revenue);
      return r == null ? null : r * 100;
    },
    sourceMetricKeys: ['operatingIncome', 'revenue'], formulaLabel: 'Operating Income ÷ Revenue' },
];

const SOURCE_LABELS: Record<string, string> = {
  revenue: 'Revenue',
  netIncome: 'Net Income',
  operatingIncome: 'Operating Income',
  totalAssets: 'Total Assets',
  stockholdersEquity: 'Equity',
};

function sourceWithLabel(row: AnyValue, index: number, key: string) {
  const source = row?.values?.[index]?.source;
  return source?.tag ? { ...source, label: SOURCE_LABELS[key] || key } : null;
}

function ratioInputSources(ratioMetric: RatioMetric, rowsByKey: Record<string, AnyValue>, index: number) {
  return ratioMetric.sourceMetricKeys
    .map((key) => sourceWithLabel(rowsByKey[key], index, key))
    .filter(Boolean);
}

const GROWTH_BAR_METRICS = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'netIncome', label: 'Net Income' },
  { key: 'totalAssets', label: 'Total Assets' },
  { key: 'stockholdersEquity', label: "Stockholders' Equity" },
];

const NORMALIZATION_MODES = [
  { id: 'absolute', label: 'Absolute', desc: 'Raw reported values' },
  { id: 'indexed', label: 'Indexed to 100', desc: 'Relative growth from first shared year' },
  { id: 'perShare', label: 'Per Share', desc: 'Divided by diluted shares outstanding' },
  { id: 'pctRevenue', label: '% of Revenue', desc: 'Each metric as share of revenue' },
];

const MAX_COMPANIES = 5;

const SMART_PEER_SETS = [
  {
    id: 'ev-autos',
    label: 'EV and legacy auto manufacturers',
    anchors: ['RIVN', 'LCID', 'TSLA', 'F', 'GM', 'NIO', 'XPEV', 'LI'],
    tickers: ['TSLA', 'F', 'GM', 'LCID', 'NIO'],
  },
  {
    id: 'mega-tech',
    label: 'Mega-cap technology',
    anchors: ['AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN'],
    tickers: ['AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN'],
  },
  {
    id: 'semiconductors',
    label: 'Semiconductors',
    anchors: ['NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM'],
    tickers: ['NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM'],
  },
  {
    id: 'big-banks',
    label: 'Large U.S. banks',
    anchors: ['JPM', 'BAC', 'WFC', 'C', 'GS', 'MS'],
    tickers: ['JPM', 'BAC', 'WFC', 'C', 'GS'],
  },
  {
    id: 'energy-majors',
    label: 'Energy majors',
    anchors: ['XOM', 'CVX', 'COP', 'OXY', 'EOG'],
    tickers: ['XOM', 'CVX', 'COP', 'OXY', 'EOG'],
  },
];

function normalizeTicker(ticker: string | null | undefined): string {
  return String(ticker || '').trim().toUpperCase();
}

function uniqueTickers(tickers: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of tickers) {
    const ticker = normalizeTicker(raw);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }

  return out;
}

function uniquePreloadedCompanies(companies: PreloadedCompany[]): PreloadedCompany[] {
  const seen = new Set<string>();
  const out: PreloadedCompany[] = [];

  for (const company of companies || []) {
    const ticker = normalizeTicker(company?.ticker);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({
      ...company,
      ticker,
      cik: String(company.cik).padStart(10, '0'),
    });
  }

  return out;
}

function buildSmartPeerSuggestions(
  anchorTicker: string,
  tickerMap: AnyValue | null,
  currentTickers: string[]
): AnyValue[] {
  const anchor = normalizeTicker(anchorTicker);
  const excluded = new Set(uniqueTickers([...currentTickers, anchor]));
  const candidates: Array<{ ticker: string; groupLabel: string }> = [];
  const seen = new Set<string>();

  const pushCandidate = (tickerRaw: string, groupLabel: string) => {
    const ticker = normalizeTicker(tickerRaw);
    if (!ticker || excluded.has(ticker) || seen.has(ticker)) return;
    seen.add(ticker);
    candidates.push({ ticker, groupLabel });
  };

  for (const set of SMART_PEER_SETS) {
    const tickers = uniqueTickers(set.tickers);
    const anchors = uniqueTickers(set.anchors);
    if (!anchors.includes(anchor) && !tickers.includes(anchor)) continue;
    tickers.forEach((ticker) => pushCandidate(ticker, set.label));
  }

  for (const group of PEER_GROUPS) {
    const tickers = uniqueTickers(group.tickers);
    if (!tickers.includes(anchor)) continue;
    tickers.forEach((ticker) => pushCandidate(ticker, group.label));
  }

  const map = tickerMap || {};
  return candidates
    .map((candidate) => {
      const entry = map[candidate.ticker];
      if (!entry) return null;
      return {
        ...entry,
        ticker: normalizeTicker(entry.ticker || candidate.ticker),
        cik: String(entry.cik || '').padStart(10, '0'),
        groupLabel: candidate.groupLabel,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_COMPANIES - 1);
}

const PEER_SPREAD_QUERIES: Record<string, { query: string; detail: string }> = {
  revenue: {
    query: 'demand, pricing, customer concentration, competition',
    detail: 'Look for demand, pricing, customer concentration, and competitive-position language.',
  },
  netIncome: {
    query: 'margin pressure, cost reduction, restructuring, operating expenses',
    detail: 'Check margin pressure, cost actions, and operating-expense disclosures.',
  },
  operatingIncome: {
    query: 'margin pressure, cost reduction, restructuring, operating expenses',
    detail: 'Check operating leverage, cost actions, and margin pressure disclosures.',
  },
  operatingCashFlow: {
    query: 'working capital, cash flow, inventory, collections',
    detail: 'Look for working-capital, inventory, cash collection, and cash-flow explanations.',
  },
  roe: {
    query: 'capital allocation, share repurchase, debt, leverage',
    detail: 'Check capital structure, buyback, leverage, and profitability context.',
  },
  roa: {
    query: 'asset impairment, utilization, capital expenditures, productivity',
    detail: 'Look for asset utilization, impairment, capex, and productivity disclosures.',
  },
  netMargin: {
    query: 'pricing, gross margin, operating expenses, inflation',
    detail: 'Search pricing, cost inflation, gross margin, and expense language.',
  },
  operatingMargin: {
    query: 'pricing, operating expenses, cost reduction, inflation',
    detail: 'Search pricing, operating-expense, cost-reduction, and inflation language.',
  },
};

const DEFAULT_PEER_SPREAD_QUERY = {
  query: 'risk factors, competition, demand, pricing',
  detail: 'Search broad risk, demand, pricing, and competition language across the peer set.',
};

function safeDiv(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || b === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

function disclosureSearchHref(query: string, tickers: string[]): string {
  const params = new URLSearchParams({
    query,
    focus: tickers.slice(0, MAX_COMPANIES).join(','),
  });
  return `/disclosures?${params.toString()}`;
}

function companyFactsUrl(cik: string): string {
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`;
}

function sourceLinksForSnapshotValue(value: AnyValue) {
  return ((value?.sources && value.sources.length > 0) ? value.sources : value?.source ? [value.source] : [])
    .filter((source: AnyValue) => source?.tag)
    .map((source: AnyValue, index: number) => ({
      source,
      label: source.label || source.tag || `Input ${index + 1}`,
      url: value?.cik ? buildSourceUrl(value.cik, source) : null,
    }))
    .filter((item: AnyValue) => item.url);
}

function peerSpreadQueryForMetric(metricKey: string) {
  return PEER_SPREAD_QUERIES[metricKey] || DEFAULT_PEER_SPREAD_QUERY;
}

function buildPeerSpreadPrompts(snapshotRows: AnyValue[]) {
  return snapshotRows
    .map((row: AnyValue) => {
      if (row.higherIsBetter === null) return null;
      const numericValues = row.values
        .filter((value: AnyValue) => value.value != null && Number.isFinite(value.value));
      if (numericValues.length < 2) return null;

      const sorted = [...numericValues].sort((a: AnyValue, b: AnyValue) => b.value - a.value);
      const high = sorted[0];
      const low = sorted[sorted.length - 1];
      const diff = high.value - low.value;
      if (!Number.isFinite(diff) || diff === 0) return null;

      const denominator = Math.abs(low.value) > 0 ? Math.abs(low.value) : Math.abs(high.value);
      const spreadPct = denominator > 0 ? Math.abs(diff / denominator) * 100 : null;
      const score = row.format === 'percent' ? Math.abs(diff) : spreadPct || Math.abs(diff);
      const disclosure = peerSpreadQueryForMetric(row.metricKey);

      return {
        metric: row.metric,
        metricKey: row.metricKey,
        format: row.format,
        high,
        low,
        diff,
        spreadPct,
        score,
        query: disclosure.query,
        detail: disclosure.detail,
        highSources: sourceLinksForSnapshotValue(high),
        lowSources: sourceLinksForSnapshotValue(low),
      };
    })
    .filter(Boolean)
    .sort((a: AnyValue, b: AnyValue) => b.score - a.score)
    .slice(0, 4);
}

// ============================================================================
// Main client component
// ============================================================================
export default function CompareClient({ initialTickers, preloadedCompanies }: CompareClientProps) {
  const router = useRouter();
  const ctx = useContext(TickerContext);
  const tickerMap = ctx?.tickerMap ?? null;
  const setTickerMap = ctx?.setTickerMap ?? noopSetTickerMap;

  const [companies, setCompanies] = useState<CompanyState[]>([]);
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [normalization, setNormalization] = useState('absolute');
  const [autoSuggestFor, setAutoSuggestFor] = useState<string | null>(null);
  const [autoSuggestions, setAutoSuggestions] = useState<AnyValue[]>([]);

  const didInitializeRef = useRef(false);
  const companiesRef = useRef<CompanyState[]>([]);
  const requestedTickers = useMemo(
    () => uniqueTickers(initialTickers).slice(0, MAX_COMPANIES),
    [initialTickers]
  );

  useEffect(() => {
    companiesRef.current = companies;
  }, [companies]);

  // ==========================================================================
  // updateUrl — replace the URL when companies are added/removed
  //
  // Uses router.replace (not router.push) so we don't pollute browser history
  // with intermediate states. The setTimeout(0) preserves the behavior of
  // the original AnalysisPage to avoid navigation during a render cycle.
  // ==========================================================================
  const updateUrl = useCallback((cmps: CompanyState[]) => {
    const tickers = uniqueTickers(cmps.map((c) => c.ticker)).join(',');
    setTimeout(() => {
      if (tickers) router.replace(`/compare/${tickers}`);
      else router.replace('/compare');
    }, 0);
  }, [router]);

  // ==========================================================================
  // Load ticker map if not already in context
  // ==========================================================================
  useEffect(() => {
    if (tickerMap) return;
    (async () => {
      try {
        const res = await fetch(secFilesUrl('company_tickers.json'));
        if (!res.ok) throw new Error('Failed to load ticker database');
        const data = await res.json();
        const map: AnyValue = {};
        Object.values(data).forEach((entry: AnyValue) => {
          map[entry.ticker.toUpperCase()] = {
            cik: String(entry.cik_str).padStart(10, '0'),
            name: entry.title,
            ticker: entry.ticker.toUpperCase(),
          };
        });
        setTickerMap(map);
      } catch {
        setGlobalError('Could not load ticker database.');
      }
    })();
  }, [tickerMap, setTickerMap]);

  // ==========================================================================
  // addCompany — fetch SEC data for a ticker and append to companies list
  //
  // Idempotent by ticker. The ref guard is important because React dev/Strict
  // Mode can run initialization effects twice and because initial URL companies
  // are staggered with timers. State closures alone can be stale during those
  // scheduled calls.
  // ==========================================================================
  const addCompany = useCallback(async (entry: { ticker: string; cik: string; name: string }, updateUrlAfter = true) => {
    const ticker = normalizeTicker(entry?.ticker);
    if (!ticker || !entry?.cik) return;

    const normalizedEntry = {
      ticker,
      cik: String(entry.cik).padStart(10, '0'),
      name: entry.name || ticker,
    };

    const current = companiesRef.current;
    if (current.some((c) => c.ticker === ticker)) return;

    if (current.length >= MAX_COMPANIES) {
      setGlobalError(`Maximum of ${MAX_COMPANIES} companies at once.`);
      return;
    }

    setGlobalError(null);

    const color = COMPANY_COLORS[current.length % COMPANY_COLORS.length];
    const newCompany: CompanyState = {
      ticker: normalizedEntry.ticker,
      name: normalizedEntry.name,
      cik: normalizedEntry.cik,
      color,
      facts: null,
      sicCode: null,
      sicDescription: null,
      loading: true,
      error: null,
    };

    const optimistic = [...current, newCompany];
    companiesRef.current = optimistic;
    setCompanies(optimistic);

    if (updateUrlAfter) {
      updateUrl(optimistic);
    }

    const updateMatchingCompany = (patch: Partial<CompanyState>) => {
      const applyPatch = (list: CompanyState[]) =>
        list.map((company) =>
          company.ticker === ticker
            ? { ...company, ...patch }
            : company
        );

      companiesRef.current = applyPatch(companiesRef.current);
      setCompanies((prev) => applyPatch(prev));
    };

    try {
      const [submissionsRes, factsRes] = await Promise.all([
        fetch(secDataUrl(`/submissions/CIK${normalizedEntry.cik}.json`)),
        fetch(secDataUrl(`/api/xbrl/companyfacts/CIK${normalizedEntry.cik}.json`)),
      ]);

      if (!factsRes.ok) {
        if (factsRes.status === 404) throw new Error('No XBRL financial data available');
        throw new Error(`SEC API ${factsRes.status}`);
      }

      const factsData = await factsRes.json();
      let sicCode: string | number | null = null;
      let sicDescription: string | null = null;

      if (submissionsRes.ok) {
        const sub = await submissionsRes.json();
        sicCode = sub.sic;
        sicDescription = sub.sicDescription;
      }

      updateMatchingCompany({
        facts: factsData.facts || {},
        sicCode,
        sicDescription,
        loading: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateMatchingCompany({
        loading: false,
        error: msg,
      });
    }
  }, [updateUrl]);

  // ==========================================================================
  // Initialize from URL — runs once when ticker data is available.
  //
  // Uses a ref guard so dev/Strict Mode cannot schedule duplicate companies.
  // ==========================================================================
  useEffect(() => {
    if (didInitializeRef.current || initialized) return;

    if (requestedTickers.length === 0) {
      didInitializeRef.current = true;
      setInitialized(true);
      return;
    }

    const uniquePreloaded = uniquePreloadedCompanies(preloadedCompanies)
      .filter((company) => requestedTickers.includes(company.ticker))
      .slice(0, MAX_COMPANIES);

    if (uniquePreloaded.length > 0) {
      didInitializeRef.current = true;
      setInitialized(true);

      uniquePreloaded.forEach((entry, i) => {
        setTimeout(() => addCompany(entry, false), i * 50);
      });
      return;
    }

    if (!tickerMap) return;

    didInitializeRef.current = true;
    setInitialized(true);

    requestedTickers.forEach((ticker, i) => {
      const entry = tickerMap[ticker];
      if (entry) {
        setTimeout(() => addCompany(entry, false), i * 50);
      }
    });
  }, [tickerMap, initialized, requestedTickers, preloadedCompanies, addCompany]);

  // ==========================================================================
  // removeCompany — drop one and recolor remaining so colors stay sequential
  // ==========================================================================
  const removeCompany = useCallback((ticker: string) => {
    const next = companies.filter((c) => c.ticker !== ticker);
    const recolored = next.map((c, i) => ({ ...c, color: COMPANY_COLORS[i % COMPANY_COLORS.length] }));
    companiesRef.current = recolored;
    setCompanies(recolored);
    updateUrl(recolored);
  }, [companies, updateUrl]);

  // ==========================================================================
  // loadPeerGroup — clear + add all tickers from a preset peer group
  // ==========================================================================
  const loadPeerGroup = useCallback((group: { tickers: string[] }) => {
    const tickers = uniqueTickers(group.tickers).slice(0, MAX_COMPANIES);
    const entries = tickers
      .map((ticker) => tickerMap?.[ticker])
      .filter(Boolean) as Array<{ ticker: string; cik: string; name: string }>;

    companiesRef.current = [];
    setCompanies([]);
    setAutoSuggestFor(null);
    setAutoSuggestions([]);

    setTimeout(() => {
      entries.forEach((entry, i) => {
        setTimeout(() => addCompany(entry, i === entries.length - 1), i * 50);
      });
    }, 100);
  }, [tickerMap, addCompany]);

  // ==========================================================================
  // Smart peer suggestions — when exactly one company is loaded, recommend
  // relevant peer additions and offer a one-click peer-set build.
  // ==========================================================================
  const addSuggestedPeerSet = useCallback(() => {
    const remainingSlots = MAX_COMPANIES - companiesRef.current.length;
    if (remainingSlots <= 0) return;

    const entries = autoSuggestions.slice(0, remainingSlots);
    entries.forEach((entry, i) => {
      setTimeout(() => addCompany(entry, i === entries.length - 1), i * 50);
    });
  }, [autoSuggestions, addCompany]);

  useEffect(() => {
    if (companies.length !== 1) {
      setAutoSuggestions([]);
      setAutoSuggestFor(null);
      return;
    }

    const anchor = companies[0];
    if (anchor.loading || anchor.error) return;

    setAutoSuggestFor(anchor.ticker);
    setAutoSuggestions(
      buildSmartPeerSuggestions(
        anchor.ticker,
        tickerMap,
        companies.map((company) => company.ticker)
      )
    );
  }, [companies, tickerMap]);

  const copyShareLink = () => {
    if (!companies.length) return;
    const url = `${window.location.origin}/compare/${companies.map((c) => c.ticker).join(',')}`;
    navigator.clipboard.writeText(url);
  };

  const suggestions = useMemo(() => {
    if (!tickerMap || !input.trim()) return [];
    const q = input.trim().toUpperCase();
    const scored: AnyValue[] = [];
    for (const e of Object.values(tickerMap) as AnyValue[]) {
      if (companies.find((c) => c.ticker === e.ticker)) continue;
      let score = 0;
      if (e.ticker === q) score = 1000;
      else if (e.ticker.startsWith(q)) score = 500 - (e.ticker.length - q.length);
      else if (e.name.toUpperCase().startsWith(q)) score = 300;
      else if (e.name.toUpperCase().includes(q)) score = 100;
      if (score > 0) scored.push({ ...e, score });
    }
    scored.sort((a: AnyValue, b: AnyValue) => b.score - a.score);
    return scored.slice(0, 8);
  }, [input, tickerMap, companies]);

  const handleSubmit = () => {
    if (!input.trim() || !suggestions.length) return;
    addCompany(suggestions[highlightedIdx] || suggestions[0]);
    setInput('');
    setShowSuggestions(false);
    setHighlightedIdx(0);
  };

  const alignedPeriods = useMemo(() => {
    const allYears = new Set<number>();
    companies.forEach((c) => {
      if (c.facts) {
        extractAnnualPeriods(c.facts).slice(0, 10).forEach((p: AnyValue) => allYears.add(p.fy));
      }
    });
    return Array.from(allYears).sort((a, b) => b - a).slice(0, 10);
  }, [companies]);

  const allLoaded = companies.length > 0 && companies.every((c) => !c.loading);

  const buildSeriesForMetric = useCallback((metricKey: string, format: string = 'currency') => {
    return companies
      .filter((c) => c.facts && !c.error)
      .map((c) => {
        const companyPeriods = extractAnnualPeriods(c.facts).slice(0, 10);
        const row = buildMetricRow(c.facts, metricKey, '', companyPeriods, format, c.sicCode as AnyValue);
        return { name: c.name, ticker: c.ticker, color: c.color, data: row.values, sicCode: c.sicCode };
      });
  }, [companies]);

  const normalizeSeries = useCallback((series: AnyValue[], mode: string, metricKey: string) => {
    if (mode === 'absolute') return series;
    if (mode === 'indexed') {
      return series.map((s: AnyValue) => {
        const sorted = [...s.data].sort((a: AnyValue, b: AnyValue) => (a.period?.fy || 0) - (b.period?.fy || 0));
        const baseline = sorted.find((v: AnyValue) => v.value != null)?.value;
        if (!baseline || baseline === 0) return s;
        return {
          ...s,
          data: s.data.map((v: AnyValue) => ({ ...v, value: v.value != null ? (v.value / baseline) * 100 : null })),
        };
      });
    }
    if (mode === 'perShare') {
      return series.map((s: AnyValue) => {
        const company = companies.find((c) => c.ticker === s.ticker);
        if (!company?.facts) return s;
        const periods = extractAnnualPeriods(company.facts).slice(0, 10);
        const sharesRow = buildMetricRow(company.facts, 'sharesDiluted', '', periods, 'shares', company.sicCode as AnyValue);
        return {
          ...s,
          data: s.data.map((v: AnyValue, i: number) => {
            const shares = sharesRow.values[i]?.value;
            if (v.value == null || !shares || shares === 0) return { ...v, value: null };
            return { ...v, value: v.value / shares };
          }),
        };
      });
    }
    if (mode === 'pctRevenue') {
      if (metricKey === 'revenue') {
        return series.map((s: AnyValue) => ({
          ...s,
          data: s.data.map((v: AnyValue) => ({ ...v, value: v.value != null ? 100 : null })),
        }));
      }
      return series.map((s: AnyValue) => {
        const company = companies.find((c) => c.ticker === s.ticker);
        if (!company?.facts) return s;
        const periods = extractAnnualPeriods(company.facts).slice(0, 10);
        const revRow = buildMetricRow(company.facts, 'revenue', '', periods, 'currency', company.sicCode as AnyValue);
        return {
          ...s,
          data: s.data.map((v: AnyValue, i: number) => {
            const rev = revRow.values[i]?.value;
            if (v.value == null || !rev || rev === 0) return { ...v, value: null };
            return { ...v, value: (v.value / rev) * 100 };
          }),
        };
      });
    }
    return series;
  }, [companies]);

  const effectiveFormat = (originalFormat: string): string => {
    if (normalization === 'indexed') return 'indexed';
    if (normalization === 'pctRevenue') return 'percent';
    if (normalization === 'perShare') return 'currency';
    return originalFormat;
  };

  const buildRatioSeries = useCallback((ratioMetric: RatioMetric) => {
    return companies
      .filter((c) => c.facts && !c.error)
      .map((c) => {
        const periods = extractAnnualPeriods(c.facts).slice(0, 10);
        const revenue = buildMetricRow(c.facts, 'revenue', '', periods, 'currency', c.sicCode as AnyValue);
        const netIncome = buildMetricRow(c.facts, 'netIncome', '', periods, 'currency', c.sicCode as AnyValue);
        const operatingIncome = buildMetricRow(c.facts, 'operatingIncome', '', periods, 'currency', c.sicCode as AnyValue);
        const totalAssets = buildMetricRow(c.facts, 'totalAssets', '', periods, 'currency', c.sicCode as AnyValue);
        const equity = buildMetricRow(c.facts, 'stockholdersEquity', '', periods, 'currency', c.sicCode as AnyValue);
        const rowsByKey = {
          revenue,
          netIncome,
          operatingIncome,
          totalAssets,
          stockholdersEquity: equity,
        };
        const data = periods.map((p: AnyValue, i: number) => {
          const sources = ratioInputSources(ratioMetric, rowsByKey, i);
          return {
            period: p,
            value: ratioMetric.compute({
              revenue: revenue.values[i]?.value,
              netIncome: netIncome.values[i]?.value,
              operatingIncome: operatingIncome.values[i]?.value,
              totalAssets: totalAssets.values[i]?.value,
              stockholdersEquity: equity.values[i]?.value,
            }),
            source: sources[0] || null,
            sources,
            formulaLabel: ratioMetric.formulaLabel,
          };
        });
        return { name: c.name, ticker: c.ticker, color: c.color, data };
      });
  }, [companies]);

  const snapshotData = useMemo(() => {
    const allMetrics = [
      { key: 'revenue', label: 'Revenue', format: 'currency', higherIsBetter: true, tooltip: 'Total revenue as reported' },
      { key: 'netIncome', label: 'Net Income', format: 'currency', higherIsBetter: true, tooltip: 'Net income as reported' },
      { key: 'operatingIncome', label: 'Operating Income', format: 'currency', higherIsBetter: true, tooltip: 'Operating income as reported' },
      { key: 'totalAssets', label: 'Total Assets', format: 'currency', higherIsBetter: null, tooltip: 'Total assets as reported (neutral — bigger is not always better)' },
      { key: 'stockholdersEquity', label: "Stockholders' Equity", format: 'currency', higherIsBetter: true, tooltip: "Total stockholders' equity as reported" },
      { key: 'operatingCashFlow', label: 'Operating Cash Flow', format: 'currency', higherIsBetter: true, tooltip: 'Cash from operations' },
      { key: 'roe', label: 'ROE', format: 'percent', higherIsBetter: true, computed: true, tooltip: 'Return on Equity = Net Income ÷ Stockholders\' Equity' },
      { key: 'roa', label: 'ROA', format: 'percent', higherIsBetter: true, computed: true, tooltip: 'Return on Assets = Net Income ÷ Total Assets' },
      { key: 'netMargin', label: 'Net Margin', format: 'percent', higherIsBetter: true, computed: true, tooltip: 'Net Margin = Net Income ÷ Revenue' },
      { key: 'operatingMargin', label: 'Operating Margin', format: 'percent', higherIsBetter: true, computed: true, tooltip: 'Operating Margin = Operating Income ÷ Revenue' },
    ];
    return allMetrics.map((m) => {
      const row: AnyValue = {
        metric: m.label, metricKey: m.key, format: m.format,
        higherIsBetter: m.higherIsBetter, isComputed: !!m.computed, tooltip: m.tooltip, values: [],
      };
      companies.filter((c) => c.facts && !c.error).forEach((c) => {
        const periods = extractAnnualPeriods(c.facts).slice(0, 10);
        if (!periods.length) {
          row.values.push({ ticker: c.ticker, cik: c.cik, value: null, source: null, period: null });
          return;
        }
        if (m.computed) {
          const revenue = buildMetricRow(c.facts, 'revenue', '', periods, 'currency', c.sicCode as AnyValue);
          const netIncome = buildMetricRow(c.facts, 'netIncome', '', periods, 'currency', c.sicCode as AnyValue);
          const opIncome = buildMetricRow(c.facts, 'operatingIncome', '', periods, 'currency', c.sicCode as AnyValue);
          const assets = buildMetricRow(c.facts, 'totalAssets', '', periods, 'currency', c.sicCode as AnyValue);
          const equity = buildMetricRow(c.facts, 'stockholdersEquity', '', periods, 'currency', c.sicCode as AnyValue);
          const rowsByKey = {
            revenue,
            netIncome,
            operatingIncome: opIncome,
            totalAssets: assets,
            stockholdersEquity: equity,
          };
          const vals = {
            revenue: revenue.values[0]?.value,
            netIncome: netIncome.values[0]?.value,
            operatingIncome: opIncome.values[0]?.value,
            totalAssets: assets.values[0]?.value,
            stockholdersEquity: equity.values[0]?.value,
          };
          const ratioMetric = RATIO_METRICS.find((r) => r.key === m.key);
          const value = ratioMetric ? ratioMetric.compute(vals) : null;
          const sources = ratioMetric ? ratioInputSources(ratioMetric, rowsByKey, 0) : [];
          row.values.push({
            ticker: c.ticker, cik: c.cik, value,
            source: sources[0] || null,
            sources,
            period: periods[0], formulaLabel: ratioMetric?.formulaLabel,
          });
        } else {
          const r = buildMetricRow(c.facts, m.key, '', periods, 'currency', c.sicCode as AnyValue);
          row.values.push({
            ticker: c.ticker, cik: c.cik,
            value: r.values[0]?.value ?? null,
            source: r.values[0]?.source || null,
            period: periods[0],
          });
        }
      });
      return row;
    });
  }, [companies]);

  const peerSpreadPrompts = useMemo(
    () => buildPeerSpreadPrompts(snapshotData),
    [snapshotData]
  );

  const buildGrowthGroups = useCallback((field: '5y' | '10y') => {
    const loadedCompanies = companies.filter((c) => c.facts && !c.error);
    return GROWTH_BAR_METRICS.map((m) => {
      const bars = loadedCompanies.map((c) => {
        const periods = extractAnnualPeriods(c.facts).slice(0, 10);
        const metricRow = buildMetricRow(c.facts, m.key, '', periods, 'currency', c.sicCode as AnyValue);
        const growth = computeGrowth(metricRow);
        return {
          ticker: c.ticker,
          color: c.color,
          value: field === '5y' ? growth.cagr5y : growth.cagr10y,
        };
      });
      return { metric: m.label, bars };
    });
  }, [companies]);

  const exportFullCsv = () => {
    if (!companies.length || !allLoaded) return;
    const loadedCompanies = companies.filter((c) => c.facts && !c.error);
    if (!loadedCompanies.length) return;
    const rows: string[] = [];
    rows.push(['Metric', 'Company', 'Ticker', ...alignedPeriods.map((y) => `FY${String(y).slice(2)}`), 'YoY %', '5Y CAGR %', '10Y CAGR %'].join(','));
    for (const metric of ABSOLUTE_METRICS) {
      for (const c of loadedCompanies) {
        const periods = extractAnnualPeriods(c.facts).slice(0, 10);
        const row = buildMetricRow(c.facts, metric.key, '', periods, metric.format, c.sicCode as AnyValue);
        const growth = computeGrowth(row);
        const valsByYear = new Map<number, AnyValue>();
        row.values.forEach((v: AnyValue) => { if (v.period?.fy) valsByYear.set(v.period.fy, v.value); });
        const vals = alignedPeriods.map((y) => {
          const val = valsByYear.get(y);
          return val == null ? '' : val;
        });
        rows.push([
          `"${metric.label}"`, `"${c.name}"`, c.ticker, ...vals,
          growth.yoy != null ? growth.yoy.toFixed(2) : '',
          growth.cagr5y != null ? growth.cagr5y.toFixed(2) : '',
          growth.cagr10y != null ? growth.cagr10y.toFixed(2) : '',
        ].join(','));
      }
    }
    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compare_${loadedCompanies.map((c) => c.ticker).join('_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const industryGroups = new Set(
    companies.filter((c) => c.sicCode).map((c) => classifyIndustry(c.sicCode))
  );
  const mixedIndustries = industryGroups.size > 1;

  // ==========================================================================
  // Render
  // ==========================================================================
  return (
    <>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <GitCompare className="w-5 h-5 text-amber-500" />
          <h2 className="text-xl font-black uppercase tracking-tight">Peer Comparison</h2>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed">
          Compare up to {MAX_COMPANIES} public companies side-by-side across 10 fiscal years.
          Pick a preset peer group below or search your own tickers.
        </p>
      </div>

      {companies.length === 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span className="text-[11px] uppercase tracking-[0.2em] text-stone-300 font-bold">Common peer groups</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {PEER_GROUPS.map((group) => (
              <button key={group.id} onClick={() => loadPeerGroup(group)}
                className="flex items-center gap-2 px-3 py-2 bg-stone-900 border-2 border-stone-800 hover:border-amber-500 hover:bg-amber-500/5 text-stone-300 hover:text-amber-300 text-xs uppercase tracking-wider font-bold transition-colors group"
                title={group.description}
                type="button">
                <span>{group.icon}</span>
                <span>{group.label}</span>
                <span className="text-[10px] text-stone-600 group-hover:text-amber-600 ml-1">({group.tickers.length})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {companies.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {companies.map((c) => (
            <div key={`${c.ticker}-${c.cik}`} className="flex items-center gap-2 px-3 py-2 border-2"
              style={{
                borderColor: c.error ? '#7f1d1d' : c.loading ? '#44403c' : c.color + '80',
                backgroundColor: c.error ? '#450a0a40' : c.loading ? '#1c1917' : c.color + '1a',
                color: c.error ? '#fca5a5' : c.loading ? '#a8a29e' : c.color,
              }}>
              <span className="text-xs font-black tracking-wider">{c.ticker}</span>
              <span className="text-[11px] text-stone-400 truncate max-w-[180px]">{c.name}</span>
              {c.loading && <Loader2 className="w-3 h-3 animate-spin" />}
              {c.error && <AlertCircle className="w-3 h-3" />}
              <button onClick={() => removeCompany(c.ticker)} className="text-stone-500 hover:text-rose-400 ml-1" type="button">
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {companies.length < MAX_COMPANIES && (
        <div className="mb-6 relative">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500" />
              <input type="text" value={input}
                onChange={(e) => { setInput(e.target.value.toUpperCase()); setShowSuggestions(true); setHighlightedIdx(0); }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightedIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightedIdx((i) => Math.max(i - 1, 0)); }
                  else if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
                  else if (e.key === 'Escape') setShowSuggestions(false);
                }}
                placeholder={companies.length === 0 ? 'Or type a ticker (AAPL, Tesla, etc.)' : 'Add another company...'}
                className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-10 pr-4 py-3 text-base font-bold tracking-wider placeholder-stone-600 transition-colors"
                autoComplete="off"
              />
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-stone-700 z-50 max-h-80 overflow-y-auto shadow-2xl">
                  {suggestions.map((s: AnyValue, i: number) => (
                    <button key={s.cik} onMouseEnter={() => setHighlightedIdx(i)}
                      onClick={() => { addCompany(s); setInput(''); setShowSuggestions(false); }}
                      className={`w-full flex items-center justify-between px-3 py-2.5 text-left border-b border-stone-800 last:border-b-0 transition-colors ${
                        i === highlightedIdx ? 'bg-amber-500/10 border-l-2 border-l-amber-500' : 'hover:bg-stone-800/50'
                      }`}
                      type="button">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-stone-100 truncate">{s.name}</div>
                      </div>
                      <div className="shrink-0 text-sm font-black text-amber-400 tracking-wider">{s.ticker}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={handleSubmit} disabled={!suggestions.length}
              className="px-5 py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors flex items-center gap-2"
              type="button">
              <Plus className="w-4 h-4" /> Add
            </button>
            {companies.length > 0 && (
              <>
                <button onClick={copyShareLink} className="px-3 py-3 border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors" title="Copy shareable link" type="button">
                  <LinkIcon className="w-4 h-4" />
                </button>
                <button onClick={exportFullCsv} disabled={!allLoaded} className="px-3 py-3 border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 disabled:opacity-50 transition-colors" title="Download full comparison as CSV" type="button">
                  <Download className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {autoSuggestions.length > 0 && companies.length === 1 && (
        <div className="mb-6 border-2 border-sky-900/50 bg-sky-950/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                <span className="text-[11px] uppercase tracking-[0.2em] text-sky-300 font-bold">
                  Smart peer suggestions for {companies[0].ticker}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-stone-500">
                Build a useful comparison set in one click, or add peers individually.
              </p>
            </div>
            <button
              onClick={addSuggestedPeerSet}
              className="inline-flex items-center gap-2 border border-sky-700/70 bg-sky-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-[0.16em] text-sky-200 transition-colors hover:border-sky-400 hover:text-sky-100"
              type="button"
            >
              <Plus className="w-3.5 h-3.5" />
              Add suggested set
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {autoSuggestions.map((s: AnyValue) => (
              <button
                key={`${s.groupLabel}-${s.ticker}`}
                onClick={() => addCompany(s)}
                className="flex items-center gap-2 px-3 py-1.5 bg-stone-900 border border-sky-800/50 hover:border-sky-500 text-stone-300 hover:text-sky-300 text-xs font-bold transition-colors"
                title={`${s.name} · ${s.groupLabel}`}
                type="button"
              >
                <Plus className="w-3 h-3" />
                {s.ticker}
                <span className="text-[10px] text-stone-500">{s.name.split(' ').slice(0, 2).join(' ')}</span>
                <span className="text-[9px] uppercase tracking-[0.12em] text-sky-500">{s.groupLabel}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {globalError && (
        <div className="mb-6 border-2 border-rose-800/60 bg-rose-950/30 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="text-sm text-rose-200">{globalError}</div>
        </div>
      )}

      {mixedIndustries && (
        <div className="mb-6 border-2 border-amber-700/40 bg-amber-950/20 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-100/90 leading-relaxed">
            <span className="font-bold text-amber-300">Comparing across industries.</span>{' '}
            You've added companies from different industry groups. Metrics may not be directly
            comparable — bank "revenue" is interest + fee income, while retail "revenue" is net sales.
            Consider using the <span className="font-bold">Ratios</span> view below for more
            apples-to-apples comparisons like ROE and net margin.
          </div>
        </div>
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <SnapshotTable data={snapshotData} companies={companies} />
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 1 && (
        <PeerResearchWorkbench
          companies={companies}
          spreadPrompts={peerSpreadPrompts}
        />
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <LayoutGrid className="w-4 h-4 text-stone-400" />
            <span className="text-[10px] uppercase tracking-[0.25em] text-stone-400 font-bold">View Mode</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {NORMALIZATION_MODES.map((mode) => (
              <button key={mode.id} onClick={() => setNormalization(mode.id)}
                className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                  normalization === mode.id
                    ? 'bg-stone-100 text-stone-950 border-stone-100'
                    : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700 hover:text-stone-200'
                }`}
                title={mode.desc}
                type="button">
                {mode.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-stone-600">
            {NORMALIZATION_MODES.find((m) => m.id === normalization)?.desc}
          </p>
        </div>
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <>
          <SectionTitle icon={TrendingUp} title="Financials" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            {ABSOLUTE_METRICS.map((m) => (
              <ComparisonChart key={m.key} title={m.label}
                series={normalizeSeries(buildSeriesForMetric(m.key, m.format), normalization, m.key)}
                format={effectiveFormat(m.format)} height={280}
              />
            ))}
          </div>
        </>
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <>
          <SectionTitle icon={Percent} title="Ratios & Margins" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            {RATIO_METRICS.map((m) => (
              <ComparisonChart key={m.key} title={m.label} series={buildRatioSeries(m)} format="percent" height={260} />
            ))}
          </div>
        </>
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <>
          <SectionTitle icon={BarChart3} title="Growth Rates (CAGR)" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            <GrowthBarChart title="5-Year CAGR" groups={buildGrowthGroups('5y')} companies={companies} />
            <GrowthBarChart title="10-Year CAGR" groups={buildGrowthGroups('10y')} companies={companies} />
          </div>
        </>
      )}

      {companies.length === 0 && (
        <div className="border-2 border-dashed border-stone-800 p-12 text-center">
          <GitCompare className="w-12 h-12 text-stone-700 mx-auto mb-4" />
          <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">Add Companies To Compare</p>
          <p className="text-stone-600 text-xs max-w-md mx-auto">
            Click a peer group above, or type a ticker. You'll see financial charts, ratios, growth
            rates, and a head-to-head snapshot table.
          </p>
        </div>
      )}

      {companies.length > 0 && allLoaded && (
        <p className="mt-6 text-[11px] text-stone-500 leading-relaxed">
          Source: SEC XBRL Company Facts. Values are as originally reported in 10-K filings.
          Gaps in lines indicate missing data. Ratios are computed from reported values and may
          differ slightly from company-published non-GAAP versions. Click any snapshot value
          to open the source filing on SEC.gov.
        </p>
      )}
    </>
  );
}

// ============================================================================
// Sub-components — preserved verbatim from original ComparePage.jsx
// ============================================================================

function SectionTitle({ icon: Icon, title }: { icon: any; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4 pb-2 border-b-2 border-stone-800">
      <Icon className="w-5 h-5 text-amber-400" />
      <h3 className="text-sm uppercase tracking-[0.25em] font-black text-stone-200">{title}</h3>
    </div>
  );
}

interface SnapshotTableProps {
  data: AnyValue[];
  companies: CompanyState[];
}

function SnapshotTable({ data, companies }: SnapshotTableProps) {
  const loadedCompanies = companies.filter((c) => c.facts && !c.error);
  return (
    <div className="mb-8">
      <SectionTitle icon={Trophy} title="Head-to-Head Snapshot" />
      <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-900 border-b-2 border-stone-800">
            <tr>
              <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.25em] text-stone-400 sticky left-0 bg-stone-900 min-w-[180px]">Metric</th>
              {loadedCompanies.map((c) => (
                <th key={`${c.ticker}-${c.cik}`} className="text-right px-4 py-3 text-[10px] uppercase tracking-[0.2em] font-black min-w-[120px]" style={{ color: c.color }}>
                  {c.ticker}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row: AnyValue) => {
              const numericValues = row.values
                .map((v: AnyValue, i: number) => ({ idx: i, value: v.value }))
                .filter((v: AnyValue) => v.value != null && Number.isFinite(v.value));
              let bestIdx = -1, worstIdx = -1;
              if (numericValues.length > 1 && row.higherIsBetter !== null) {
                const sorted = [...numericValues].sort((a: AnyValue, b: AnyValue) => b.value - a.value);
                bestIdx = row.higherIsBetter ? sorted[0].idx : sorted[sorted.length - 1].idx;
                worstIdx = row.higherIsBetter ? sorted[sorted.length - 1].idx : sorted[0].idx;
              }
              return (
                <tr key={row.metric} className="border-b border-stone-800/60 hover:bg-amber-500/5">
                  <td className="px-4 py-2.5 text-stone-300 font-bold sticky left-0 bg-stone-950/95" title={row.tooltip}>
                    {row.metric}
                    {row.isComputed && <span className="ml-1.5 text-[9px] text-stone-600 font-normal italic tracking-normal">(computed)</span>}
                  </td>
                  {row.values.map((v: AnyValue, i: number) => (
                    <SnapshotCell key={i} value={v} row={row} isBest={i === bestIdx} isWorst={i === worstIdx} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-stone-600 leading-relaxed">
        Most recent fiscal year for each company. <span className="text-emerald-400">Green</span> = best,{' '}
        <span className="text-rose-400">Red</span> = worst where applicable. Total Assets is neutral
        (bigger isn't always better). Hover any value for the source XBRL tag; click to open SEC's
        concept endpoint. Computed ratios expose source icons for each formula input.
      </p>
    </div>
  );
}

interface SnapshotCellProps {
  value: AnyValue;
  row: AnyValue;
  isBest: boolean;
  isWorst: boolean;
}

function SnapshotCell({ value, row, isBest, isWorst }: SnapshotCellProps) {
  const formatted = formatSnapshotValue(value.value, row.format);
  const textClass = isBest ? 'text-emerald-400 font-black'
    : isWorst ? 'text-rose-400'
    : value.value == null ? 'text-stone-700' : 'text-stone-300';
  const sourceLinks = ((value.sources && value.sources.length > 0) ? value.sources : value.source ? [value.source] : [])
    .filter((source: AnyValue) => source?.tag);

  let tooltip;
  if (sourceLinks.length > 0) {
    if (row.isComputed) {
      tooltip = `Formula: ${value.formulaLabel || row.tooltip}\n\n${sourceLinks.map((source: AnyValue, index: number) => (
        `${source.label || `Input ${index + 1}`}\nTag: ${source.tag}\nUnit: ${source.unit}\nPeriod: ${source.end}\nFiled: ${source.filed}\nAccession: ${source.accession}`
      )).join('\n\n')}`;
    } else {
      const source = sourceLinks[0];
      tooltip = `Tag: ${source.tag}\nUnit: ${source.unit}\nPeriod: ${source.end}\nFiled: ${source.filed}\nAccession: ${source.accession}\nClick to open SEC source`;
    }
  } else if (row.tooltip) {
    tooltip = row.tooltip;
  } else {
    tooltip = value.value == null ? 'No data reported' : 'Computed value';
  }

  const linkedSources = sourceLinks
    .map((source: AnyValue) => ({ source, url: value.cik ? buildSourceUrl(value.cik, source) : null }))
    .filter((item: AnyValue) => item.url);
  if (!linkedSources.length || value.value == null) {
    return <td className={`px-4 py-2.5 text-right tabular-nums ${textClass}`} title={tooltip}>{formatted}</td>;
  }
  if (linkedSources.length === 1) {
    const only = linkedSources[0];
    return (
      <td className={`px-4 py-2.5 text-right tabular-nums group ${textClass}`} title={tooltip}>
        <a href={only.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-amber-400 transition-colors">
          {formatted}
          <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />
        </a>
      </td>
    );
  }
  return (
    <td className={`px-4 py-2.5 text-right tabular-nums group ${textClass}`} title={tooltip}>
      <span className="inline-flex items-center justify-end gap-1.5">
        <span>{formatted}</span>
        <span className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-70 transition-opacity">
          {linkedSources.slice(0, 4).map(({ source, url }: AnyValue, index: number) => (
            <a
              key={`${source.tag}-${source.end}-${index}`}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${source.label || `Input ${index + 1}`}\nTag: ${source.tag}\nUnit: ${source.unit}\nPeriod: ${source.end}\nFiled: ${source.filed}\nAccession: ${source.accession}\nClick to open SEC source`}
              aria-label={`Open SEC source for ${source.label || `input ${index + 1}`}`}
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

// ============================================================================
// GrowthBarChart — hand-rolled SVG, no Recharts.
//
// Preserved verbatim from the original ComparePage.jsx. The reason this is
// hand-rolled rather than using Recharts is that earlier attempts with
// Recharts color APIs failed three times — the library couldn't be reliably
// configured to use per-bar colors. This direct-SVG approach renders <rect>
// elements with inline fill attributes that no library can interfere with.
// ============================================================================
interface GrowthBarChartProps {
  title: string;
  groups: AnyValue[];
  companies: CompanyState[];
}

function GrowthBarChart({ title, groups, companies }: GrowthBarChartProps) {
  const loadedCompanies = companies.filter((c) => c.facts && !c.error);

  const width = 600;
  const height = 220;
  const padTop = 15;
  const padBottom = 50;
  const padLeft = 45;
  const padRight = 10;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const allValues = groups.flatMap((g: AnyValue) =>
    g.bars.map((b: AnyValue) => b.value).filter((v: AnyValue) => v != null && Number.isFinite(v))
  );
  let maxY = Math.max(0, ...allValues);
  let minY = Math.min(0, ...allValues);
  const yRange = maxY - minY;
  if (yRange > 0) {
    maxY += yRange * 0.1;
    if (minY < 0) minY -= yRange * 0.05;
  } else {
    maxY = 10;
    minY = -5;
  }

  const hasData = allValues.length > 0;
  if (!hasData) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-4">
        <div className="flex items-center justify-between mb-3 px-2">
          <span className="text-xs uppercase tracking-[0.2em] text-amber-400 font-bold">{title}</span>
        </div>
        <div className="flex flex-wrap gap-3 mb-3 px-2">
          {loadedCompanies.map((c) => (
            <div key={`${c.ticker}-${c.cik}`} className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider">
              <span className="inline-block w-3 h-3" style={{ backgroundColor: c.color }} />
              <span style={{ color: c.color }}>{c.ticker}</span>
            </div>
          ))}
        </div>
        <div className="h-[180px] flex items-center justify-center text-stone-600 text-xs">
          Not enough historical data for 10-year CAGR
        </div>
      </div>
    );
  }

  const yScale = (v: number | null): number | null => {
    if (v == null || !Number.isFinite(v)) return null;
    return padTop + plotHeight - ((v - minY) / (maxY - minY)) * plotHeight;
  };
  const zeroY = yScale(0)!;

  const groupCount = groups.length;
  const groupWidth = plotWidth / groupCount;
  const groupPadding = groupWidth * 0.1;
  const innerGroupWidth = groupWidth - groupPadding * 2;
  const barsPerGroup = loadedCompanies.length;
  const barGap = 2;
  const barWidth = Math.max(4, (innerGroupWidth - barGap * (barsPerGroup - 1)) / barsPerGroup);

  const gridLines: { value: number; y: number }[] = [];
  const step = (maxY - minY) / 4;
  for (let i = 0; i <= 4; i++) {
    const v = minY + step * i;
    const y = yScale(v);
    if (y != null) gridLines.push({ value: v, y });
  }

  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-4">
      <div className="flex items-center justify-between mb-3 px-2">
        <span className="text-xs uppercase tracking-[0.2em] text-amber-400 font-bold">{title}</span>
      </div>

      <div className="flex flex-wrap gap-3 mb-3 px-2">
        {loadedCompanies.map((c) => (
          <div key={`${c.ticker}-${c.cik}`} className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider">
            <span className="inline-block w-3 h-3" style={{ backgroundColor: c.color }} />
            <span style={{ color: c.color }}>{c.ticker}</span>
          </div>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ fontFamily: 'ui-monospace, monospace' }}
      >
        {gridLines.map((line, i) => (
          <g key={i}>
            <line
              x1={padLeft}
              y1={line.y}
              x2={width - padRight}
              y2={line.y}
              stroke="#44403c"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
            <text
              x={padLeft - 5}
              y={line.y + 3}
              textAnchor="end"
              fontSize="10"
              fill="#a8a29e"
            >
              {line.value.toFixed(0)}%
            </text>
          </g>
        ))}

        {minY < 0 && (
          <line
            x1={padLeft}
            y1={zeroY}
            x2={width - padRight}
            y2={zeroY}
            stroke="#78716c"
            strokeWidth="1.5"
          />
        )}

        {groups.map((group: AnyValue, gIdx: number) => {
          const groupX = padLeft + gIdx * groupWidth + groupPadding;
          const labelY = height - padBottom + 30;

          return (
            <g key={group.metric}>
              <text
                x={groupX + innerGroupWidth / 2}
                y={labelY}
                textAnchor="middle"
                fontSize="10"
                fill="#a8a29e"
                fontWeight="bold"
                style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}
              >
                {group.metric}
              </text>

              {group.bars.map((bar: AnyValue, bIdx: number) => {
                const x = groupX + bIdx * (barWidth + barGap);
                const barY = yScale(bar.value);
                if (barY == null) return null;

                const barTop = Math.min(barY, zeroY);
                const barHeight = Math.abs(barY - zeroY);

                return (
                  <g key={`${group.metric}-${bar.ticker}`}>
                    <rect
                      x={x}
                      y={barTop}
                      width={barWidth}
                      height={Math.max(1, barHeight)}
                      fill={bar.color}
                      stroke={bar.color}
                      strokeWidth="0.5"
                    >
                      <title>{`${group.metric} — ${bar.ticker}: ${bar.value != null ? bar.value.toFixed(1) + '%' : 'N/A'}`}</title>
                    </rect>

                    <text
                      x={x + barWidth / 2}
                      y={height - padBottom + 12}
                      textAnchor="middle"
                      fontSize="9"
                      fill={bar.color}
                      fontWeight="bold"
                    >
                      {bar.ticker}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        <line
          x1={padLeft}
          y1={height - padBottom}
          x2={width - padRight}
          y2={height - padBottom}
          stroke="#57534e"
          strokeWidth="1"
        />
      </svg>
    </div>
  );
}

function formatSnapshotValue(value: number | null, format: string): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (format === 'percent') return `${value.toFixed(1)}%`;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
