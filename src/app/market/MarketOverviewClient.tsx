'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Boxes,
  Database,
  ExternalLink,
  FileSearch,
  Gauge,
  GitCompare,
  Loader2,
  Network,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import GeographicEvidencePanel from '../../components/GeographicEvidencePanel';

type Tone = 'expansion' | 'caution' | 'stress' | 'neutral';

interface CompanySignal {
  ticker: string;
  name: string;
  score?: number;
  revenueGrowth?: number | null;
  operatingMargin?: number | null;
  liabilitiesToAssets?: number | null;
  latestFiled?: string | null;
  textCount?: number;
  conceptCount?: number;
  portfolioType?: string;
  excerpts?: Array<{ category: string; term: string; excerpt: string }>;
  latestFilingUrl?: string | null;
}

interface Lens {
  id: string;
  assetClass: string;
  title: string;
  description: string;
  loadedTickers: string[];
  failedTickers: Array<{ ticker: string; error: string }>;
  kpis: string[];
  disclosureTerms: string;
  pressureLanguage: string;
  averages: Record<string, number | null>;
  metricSummary: Record<string, { average: number | null; median: number | null; min: number | null; max: number | null; coverage: number }>;
  breadth: Record<string, number | null>;
  tone: Tone;
  score: number;
  headline: string;
  evidenceCount: number;
  coveragePct: number;
  latestFiled: string | null;
  leaders: CompanySignal[];
  laggards: CompanySignal[];
  companies: CompanySignal[];
}

interface WeatherItem {
  id: string;
  label: string;
  description: string;
  score: number;
  tone: Tone;
  evidenceCount: number;
  topCompanies: CompanySignal[];
}

interface ExposureIndex {
  id: string;
  label: string;
  description: string;
  direction: 'risk' | 'growth';
  score: number;
  tone: Tone;
  components: Array<{ label: string; value: number | null }>;
  leaders: CompanySignal[];
}

interface TradeBookAtlas {
  scannedFilers: number;
  assetClasses: Array<{
    id: string;
    label: string;
    companyCount: number;
    textMentions: number;
    conceptCount: number;
    companies: CompanySignal[];
  }>;
  portfolioTypes: Array<{
    type: string;
    companyCount: number;
    tickers: string[];
  }>;
  exposureNetwork: Array<{
    source: string;
    target: string;
    portfolioType: string;
    weight: number;
  }>;
}

interface DerivativesDashboard {
  summary: {
    companiesWithSignals: number;
    conceptsExtracted: number;
    textFilersScanned: number;
    aggregateDerivativeAssets: number;
    aggregateDerivativeLiabilities: number;
    aggregateDerivativeNotional: number;
  };
  companies: Array<CompanySignal & {
    assetValue: number;
    liabilityValue: number;
    notionalValue: number;
  }>;
  byAssetClass: Array<{
    label: string;
    conceptCount: number;
    usdValue: number;
    filers: string[];
  }>;
  byInstrument: Array<{
    label: string;
    conceptCount: number;
    usdValue: number;
    filers: string[];
  }>;
}

interface AggregateUniverse {
  scope: string;
  companyCount: number;
  lensCount: number;
  latestFiled: string | null;
  totalAssets: number;
  totalLiabilities: number;
  totalDebt: number;
  totalCashAndShortTermInvestments: number;
  totalRevenue: number;
  totalOperatingCashFlow: number;
  totalCapex: number;
  totalInventory: number;
  derivativeAssets: number;
  derivativeLiabilities: number;
  derivativeNotional: number;
  xbrlFactsIdentified: number;
  totalTextMentions: number;
  totalDerivativeConcepts: number;
  capitalStack: Array<{
    id: string;
    label: string;
    value: number;
    kind: 'currency' | 'count';
    description: string;
  }>;
  riskTotals: Array<{
    id: string;
    label: string;
    companyCount: number;
    textMentions: number;
    conceptCount: number;
    signalMass: number;
    topTickers: string[];
  }>;
  lensMass: Array<{
    id: string;
    assetClass: string;
    title: string;
    loadedTickers: string[];
    evidenceCount: number;
    score: number;
    tone: Tone;
    totalAssets: number;
    totalRevenue: number;
  }>;
}

interface GeographicRegion {
  id: string;
  name: string;
  lat: number;
  lon: number;
  intensity: number;
  tone: string;
  metric: number;
  metricLabel: string;
  description: string;
  drivers: string[];
  tickers: string[];
}

