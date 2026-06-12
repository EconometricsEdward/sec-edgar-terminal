'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ShieldAlert,
  Landmark,
  ExternalLink,
  AlertCircle,
  Loader2,
  Activity,
  Droplets,
  Scale,
  TrendingUp,
  FileText,
  Info,
} from 'lucide-react';

// ---- Types mirroring /api/risk ----------------------------------------------
type Zone = { level: 'low' | 'moderate' | 'elevated' | 'high' | 'info' | 'na'; label: string };
type Source = { tag: string; end: string | null; accession: string | null; url: string | null };
type SeriesPoint = { fy: number; end: string | null; value: number | null };
type Metric = {
  id: string;
  label: string;
  pillar: 'credit' | 'capital' | 'liquidity' | 'profitability';
  format: 'x' | 'pct' | 'usd' | 'ratio' | 'count';
  value: number | null;
  prior: number | null;
  delta: number | null;
  deltaGoodWhenDown: boolean;
  zone: Zone;
  why: string;
  note: string | null;
  series: SeriesPoint[];
  sources: Source[];
};
type ZInput = { id: string; label: string; ratio: number; weight: number; contribution: number };
type ZScore = {
  value: number | null;
  zone: Zone;
  inputs?: ZInput[];
  formula: string;
  thresholds: { safe: number; distress: number };
  fiscalYear: number | null;
  sources: Source[];
  caution: string | null;
  missing?: string[];
};
type ScanTerm = { term: string; count: number; excerpts: string[] };
type FilingScan = {
  form: string;
  filingDate: string;
  reportDate?: string;
  url: string;
  accession?: string;
  terms: ScanTerm[];
  error: string | null;
} | null;
type RiskData = {
  ticker: string;
  cik: string;
  companyName: string;
  sic: string | null;
  sicDescription: string | null;
  industry: { group: string; label: string; isFinancial: boolean; isBank: boolean };
  periods: { fy: number; end: string }[];
  zScore: ZScore | null;
  metrics: Metric[];
  watchItems: { id: string; label: string; severity: string; pillar: string }[];
  notes: string[];
  filingScan: FilingScan;
  generatedAt: string;
};

const EXAMPLES = ['JPM', 'BAC', 'AAPL', 'F', 'CCL', 'XOM'];

const PILLARS: { id: Metric['pillar']; label: string; icon: typeof Activity; blurb: string; bankBlurb?: string }[] = [
  {
    id: 'credit',
    label: 'Credit & default risk',
    icon: ShieldAlert,
    blurb: 'Can this company service and repay what it owes — and how close is it to the edge.',
    bankBlurb: 'The loan book is the bank: how much is going bad, what cushion is reserved against it, and what losses are flowing through earnings.',
  },
  {
    id: 'capital',
    label: 'Capital & leverage',
    icon: Scale,
    blurb: 'How the balance sheet is financed, and how much loss the equity layer can absorb.',
  },
  {
    id: 'liquidity',
    label: 'Liquidity & funding',
    icon: Droplets,
    blurb: 'Whether near-term obligations are covered without forced selling or emergency borrowing.',
    bankBlurb: 'Banks fail through funding before they fail through capital — deposit stability and the loans-to-deposits balance are the early signals.',
  },
  {
    id: 'profitability',
    label: 'Earnings stability',
    icon: TrendingUp,
    blurb: 'Earnings power is the first line of defense against every other risk on this page.',
  },
];

// ---- Formatting --------------------------------------------------------------
function fmtValue(value: number | null, format: Metric['format']): string {
  if (value == null || !Number.isFinite(value)) return '—';
  switch (format) {
    case 'x':
      return `${value.toFixed(2)}×`;
    case 'pct':
      return `${(value * 100).toFixed(value * 100 >= 10 ? 1 : 2)}%`;
    case 'usd':
      return fmtUsd(value);
    case 'count':
      return String(value);
    default:
      return value.toFixed(2);
  }
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toLocaleString()}`;
}

function fmtDate(d?: string) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const ZONE_STYLES: Record<Zone['level'], string> = {
  low: 'border-emerald-800/70 bg-emerald-950/30 text-emerald-300',
  moderate: 'border-sky-800/70 bg-sky-950/30 text-sky-300',
  elevated: 'border-amber-800/70 bg-amber-950/40 text-amber-300',
  high: 'border-rose-800/70 bg-rose-950/30 text-rose-300',
  info: 'border-stone-700 bg-stone-900/40 text-stone-400',
  na: 'border-stone-800 bg-stone-900/30 text-stone-600',
};

function ZoneChip({ zone }: { zone: Zone }) {
  return (
    <span className={`inline-block text-[10px] uppercase tracking-[0.18em] font-black px-2 py-0.5 border ${ZONE_STYLES[zone.level] || ZONE_STYLES.na}`}>
      {zone.label}
    </span>
  );
}

// ---- Page --------------------------------------------------------------------
export default function RiskClient({ initialTicker = '' }: { initialTicker?: string }) {
  const [ticker, setTicker] = useState(initialTicker);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RiskData | null>(null);

  const run = useCallback(async (symbol: string) => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/risk?ticker=${encodeURIComponent(sym)}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `Request failed (${res.status}).`);
        setLoading(false);
        return;
      }
      setData(json);
      try {
        window.history.replaceState(null, '', `/risk?ticker=${encodeURIComponent(sym)}`);
      } catch {
        /* no-op */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (initialTicker) run(initialTicker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert className="w-5 h-5 text-amber-500" />
          <h1 className="text-xl font-black uppercase tracking-tight">
            Risk <span className="text-stone-500">/</span> Company Risk Profile
          </h1>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed max-w-3xl">
          A multi-pillar risk read built entirely from SEC primary data — credit and default risk
          first, then capital, liquidity, and earnings stability. Non-financial companies get the
          Altman Z&Prime;-Score with every input shown; banks get the lens that actually fits them:
          reserve coverage, provisions, capital, and funding. Each number links to its XBRL source
          on SEC.gov, and the latest 10-K is scanned for credit-risk language.
        </p>
      </div>

      {/* Input */}
      <div className="border-2 border-stone-800 bg-stone-900/40 p-4 mb-6">
        <label className="block text-[10px] uppercase tracking-widest text-stone-500 mb-2">
          Company ticker
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run(ticker);
            }}
            placeholder="e.g. JPM"
            spellCheck={false}
            className="flex-1 bg-stone-950 border border-stone-700 px-3 py-2 text-sm font-mono uppercase tracking-wide text-stone-100 placeholder:text-stone-600 focus:outline-none focus:border-amber-600"
          />
          <button
            onClick={() => run(ticker)}
            disabled={loading || !ticker.trim()}
            className="inline-flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 font-bold text-sm uppercase tracking-wide px-5 py-2 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
            {loading ? 'Profiling' : 'Profile risk'}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          <span className="text-[10px] uppercase tracking-widest text-stone-600 mr-1">Try</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setTicker(ex);
                run(ex);
              }}
              className="text-[11px] font-mono px-2 py-0.5 border border-stone-700 text-stone-400 hover:border-amber-600 hover:text-amber-400 transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-3 text-stone-400 text-sm py-8 justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-amber-500" />
          Pulling XBRL facts and scanning the latest 10-K…
        </div>
      )}

      {error && !loading && (
        <div className="flex items-start gap-3 border-2 border-rose-900/60 bg-rose-950/20 p-4 text-sm mb-6">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-rose-300 font-semibold mb-0.5">Couldn&apos;t build the risk profile</div>
            <div className="text-stone-400">{error}</div>
          </div>
        </div>
      )}

      {data && !loading && <Results data={data} />}
    </>
  );
}

// ---- Results -----------------------------------------------------------------
function Results({ data }: { data: RiskData }) {
  const fyWindow =
    data.periods.length > 0
      ? `FY${data.periods[data.periods.length - 1]?.fy}–FY${data.periods[0]?.fy}`
      : null;

  return (
    <div className="space-y-6 mb-8">
      {/* Company header */}
      <div className="border-2 border-stone-800 bg-stone-900/40 p-4">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="text-amber-400 font-black tracking-wider text-lg">{data.ticker}</span>
          <span className="text-stone-500">·</span>
          <span className="text-stone-200 text-sm">{data.companyName}</span>
          {data.industry.isBank && (
            <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] font-black px-2 py-0.5 border border-amber-800/70 bg-amber-950/40 text-amber-300">
              <Landmark className="w-3 h-3" />
              Bank credit lens
            </span>
          )}
          {data.industry.isFinancial && !data.industry.isBank && (
            <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] font-black px-2 py-0.5 border border-sky-800/70 bg-sky-950/30 text-sky-300">
              Financial institution
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-widest text-stone-500">
          <span>Industry: {data.industry.label}</span>
          {data.sicDescription && (
            <>
              <span>/</span>
              <span>SIC {data.sic}: {data.sicDescription}</span>
            </>
          )}
          {fyWindow && (
            <>
              <span>/</span>
              <span>Window: {fyWindow} (10-K facts)</span>
            </>
          )}
        </div>
        {data.notes.length > 0 && (
          <div className="mt-3 space-y-2">
            {data.notes.map((n, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px] text-stone-400 leading-relaxed">
                <Info className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-0.5" />
                <span>{n}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Watch items */}
      {data.watchItems.length > 0 && (
        <div className="border-2 border-amber-900/50 bg-amber-950/15 p-4">
          <div className="text-[10px] uppercase tracking-[0.22em] font-black text-amber-400 mb-2">
            Watch items
          </div>
          <div className="flex flex-wrap gap-2">
            {data.watchItems.map((w) => (
              <span
                key={w.id}
                className={`text-[11px] px-2 py-1 border ${
                  w.severity === 'high'
                    ? 'border-rose-800/70 bg-rose-950/30 text-rose-300'
                    : 'border-amber-800/70 bg-amber-950/40 text-amber-300'
                }`}
              >
                {w.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Z'' gauge (non-financials) */}
      {data.zScore && <ZScoreCard z={data.zScore} ticker={data.ticker} />}

      {/* Pillars */}
      {PILLARS.map((pillar) => {
        const metrics = data.metrics.filter((m) => m.pillar === pillar.id);
        if (metrics.length === 0) return null;
        const Icon = pillar.icon;
        const blurb = data.industry.isBank && pillar.bankBlurb ? pillar.bankBlurb : pillar.blurb;
        return (
          <section key={pillar.id} className="border-2 border-stone-800 bg-stone-950/40">
            <div className="border-b-2 border-stone-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <Icon className="w-4 h-4 text-amber-400" />
                <h2 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
                  {pillar.label}
                </h2>
              </div>
              <p className="mt-1 text-[11px] text-stone-500">{blurb}</p>
            </div>
            <div className="divide-y divide-stone-800/70">
              {metrics.map((m) => (
                <MetricRow key={m.id} metric={m} />
              ))}
            </div>
          </section>
        );
      })}

      {/* Filing language scan */}
      {data.filingScan && <FilingScanCard scan={data.filingScan} />}

      {/* Methodology */}
      <div className="border-2 border-stone-800 bg-stone-900/30 p-4 text-[11px] leading-relaxed text-stone-500">
        <span className="font-bold text-stone-300 uppercase tracking-widest text-[10px]">Methodology: </span>
        All figures come from each filer&apos;s own XBRL tags via the SEC company facts API, annual
        (10-K) periods only, newest six fiscal years. The Altman Z&Prime;-Score is the published
        1995 four-variable model (safe &gt; 2.6, grey 1.1–2.6, distress &lt; 1.1) and is not
        defined for financial institutions, which get the bank credit lens instead. Risk bands are
        stated analyst conventions, not a proprietary score: interest coverage (8× / 3× / 1.5×),
        liabilities-to-equity (0.5 / 1.5 / 3), liabilities-to-assets (50 / 70 / 85%), OCF-to-debt
        (40 / 20 / 10%), current ratio (2 / 1.2 / 1), bank equity-to-assets (11 / 8 / 5%), reserve
        coverage (1.5 / 1.0 / 0.5% of gross loans), loans-to-deposits (80 / 100 / 110%). XBRL
        tagging varies by filer — anything a company doesn&apos;t tag at the consolidated level
        shows as N/A with a pointer to the 10-K note. Language counts are literal matches, not
        judgments. For research use only — not investment advice.
      </div>
    </div>
  );
}

// ---- Z'' gauge ----------------------------------------------------------------
function ZScoreCard({ z, ticker }: { z: ZScore; ticker: string }) {
  const hasValue = z.value != null;
  // Gauge geometry: map Z onto a 0–100% track. Distress zone occupies the left
  // third (ends at 1.1), grey the middle (1.1→2.6), safe the right (2.6→top).
  // Display range clamps to [-4, +8] so extreme values still sit on the track.
  const MIN = -4;
  const MAX = 8;
  const pos = hasValue ? Math.min(100, Math.max(0, ((z.value! - MIN) / (MAX - MIN)) * 100)) : null;
  const distressEnd = ((z.thresholds.distress - MIN) / (MAX - MIN)) * 100;
  const safeStart = ((z.thresholds.safe - MIN) / (MAX - MIN)) * 100;

  return (
    <section className="border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-amber-400" />
            <h2 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Altman Z&Prime;-Score — bankruptcy distance
            </h2>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            The published four-variable distress model for non-financial companies, computed from
            {' '}{ticker}&apos;s own balance sheet{z.fiscalYear ? ` (FY${z.fiscalYear})` : ''}. Formula: {z.formula}
          </p>
        </div>
        {hasValue && <ZoneChip zone={z.zone} />}
      </div>

      {hasValue ? (
        <div className="p-4">
          <div className="flex items-baseline gap-3 mb-4">
            <span className={`text-4xl font-black tabular-nums ${
              z.zone.level === 'low' ? 'text-emerald-300' : z.zone.level === 'elevated' ? 'text-amber-300' : 'text-rose-300'
            }`}>
              {z.value!.toFixed(2)}
            </span>
            <span className="text-[11px] uppercase tracking-widest text-stone-500">
              distress &lt; {z.thresholds.distress.toFixed(1)} · grey · safe &gt; {z.thresholds.safe.toFixed(1)}
            </span>
          </div>

          {/* The gauge */}
          <div className="relative h-3 w-full mb-1" aria-hidden="true">
            <div className="absolute inset-y-0 left-0 bg-rose-900/60" style={{ width: `${distressEnd}%` }} />
            <div className="absolute inset-y-0 bg-amber-900/50" style={{ left: `${distressEnd}%`, width: `${safeStart - distressEnd}%` }} />
            <div className="absolute inset-y-0 bg-emerald-900/50" style={{ left: `${safeStart}%`, right: 0 }} />
            {pos != null && (
              <div
                className="absolute -top-1 h-5 w-[3px] bg-stone-100 shadow-[0_0_6px_rgba(255,255,255,0.7)]"
                style={{ left: `calc(${pos}% - 1.5px)` }}
                title={`Z'' = ${z.value!.toFixed(2)}`}
              />
            )}
          </div>
          <div className="flex justify-between text-[9px] uppercase tracking-widest text-stone-600 mb-4">
            <span>Distress</span>
            <span>Grey zone</span>
            <span>Safe</span>
          </div>

          {/* Inputs */}
          {z.inputs && (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4 mb-3">
              {z.inputs.map((inp) => (
                <div key={inp.id} className="border border-stone-800 bg-stone-900/30 px-3 py-2">
                  <div className="text-[9px] uppercase tracking-widest text-stone-500 mb-1">{inp.label}</div>
                  <div className="font-mono text-sm text-stone-200">
                    {inp.ratio.toFixed(3)} <span className="text-stone-500">× {inp.weight}</span>
                  </div>
                  <div className={`text-[11px] font-mono ${inp.contribution >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {inp.contribution >= 0 ? '+' : ''}{inp.contribution.toFixed(2)} to Z&Prime;
                  </div>
                </div>
              ))}
            </div>
          )}

          {z.caution && (
            <div className="flex items-start gap-2 text-[11px] text-stone-400 leading-relaxed mb-2">
              <Info className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-0.5" />
              <span>{z.caution}</span>
            </div>
          )}

          <SourceLinks sources={z.sources} />
        </div>
      ) : (
        <div className="p-4 text-sm text-stone-400">
          Z&Prime; can&apos;t be computed for this filer — missing tagged inputs:{' '}
          <span className="font-mono text-stone-300">{(z.missing || []).join(', ')}</span>. Open the
          latest 10-K to read these directly.
        </div>
      )}
    </section>
  );
}