interface MarketPayload {
  generatedAt: string;
  source: {
    name: string;
    forms: string;
    methodology: string;
  };
  universe: {
    requestedTickers: number;
    resolvedTickers: number;
    loadedCompanies: number;
    erroredCompanies: number;
    textFilersScanned: number;
    lenses: number;
    latestFiled: string | null;
  };
  lenses: Lens[];
  weatherMap: WeatherItem[];
  exposureIndexes: ExposureIndex[];
  tradeBookAtlas: TradeBookAtlas;
  derivativesDashboard: DerivativesDashboard;
  aggregateUniverse: AggregateUniverse;
  geographicExposure: GeographicRegion[];
  observedHistory?: Array<{ observedAt: string; companies: number; totalAssets: number; totalLiabilities: number }>;
  historyPersistence?: boolean;
  error?: string;
}

const EMPTY_TRADE_BOOK_ATLAS: TradeBookAtlas = {
  scannedFilers: 0,
  assetClasses: [],
  portfolioTypes: [],
  exposureNetwork: [],
};

const EMPTY_DERIVATIVES_DASHBOARD: DerivativesDashboard = {
  summary: {
    companiesWithSignals: 0,
    conceptsExtracted: 0,
    textFilersScanned: 0,
    aggregateDerivativeAssets: 0,
    aggregateDerivativeLiabilities: 0,
    aggregateDerivativeNotional: 0,
  },
  companies: [],
  byAssetClass: [],
  byInstrument: [],
};

const EMPTY_AGGREGATE_UNIVERSE: AggregateUniverse = {
  scope: 'Covered SEC filing universe',
  companyCount: 0,
  lensCount: 0,
  latestFiled: null,
  totalAssets: 0,
  totalLiabilities: 0,
  totalDebt: 0,
  totalCashAndShortTermInvestments: 0,
  totalRevenue: 0,
  totalOperatingCashFlow: 0,
  totalCapex: 0,
  totalInventory: 0,
  derivativeAssets: 0,
  derivativeLiabilities: 0,
  derivativeNotional: 0,
  xbrlFactsIdentified: 0,
  totalTextMentions: 0,
  totalDerivativeConcepts: 0,
  capitalStack: [],
  riskTotals: [],
  lensMass: [],
};

function normalizeMarketPayload(payload: any): MarketPayload {
  const lenses = Array.isArray(payload?.lenses) ? payload.lenses : [];

  return {
    generatedAt: payload?.generatedAt || new Date().toISOString(),
    source: payload?.source || {
      name: 'SEC Company Facts API',
      forms: 'Latest annual and quarterly XBRL facts where available',
      methodology: 'Curated public-company cohorts grouped into asset-class filing lenses.',
    },
    universe: {
      requestedTickers: payload?.universe?.requestedTickers ?? 0,
      resolvedTickers: payload?.universe?.resolvedTickers ?? 0,
      loadedCompanies: payload?.universe?.loadedCompanies ?? 0,
      erroredCompanies: payload?.universe?.erroredCompanies ?? 0,
      textFilersScanned: payload?.universe?.textFilersScanned ?? 0,
      lenses: payload?.universe?.lenses ?? lenses.length,
      latestFiled: payload?.universe?.latestFiled ?? null,
    },
    lenses,
    weatherMap: Array.isArray(payload?.weatherMap) ? payload.weatherMap : [],
    exposureIndexes: Array.isArray(payload?.exposureIndexes) ? payload.exposureIndexes : [],
    tradeBookAtlas: payload?.tradeBookAtlas || EMPTY_TRADE_BOOK_ATLAS,
    derivativesDashboard: payload?.derivativesDashboard || EMPTY_DERIVATIVES_DASHBOARD,
    aggregateUniverse: payload?.aggregateUniverse || EMPTY_AGGREGATE_UNIVERSE,
    geographicExposure: Array.isArray(payload?.geographicExposure) ? payload.geographicExposure : [],
  };
}

function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

function formatRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}x`;
}

function formatScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}`;
}

function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatCompactCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(1)}T`;
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${value.toFixed(0)}`;
}

function formatValue(kind: 'currency' | 'count', value: number): string {
  return kind === 'currency' ? formatCompactCurrency(value) : formatNumber(value);
}