// ---- Metric row ----------------------------------------------------------------
function MetricRow({ metric }: { metric: Metric }) {
  const deltaSign = metric.delta == null ? null : metric.delta > 0 ? '+' : metric.delta < 0 ? '−' : '';
  const deltaImproving =
    metric.delta == null || metric.delta === 0
      ? null
      : metric.deltaGoodWhenDown
        ? metric.delta < 0
        : metric.delta > 0;

  return (
    <div className="px-4 py-3 grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_140px_110px_minmax(120px,0.5fr)] lg:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="text-sm font-bold text-stone-100 tracking-wide">{metric.label}</span>
          <ZoneChip zone={metric.zone} />
        </div>
        <p className="text-[11px] text-stone-500 leading-relaxed max-w-2xl">{metric.why}</p>
        {metric.note && (
          <p className="text-[11px] text-sky-300/80 leading-relaxed mt-1">{metric.note}</p>
        )}
        <div className="mt-1.5">
          <SourceLinks sources={metric.sources} />
        </div>
      </div>

      <div className="lg:text-right">
        <div className="font-mono text-lg font-black tabular-nums text-stone-100">
          {fmtValue(metric.value, metric.format)}
        </div>
        {metric.delta != null && metric.delta !== 0 && (
          <div className={`text-[11px] font-mono ${deltaImproving ? 'text-emerald-400' : 'text-rose-400'}`}>
            {deltaSign}
            {fmtValue(Math.abs(metric.delta), metric.format)} vs prior FY
          </div>
        )}
      </div>

      <TrendBars series={metric.series} />

      <div className="text-[10px] uppercase tracking-widest text-stone-600 lg:text-right">
        {metric.series.filter((p) => p.value != null).length > 1
          ? `FY${metric.series[0]?.fy}–FY${metric.series[metric.series.length - 1]?.fy}`
          : 'Latest FY only'}
      </div>
    </div>
  );
}

/** Tiny inline trend: one bar per fiscal year, oldest → newest. Negative values
 *  tint rose and hang below the midline so sign changes are visible at a glance. */
function TrendBars({ series }: { series: SeriesPoint[] }) {
  const vals = series.map((p) => p.value).filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length === 0) {
    return <div className="text-[10px] text-stone-700 uppercase tracking-widest">No trend</div>;
  }
  const maxAbs = Math.max(...vals.map((v) => Math.abs(v)), 1e-9);
  return (
    <div className="flex items-center gap-[3px] h-9" aria-hidden="true">
      {series.map((p, i) => {
        if (p.value == null) {
          return <div key={i} className="w-3 h-[2px] bg-stone-800 self-center" title={`FY${p.fy}: not tagged`} />;
        }
        const h = Math.max(3, Math.round((Math.abs(p.value) / maxAbs) * 30));
        const neg = p.value < 0;
        return (
          <div key={i} className="w-3 h-9 relative" title={`FY${p.fy}`}>
            <div
              className={`absolute left-0 right-0 ${neg ? 'bg-rose-700/80 top-1/2' : 'bg-amber-600/80 bottom-1/2'}`}
              style={{ height: `${(h / 36) * 50}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

function SourceLinks({ sources }: { sources: Source[] }) {
  const linked = sources.filter((s) => s.url);
  if (linked.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-[9px] uppercase tracking-widest text-stone-600">Source</span>
      {linked.map((s) => (
        <a
          key={s.tag}
          href={s.url!}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[10px] font-mono text-sky-400/90 hover:text-sky-300"
          title={`us-gaap:${s.tag}${s.end ? ` (period end ${s.end})` : ''}`}
        >
          {s.tag}
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
      ))}
    </span>
  );
}

// ---- Filing language scan -------------------------------------------------------
function FilingScanCard({ scan }: { scan: NonNullable<FilingScan> }) {
  const found = scan.terms.filter((t) => t.count > 0);
  const absent = scan.terms.filter((t) => t.count === 0);

  return (
    <section className="border-2 border-stone-800 bg-stone-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-stone-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-amber-400" />
            <h2 className="text-xs uppercase tracking-[0.22em] font-black text-stone-200">
              Credit-risk language in the latest 10-K
            </h2>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Literal, case-insensitive matches — where the language appears, not what it means.
            &ldquo;Covenant&rdquo; mentions are routine; &ldquo;substantial doubt&rdquo; in the
            auditor&apos;s report is not. Read each excerpt in context at the source.
          </p>
        </div>
        <a
          href={scan.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-sky-300 hover:text-sky-200"
        >
          {scan.form} filed {fmtDate(scan.filingDate)}
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {scan.error ? (
        <div className="p-4 text-sm text-stone-400">{scan.error}</div>
      ) : (
        <div className="p-4 space-y-4">
          {found.length === 0 && (
            <p className="text-sm text-stone-400">
              None of the tracked credit-risk phrases appear in this filing&apos;s text.
            </p>
          )}
          {found.map((t) => (
            <div key={t.term}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[11px] font-mono px-2 py-0.5 bg-amber-950/40 border border-amber-800/60 text-amber-200">
                  {t.term}
                </span>
                <span className="text-[10px] uppercase tracking-widest text-stone-500">
                  {t.count} mention{t.count === 1 ? '' : 's'}
                </span>
              </div>
              <div className="space-y-1.5">
                {t.excerpts.map((ex, i) => (
                  <p key={i} className="text-[12px] leading-relaxed text-stone-400 border-l-2 border-stone-700 pl-3">
                    {ex}
                  </p>
                ))}
              </div>
            </div>
          ))}
          {absent.length > 0 && (
            <div className="pt-1 text-[10px] uppercase tracking-widest text-stone-600">
              Not present: {absent.map((t) => t.term).join(' · ')}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