function kpiLabel(key: string): string {
  return {
    revenueGrowth: 'Revenue growth',
    quarterlyRevenuePulse: 'Quarterly pulse',
    netMargin: 'Net margin',
    operatingMargin: 'Operating margin',
    liabilitiesToAssets: 'Liabilities/assets',
    debtToAssets: 'Debt/assets',
    capexIntensity: 'Capex intensity',
    cashConversion: 'Cash conversion',
    inventoryToSales: 'Inventory/sales',
    interestBurden: 'Interest burden',
    provisionToLoans: 'Provision/loans',
    depositsToLoans: 'Deposits/loans',
    loanGrowth: 'Loan growth',
    assetGrowth: 'Asset growth',
    cashAndInvestmentsToAssets: 'Cash + investments/assets',
    rndIntensity: 'R&D intensity',
  }[key] || key;
}

function formatKpi(key: string, value: number | null | undefined): string {
  if (key === 'cashConversion' || key === 'depositsToLoans') return formatRatio(value);
  return formatPercent(value);
}

function toneClasses(tone: Tone): string {
  if (tone === 'expansion') return 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200';
  if (tone === 'stress') return 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200';
  if (tone === 'caution') return 'border-violet-500/40 bg-violet-500/10 text-violet-200';
  return 'border-sky-500/40 bg-sky-500/10 text-sky-200';
}

function toneLabel(tone: Tone): string {
  if (tone === 'expansion') return 'Constructive';
  if (tone === 'stress') return 'Heavy';
  if (tone === 'caution') return 'Watch';
  return 'Stable';
}

function disclosureHref(lens: Lens | { disclosureTerms: string; loadedTickers?: string[] }): string {
  const params = new URLSearchParams({
    query: lens.disclosureTerms,
    focus: (lens.loadedTickers || []).slice(0, 5).join(','),
  });
  return `/disclosures?${params.toString()}`;
}

function compareHref(tickers: string[]): string {
  return `/compare/${tickers.slice(0, 5).join(',')}`;
}

function analysisHref(ticker: string): string {
  return `/analysis/${ticker}`;
}

function topMarketTone(lenses: Lens[]) {
  const heavy = lenses.filter((lens) => lens.tone === 'stress').length;
  const watch = lenses.filter((lens) => lens.tone === 'caution').length;
  const constructive = lenses.filter((lens) => lens.tone === 'expansion').length;

  if (heavy >= 3) return 'Heavy risk pockets';
  if (watch + heavy >= constructive + 2) return 'Mixed / watch list';
  if (constructive >= watch + heavy) return 'Constructive filing tone';
  return 'Balanced filing tone';
}

export default function MarketOverviewClient() {
  const [data, setData] = useState<MarketPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/market-overview?aggregate=v3&t=${Date.now()}`, { cache: 'no-store' });
        const payload = await res.json();

        if (!res.ok) {
          throw new Error(payload?.error || `Market overview API failed (${res.status})`);
        }

        if (!cancelled) setData(normalizeMarketPayload(payload));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  const lenses = data?.lenses || [];

  const summary = useMemo(() => {
    const leaders = [...lenses].sort((a, b) => b.score - a.score).slice(0, 3);
    const watches = [...lenses].sort((a, b) => a.score - b.score).slice(0, 3);

    return {
      leaders,
      watches,
      marketTone: topMarketTone(lenses),
    };
  }, [lenses]);

  return (
    <>
      <section className="professional-card mb-8 overflow-hidden rounded-[1.7rem] border border-white/10 p-6 md:p-8">
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_460px] xl:items-center">
          <div>
            <div className="eyebrow mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.24em] text-cyan-200">
              <Activity className="h-3.5 w-3.5" />
              SEC Aggregate Market Atlas
            </div>

            <h1 className="max-w-4xl text-4xl font-black leading-[0.96] tracking-tight text-white md:text-6xl">
              Market research across covered companies.
            </h1>

            <p className="mt-5 max-w-3xl text-sm leading-7 text-slate-300 md:text-base">
              This page aggregates what the covered SEC filing universe says about assets, liabilities, debt,
              cash, revenue, capex, derivatives, risk books, market-risk language, and geography-linked exposure proxies.
              It is designed as a broad filing-derived market map, not a single-company dashboard.
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryTile label="Market read" value={loading ? 'Loading' : summary.marketTone} />
              <SummaryTile label="Companies loaded" value={data ? `${data.universe.loadedCompanies}/${data.universe.resolvedTickers}` : '—'} />
              <SummaryTile label="Aggregate assets" value={data ? formatCompactCurrency(data.aggregateUniverse.totalAssets) : '—'} />
              <SummaryTile label="Latest evidence" value={data?.universe.latestFiled || '—'} />
            </div>
          </div>

          <div className="rounded-[1.4rem] border border-white/10 bg-slate-950/50 p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-[10px] font-black uppercase tracking-[0.22em] text-cyan-200">
                  Aggregate filing scope
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  What was identified across the covered SEC filing universe.
                </div>
              </div>
              <ShieldCheck className="h-5 w-5 text-cyan-300" />
            </div>

            <div className="grid gap-3">
              <ScopeRow label="XBRL facts used" value={data ? formatNumber(data.aggregateUniverse.xbrlFactsIdentified) : '—'} />
              <ScopeRow label="Market-risk text mentions" value={data ? formatNumber(data.aggregateUniverse.totalTextMentions) : '—'} />
              <ScopeRow label="Derivative concepts" value={data ? formatNumber(data.aggregateUniverse.totalDerivativeConcepts) : '—'} />
              <ScopeRow label="Text filers scanned" value={data ? formatNumber(data.universe.textFilersScanned) : '—'} />
            </div>
          </div>
        </div>
      </section>

      {loading && (
        <div className="panel-card mb-8 rounded-2xl border border-white/10 p-5">
          <div className="flex items-center gap-3 text-sm text-slate-300">
            <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
            Building aggregate SEC market map. Cached results are reused when available.
          </div>
        </div>
      )}

      {error && (
        <div className="mb-8 rounded-2xl border-2 border-fuchsia-800/60 bg-fuchsia-950/30 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-fuchsia-300" />
            <div>
              <div className="text-sm font-black text-fuchsia-100">Could not load aggregate market atlas</div>
              <p className="mt-1 text-xs text-fuchsia-100/80">{error}</p>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <AggregateUniverseSection aggregate={data.aggregateUniverse} />
          <details className="panel-card mb-8 rounded-2xl border border-white/10 p-5"><summary className="cursor-pointer text-base font-semibold text-white">Observed cohort history</summary><p className="my-4 max-w-3xl text-sm leading-6 text-slate-400">Actual calculation dates for the covered companies. Totals can change as filings and coverage change; these observations do not reconstruct historical geographic exposures.{!data.historyPersistence && ' Shared history storage is unavailable; only this calculation can be retained for this response.'}</p><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-3">Observed date (UTC)</th><th className="p-3">Companies</th><th className="p-3">Total assets</th><th className="p-3">Total liabilities</th></tr></thead><tbody>{(data.observedHistory || []).slice().reverse().map((row) => <tr key={row.observedAt} className="border-t border-white/10 text-slate-200"><td className="p-3">{row.observedAt.slice(0, 10)}</td><td className="p-3">{row.companies}</td><td className="p-3">{formatCompactCurrency(row.totalAssets)}</td><td className="p-3">{formatCompactCurrency(row.totalLiabilities)}</td></tr>)}</tbody></table></div>{(data.observedHistory?.length || 0) < 2 && <p className="mt-3 text-sm text-slate-400">History starts when this version collects its first snapshot. A trend requires observations from more than one day.</p>}</details>

          <GlobalExposureSection regions={data.geographicExposure} aggregate={data.aggregateUniverse} />

          <MarketRiskWeatherMap items={data.weatherMap} />

          <AggregateRiskSurface aggregate={data.aggregateUniverse} />

          <ExposureIndexes indexes={data.exposureIndexes} />

          <TradeBookAtlas atlas={data.tradeBookAtlas} />

          <DerivativesExposureDashboard dashboard={data.derivativesDashboard} />

          <section className="mb-8 grid gap-4 lg:grid-cols-2">
            <MarketMoverPanel title="Largest constructive filing lenses" description="Asset-class lenses with the strongest aggregate filing signal." lenses={summary.leaders} />
            <MarketMoverPanel title="Aggregate watch-list lenses" description="Asset-class lenses with weaker growth, margin, leverage, or pressure signals." lenses={summary.watches} />
          </section>

          <AssetClassFilingMatrix data={data} />

          <section className="grid gap-4 xl:grid-cols-[1fr_0.8fr]">
            <div className="panel-card rounded-[1.4rem] border border-white/10 p-5">
              <div className="mb-3 flex items-center gap-2">
                <Database className="h-4 w-4 text-cyan-300" />
                <h3 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">
                  Methodology and caveats
                </h3>
              </div>
              <p className="text-sm leading-7 text-slate-400">
                This is a covered SEC filing universe, not every EDGAR filing yet. The page aggregates a broad
                curated public-company set using XBRL facts, derivative concepts, and bounded recent filing-text scans.
                Observed snapshots are retained when shared caching is configured. Scores are heuristic research signals, not calibrated risk probabilities.
              </p>
              <div className="mt-4 rounded-2xl border border-cyan-700/40 bg-cyan-950/20 p-4 text-xs leading-relaxed text-cyan-100/90">
                <strong className="text-cyan-200">Interpretation:</strong> geographic nodes are exposure proxies based on filing language and company cohorts.
                They are not headquarters counts and should be treated as a research overlay, not a definitive geographic revenue split.
              </div>
            </div>

            <div className="panel-card rounded-[1.4rem] border border-white/10 p-5">
              <div className="mb-3 flex items-center gap-2">
                <FileSearch className="h-4 w-4 text-sky-300" />
                <h3 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">
                  Disclosure research queue
                </h3>
              </div>
              <div className="space-y-3">
                {data.lenses.slice(0, 8).map((lens) => (
                  <Link
                    key={lens.id}
                    href={disclosureHref(lens)}
                    className="block rounded-2xl border border-white/10 bg-white/[0.035] p-3 transition-colors hover:border-cyan-300"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-black text-slate-100">{lens.assetClass}</div>
                      <ExternalLink className="h-3.5 w-3.5 text-slate-500" />
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-500">{lens.pressureLanguage}</p>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        </>
      )}
    </>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3">
      <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-2 text-lg font-black text-white">{value}</div>
    </div>
  );
}

function ScopeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3">
      <div className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="text-sm font-black text-white">{value}</div>
    </div>
  );
}

function AggregateUniverseSection({ aggregate }: { aggregate: AggregateUniverse }) {
  return (
    <section className="mb-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-cyan-300" />
            <h2 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">
              Aggregate SEC filing universe
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-6 text-slate-500">
            Broad filing-derived totals across the covered universe. This is the core aggregate view:
            how much balance-sheet, cash-flow, capex, inventory, derivative, and risk-book exposure was identified.
          </p>
        </div>
        <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
          {aggregate.companyCount} covered companies · latest evidence {aggregate.latestFiled || '—'}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {aggregate.capitalStack.map((item) => (
          <article key={item.id} className="panel-card rounded-[1.3rem] border border-white/10 p-4">
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">{item.label}</div>
            <div className="mt-3 text-2xl font-black tabular-nums text-white">{formatValue(item.kind, item.value)}</div>
            <p className="mt-2 text-xs leading-5 text-slate-500">{item.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}



function GlobalExposureSection({ regions, aggregate }: { regions: GeographicRegion[]; aggregate: AggregateUniverse }) {
  return <GeographicEvidencePanel regions={regions} aggregate={aggregate} />;
}

function MarketRiskWeatherMap({ items }: { items: WeatherItem[] }) {
  return (
    <section className="panel-card mb-8 rounded-[1.4rem] border border-white/10 p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-cyan-300" />
            <h2 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">
              Market risk weather map
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-6 text-slate-500">
            Reframed as filing heat, not a vague score. Each tile shows a pressure state, what the signal means,
            and which filers are driving the evidence.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <article key={item.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-black text-white">{item.label}</div>
                <p className="mt-1 text-xs leading-5 text-slate-500">{item.description}</p>
              </div>
              <span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-[0.15em] ${toneClasses(item.tone)}`}>
                {toneLabel(item.tone)}
              </span>
            </div>

            <div className="mb-3 grid grid-cols-[76px_1fr] items-center gap-3">
              <div className="grid h-[76px] w-[76px] place-items-center rounded-full border border-cyan-400/20 bg-cyan-400/5">
                <div className="text-center">
                  <div className="text-xl font-black text-white">{Math.round(item.score)}</div>
                  <div className="text-[8px] uppercase tracking-[0.14em] text-slate-500">heat</div>
                </div>
              </div>
              <div className="space-y-1.5 text-xs leading-5 text-slate-500">
                <div><span className="font-black text-slate-300">Evidence:</span> {formatNumber(item.evidenceCount)}</div>
                <div><span className="font-black text-slate-300">Drivers:</span> {(item.topCompanies || []).slice(0, 4).map((c) => c.ticker).join(', ') || '—'}</div>
                <div><span className="font-black text-slate-300">Reading:</span> {item.score >= 70 ? 'high filing intensity' : item.score >= 45 ? 'active watch area' : 'lower aggregate pressure'}</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(item.topCompanies || []).slice(0, 6).map((company) => (
                <Link key={company.ticker} href={analysisHref(company.ticker)} className="rounded-full border border-white/10 px-2 py-1 text-[10px] font-black text-slate-300 hover:border-cyan-300 hover:text-cyan-200">
                  {company.ticker}
                </Link>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AggregateRiskSurface({ aggregate }: { aggregate: AggregateUniverse }) {
  return (
    <section className="panel-card mb-8 rounded-[1.4rem] border border-white/10 p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-cyan-300" />
            <h2 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">
              Aggregate asset-class exposure surface
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-6 text-slate-500">
            Risk categories aggregated across filing text and derivative concepts. The visual emphasis is mass and coverage,
            not a red/yellow/green trading signal.
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <div className="space-y-3">
          {aggregate.riskTotals.slice(0, 8).map((risk) => (
            <div key={risk.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="font-black text-white">{risk.label}</div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{risk.companyCount} filers</div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <MiniMetric label="Mentions" value={formatNumber(risk.textMentions)} />
                <MiniMetric label="Concepts" value={formatNumber(risk.conceptCount)} />
                <MiniMetric label="Mass" value={formatNumber(risk.signalMass)} />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {risk.topTickers.map((ticker) => (
                  <Link key={ticker} href={analysisHref(ticker)} className="rounded-full border border-white/10 px-2 py-1 text-[10px] font-black text-slate-300 hover:border-cyan-300 hover:text-cyan-200">
                    {ticker}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
          <div className="mb-4 text-xs font-black uppercase tracking-[0.18em] text-slate-100">Asset-class mass by identified assets</div>
          <div className="space-y-3">
            {aggregate.lensMass.slice(0, 12).map((lens) => {
              const maxAssets = Math.max(...aggregate.lensMass.map((l) => l.totalAssets || 0), 1);
              const width = Math.max(4, (lens.totalAssets / maxAssets) * 100);

              return (
                <div key={lens.id}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                    <span className="font-black text-slate-200">{lens.assetClass}</span>
                    <span className="text-slate-500">{formatCompactCurrency(lens.totalAssets)}</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-400" style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2">
      <div className="text-[9px] uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-black text-white">{value}</div>
    </div>
  );
}

function ExposureIndexes({ indexes }: { indexes: ExposureIndex[] }) {
  return (
    <section className="mb-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-cyan-300" />
            <h2 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">
              Filing-derived exposure indexes
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-6 text-slate-500">
            Proprietary disclosure and exposure indexes. The presentation now separates evidence components from the headline state.
          </p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {indexes.map((index) => (
          <article key={index.id} className="panel-card rounded-[1.4rem] border border-white/10 p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-black text-white">{index.label}</h3>
                <p className="mt-1 text-xs leading-5 text-slate-500">{index.description}</p>
              </div>
              <span className={`rounded-full border px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.16em] ${toneClasses(index.tone)}`}>
                {toneLabel(index.tone)}
              </span>
            </div>

            <div className="mb-4 grid gap-3 md:grid-cols-[100px_1fr]">
              <div className="grid h-[100px] w-[100px] place-items-center rounded-[2rem] border border-cyan-400/20 bg-cyan-400/5">
                <div className="text-center">
                  <div className="text-3xl font-black text-white">{index.score.toFixed(0)}</div>
                  <div className="text-[9px] uppercase tracking-[0.14em] text-slate-500">index</div>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                {index.components.map((component) => (
                  <div key={component.label} className="rounded-2xl border border-white/10 bg-white/[0.035] p-3">
                    <div className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{component.label}</div>
                    <div className="mt-1 text-lg font-black text-white">
                      {typeof component.value === 'number' && Math.abs(component.value) > 100 ? component.value.toFixed(0) : formatPercent(component.value)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {index.leaders.slice(0, 6).map((company) => (
                <Link key={company.ticker} href={analysisHref(company.ticker)} className="rounded-full border border-white/10 px-2 py-1 text-[10px] font-black text-slate-300 hover:border-cyan-300 hover:text-cyan-200">
                  {company.ticker}
                </Link>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function TradeBookAtlas({ atlas }: { atlas: TradeBookAtlas }) {
  return (
    <section className="panel-card mb-8 rounded-[1.4rem] border border-white/10 p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-cyan-300" />
            <h2 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">
              Aggregate trade book atlas
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-6 text-slate-500">
            Trade-book signals aggregated by asset class, portfolio type, text mentions, derivative concepts,
            and exposure network mass.
          </p>
        </div>
        <div className="rounded-full border border-white/10 px-3 py-2 text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
          {atlas.scannedFilers} filing texts scanned
        </div>
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {atlas.portfolioTypes.map((portfolio) => (
          <div key={portfolio.type} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">{portfolio.type}</div>
            <div className="mt-2 text-2xl font-black text-white">{portfolio.companyCount}</div>
            <div className="mt-2 flex flex-wrap gap-1">
              {portfolio.tickers.slice(0, 8).map((ticker) => (
                <span key={ticker} className="rounded-full border border-white/10 px-1.5 py-0.5 text-[9px] text-slate-400">{ticker}</span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-3">
          {atlas.assetClasses.map((asset) => (
            <div key={asset.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="font-black text-white">{asset.label}</div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{asset.companyCount} filers</div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <MiniMetric label="Mentions" value={formatNumber(asset.textMentions)} />
                <MiniMetric label="Concepts" value={formatNumber(asset.conceptCount)} />
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
          <div className="mb-3 flex items-center gap-2">
            <Network className="h-4 w-4 text-cyan-300" />
            <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-100">Aggregate exposure network</div>
          </div>
          <div className="space-y-2">
            {atlas.exposureNetwork.slice(0, 22).map((edge, index) => (
              <div key={`${edge.source}-${edge.target}-${index}`} className="grid grid-cols-[70px_1fr_120px] items-center gap-3 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-2">
                <Link href={analysisHref(edge.source)} className="text-xs font-black text-cyan-200">{edge.source}</Link>
                <div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-400" style={{ width: `${Math.max(8, Math.min(100, edge.weight * 7))}%` }} />
                  </div>
                </div>
                <div className="text-right text-[10px] uppercase tracking-[0.12em] text-slate-500">{edge.target}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function DerivativesExposureDashboard({ dashboard }: { dashboard: DerivativesDashboard }) {
  return (
    <section className="panel-card mb-8 rounded-[1.4rem] border border-white/10 p-5">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-cyan-300" />
            <h2 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">
              Aggregate derivatives exposure dashboard
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-6 text-slate-500">
            Derivative-related XBRL concept extraction plus filing-text evidence for swaps, forwards, futures,
            options, hedging instruments, market-risk language, and VaR references.
          </p>
        </div>
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <MethodTile label="Derivative filers" value={String(dashboard.summary.companiesWithSignals)} />
        <MethodTile label="Concepts extracted" value={String(dashboard.summary.conceptsExtracted)} />
        <MethodTile label="Derivative assets" value={formatCompactCurrency(dashboard.summary.aggregateDerivativeAssets)} />
        <MethodTile label="Derivative liabilities" value={formatCompactCurrency(dashboard.summary.aggregateDerivativeLiabilities)} />
        <MethodTile label="Derivative notional" value={formatCompactCurrency(dashboard.summary.aggregateDerivativeNotional)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <DerivativeBreakdown title="By asset class" rows={dashboard.byAssetClass} />
        <DerivativeBreakdown title="By instrument type" rows={dashboard.byInstrument} />
      </div>

      <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
        <div className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-slate-100">Top derivative signal filers</div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {dashboard.companies.slice(0, 12).map((company) => (
            <Link key={company.ticker} href={analysisHref(company.ticker)} className="rounded-2xl border border-white/10 bg-white/[0.025] p-3 hover:border-cyan-300">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-black text-white">{company.ticker}</div>
                  <div className="mt-0.5 max-w-[180px] truncate text-[10px] text-slate-500">{company.name}</div>
                </div>
                <div className="text-right text-sm font-black text-cyan-200">{company.score}</div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                <MiniMetric label="Concepts" value={String(company.conceptCount)} />
                <MiniMetric label="Mentions" value={String(company.textCount)} />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function DerivativeBreakdown({ title, rows }: { title: string; rows: Array<{ label: string; conceptCount: number; usdValue: number; filers: string[] }> }) {
  const maxCount = Math.max(1, ...rows.map((row) => row.conceptCount));

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
      <div className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-slate-100">{title}</div>
      <div className="space-y-3">
        {rows.slice(0, 8).map((row) => (
          <div key={row.label}>
            <div className="mb-1 flex items-center justify-between gap-3 text-xs">
              <span className="font-bold text-slate-300">{row.label}</span>
              <span className="text-slate-500">{row.conceptCount} concepts</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-400" style={{ width: `${Math.max(6, (row.conceptCount / maxCount) * 100)}%` }} />
            </div>
            <div className="mt-1 text-[10px] text-slate-500">{row.filers.slice(0, 8).join(', ')}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AssetClassFilingMatrix({ data }: { data: MarketPayload }) {
  return (
    <section className="panel-card mb-8 rounded-[1.4rem] border border-white/10 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-cyan-300" />
            <h2 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">
              Asset-class filing matrix
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Cross-sectional filing metrics by asset-class lens.
          </p>
        </div>
        <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
          Generated {new Date(data.generatedAt).toLocaleString()}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[10px] uppercase tracking-[0.2em] text-slate-500">
              <th className="px-3 py-3">Lens</th>
              <th className="px-3 py-3">State</th>
              <th className="px-3 py-3 text-right">Score</th>
              <th className="px-3 py-3 text-right">Growth</th>
              <th className="px-3 py-3 text-right">Q pulse</th>
              <th className="px-3 py-3 text-right">Margin</th>
              <th className="px-3 py-3 text-right">Debt/assets</th>
              <th className="px-3 py-3 text-right">Capex</th>
              <th className="px-3 py-3 text-right">Positive breadth</th>
              <th className="px-3 py-3 text-right">Coverage</th>
              <th className="px-3 py-3">Research trail</th>
            </tr>
          </thead>
          <tbody>
            {data.lenses.map((lens) => (
              <tr key={lens.id} className="border-b border-white/10 last:border-b-0">
                <td className="px-3 py-3">
                  <div className="font-black text-slate-100">{lens.assetClass}</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">{lens.loadedTickers.slice(0, 7).join(', ')}{lens.loadedTickers.length > 7 ? '…' : ''}</div>
                </td>
                <td className="px-3 py-3">
                  <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-[0.16em] ${toneClasses(lens.tone)}`}>
                    {toneLabel(lens.tone)}
                  </span>
                </td>
                <td className="px-3 py-3 text-right font-black tabular-nums">{formatScore(lens.score)}</td>
                <td className="px-3 py-3 text-right font-bold tabular-nums">{formatPercent(lens.averages.revenueGrowth)}</td>
                <td className="px-3 py-3 text-right font-bold tabular-nums">{formatPercent(lens.averages.quarterlyRevenuePulse)}</td>
                <td className="px-3 py-3 text-right font-bold tabular-nums">{formatPercent(lens.averages.operatingMargin ?? lens.averages.netMargin)}</td>
                <td className="px-3 py-3 text-right font-bold tabular-nums">{formatPercent(lens.averages.debtToAssets)}</td>
                <td className="px-3 py-3 text-right font-bold tabular-nums">{formatPercent(lens.averages.capexIntensity)}</td>
                <td className="px-3 py-3 text-right font-bold tabular-nums">{formatPercent(lens.breadth.positiveRevenuePct)}</td>
                <td className="px-3 py-3 text-right font-bold tabular-nums">{formatPercent(lens.coveragePct, 0)}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    <Link href={compareHref(lens.loadedTickers)} className="rounded-full border border-white/10 px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-300 hover:border-cyan-300 hover:text-cyan-200">
                      Compare
                    </Link>
                    <Link href={disclosureHref(lens)} className="rounded-full border border-white/10 px-2 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-300 hover:border-cyan-300 hover:text-cyan-200">
                      Disclosures
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MarketMoverPanel({ title, description, lenses }: { title: string; description: string; lenses: Lens[] }) {
  return (
    <div className="panel-card rounded-[1.4rem] border border-white/10 p-5">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-cyan-300" />
          <h3 className="text-sm font-black uppercase tracking-[0.22em] text-slate-100">{title}</h3>
        </div>
        <p className="mt-1 text-xs text-slate-500">{description}</p>
      </div>

      <div className="space-y-3">
        {lenses.map((lens) => (
          <div key={lens.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-black text-slate-100">{lens.assetClass}</div>
                <p className="mt-1 text-xs leading-5 text-slate-500">{lens.headline}</p>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Score</div>
                <div className="text-lg font-black tabular-nums text-white">{formatScore(lens.score)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MethodTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-3">
      <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-2 text-sm font-black text-white">{value}</div>
    </div>
  );
}
