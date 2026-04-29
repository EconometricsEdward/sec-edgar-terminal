'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Wallet, Loader2, AlertCircle, ExternalLink, Info, TrendingUp,
  Building2, Landmark, Calendar, FileText, PieChart, Link as LinkIcon,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================
interface FundClientProps {
  urlTicker: string;
  preloadedName: string | null;
  preloadedCik: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyValue = any;

// ============================================================================
// Asset category labels (preserved from FundPage.jsx)
// ============================================================================
const ASSET_CAT_LABELS: Record<string, string> = {
  'EC': 'Equity — Common',
  'EP': 'Equity — Preferred',
  'DBT': 'Debt',
  'RE': 'Real Estate',
  'LON': 'Loan',
  'DIR': 'Derivative — Interest Rate',
  'DCR': 'Derivative — Credit',
  'DFE': 'Derivative — FX',
  'DE': 'Derivative — Equity',
  'DCO': 'Derivative — Commodity',
  'DO': 'Derivative — Other',
  'RA': 'Repurchase Agreement',
  'SN': 'Structured Note',
  'STIV': 'Short-Term Investment',
  'UST': 'US Treasury',
  'MF': 'Mutual Fund',
  'ETF': 'ETF',
  'OTH': 'Other',
};

// ============================================================================
// FundClient — port from FundPage.jsx
//
// Loads /api/fund?ticker=... on mount when urlTicker is set. Server already
// resolved the company name + CIK via metadata, but the actual N-PORT
// holdings data is fetched here client-side because the response can be
// large (top 100 holdings + filings + asset breakdown) and isn't needed
// for SEO.
// ============================================================================
export default function FundClient({ urlTicker, preloadedName, preloadedCik }: FundClientProps) {
  const router = useRouter();
  const [data, setData] = useState<AnyValue>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-fetch when ticker is available
  useEffect(() => {
    if (!urlTicker) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;

    const loadFund = async () => {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const res = await fetch(`/api/fund?ticker=${encodeURIComponent(urlTicker)}`);
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled) setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadFund();
    return () => { cancelled = true; };
  }, [urlTicker]);

  const copyShareLink = () => {
    const url = `${window.location.origin}/fund/${urlTicker}`;
    navigator.clipboard.writeText(url);
  };

  const aum = useMemo(() => {
    if (!data?.fundInfo) return null;
    if (data.fundInfo.netAssets != null) return data.fundInfo.netAssets;
    if (data.fundInfo.totAssets != null && data.fundInfo.totLiabs != null) {
      return data.fundInfo.totAssets - data.fundInfo.totLiabs;
    }
    return null;
  }, [data]);

  const assetBreakdown = useMemo(() => {
    if (!data?.holdings?.length) return [];
    const byCategory = new Map<string, AnyValue>();
    let totalValue = 0;
    for (const h of data.holdings) {
      const key = h.assetCat || 'OTH';
      const current = byCategory.get(key) || {
        category: key,
        label: ASSET_CAT_LABELS[key] || key,
        value: 0,
        count: 0,
      };
      current.value += h.value || 0;
      current.count += 1;
      byCategory.set(key, current);
      totalValue += h.value || 0;
    }
    const result = Array.from(byCategory.values()).map((c) => ({
      ...c,
      pctOfNav: totalValue > 0 ? (c.value / totalValue) * 100 : 0,
    }));
    result.sort((a, b) => b.value - a.value);
    return result;
  }, [data]);

  // Display metadata — fall back to server-preloaded values while loading
  const displayName = data?.meta?.name || preloadedName;
  const displayCik = data?.cik || preloadedCik;

  return (
    <>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Wallet className="w-5 h-5 text-amber-500" />
          <h1 className="text-xl font-black uppercase tracking-tight">Mutual Funds & ETFs</h1>
        </div>
        {displayName && (
          <p className="text-sm text-stone-300 font-bold mb-1">
            {displayName} <span className="text-amber-400 font-black tracking-wider">({urlTicker})</span>
          </p>
        )}
        <p className="text-xs text-stone-400 leading-relaxed max-w-3xl">
          Holdings, assets, and filings for mutual funds and exchange-traded funds. Data comes
          directly from SEC&apos;s N-PORT monthly portfolio filings.
        </p>
      </div>

      {error && (
        <div className="mb-6 border-2 border-rose-800/60 bg-rose-950/30 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="text-sm text-rose-200">
            Failed to load fund data for {urlTicker}: {error}
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16 border-2 border-stone-800 bg-stone-900/30">
          <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
          <span className="ml-3 text-sm text-stone-400">
            Fetching fund data from SEC for {urlTicker}...
          </span>
        </div>
      )}

      {data && !data.isFund && !loading && (
        <NotAFundMessage data={data} router={router} preloadedName={preloadedName} preloadedCik={displayCik} urlTicker={urlTicker} />
      )}

      {data?.isFund && !loading && (
        <FundDisplay
          data={data}
          aum={aum}
          assetBreakdown={assetBreakdown}
          onShareLink={copyShareLink}
        />
      )}
    </>
  );
}

// ============================================================================
// NotAFundMessage — shown when the API confirms this isn't a fund
// ============================================================================

interface NotAFundMessageProps {
  data: AnyValue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router: any;
  preloadedName: string | null;
  preloadedCik: string | null;
  urlTicker: string;
}

function NotAFundMessage({ data, router, preloadedName, preloadedCik, urlTicker }: NotAFundMessageProps) {
  const displayName = data.name || preloadedName;
  const displayCik = data.cik || preloadedCik;
  return (
    <div className="border-2 border-sky-900/50 bg-sky-950/20 p-6">
      <div className="flex items-start gap-3">
        <Info className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
        <div>
          <div className="text-sm text-sky-200 font-bold mb-1">
            {urlTicker} doesn&apos;t appear to be a fund
          </div>
          <div className="text-xs text-stone-300 leading-relaxed mb-3">
            {displayName ? (
              <>
                Found <span className="font-bold text-stone-100">{displayName}</span> in SEC&apos;s
                database, but no N-PORT filings (the monthly portfolio disclosure required of
                funds). It looks like an operating company.
              </>
            ) : (
              <>No fund filings found for this ticker. It may be an operating company, or the ticker is not in SEC&apos;s database.</>
            )}
          </div>
          {displayCik && (
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => router.push(`/analysis/${urlTicker}`)}
                className="px-3 py-2 bg-stone-800 hover:bg-amber-500 hover:text-stone-950 text-stone-200 text-[11px] font-bold uppercase tracking-widest border-2 border-stone-700 hover:border-amber-500 transition-colors inline-flex items-center gap-1.5"
                type="button"
              >
                View as operating company
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => router.push(`/filings/${urlTicker}`)}
                className="px-3 py-2 bg-stone-800 hover:bg-amber-500 hover:text-stone-950 text-stone-200 text-[11px] font-bold uppercase tracking-widest border-2 border-stone-700 hover:border-amber-500 transition-colors inline-flex items-center gap-1.5"
                type="button"
              >
                View filings
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// FundDisplay — the main fund view (preserved layout from FundPage.jsx)
// ============================================================================

interface FundDisplayProps {
  data: AnyValue;
  aum: number | null;
  assetBreakdown: AnyValue[];
  onShareLink: () => void;
}

function FundDisplay({ data, aum, assetBreakdown, onShareLink }: FundDisplayProps) {
  const holdingsAsOfLabel = data.holdingsAsOf
    ? `As of ${data.holdingsAsOf} (filed ${data.holdingsFiledDate})`
    : 'Most recent';

  return (
    <>
      <div className="mb-6 border-2 border-stone-800 bg-stone-900/30 p-5">
        <div className="flex items-start justify-between flex-wrap gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] uppercase tracking-[0.2em] text-amber-400 font-bold">
                {data.meta.family}
              </span>
              <span className="text-stone-700">·</span>
              <span className="text-[10px] uppercase tracking-widest text-stone-500">
                CIK {data.cik}
              </span>
            </div>
            <h2 className="text-xl md:text-2xl font-black text-stone-100 mb-1 tracking-tight">
              {data.meta.name}
            </h2>
            <div className="text-[11px] text-stone-400">
              Ticker: <span className="font-bold text-amber-400">{data.ticker}</span>
              {data.meta.sicDescription && (
                <> · {data.meta.sicDescription}</>
              )}
            </div>
          </div>
          <button
            onClick={onShareLink}
            className="px-3 py-2 border-2 border-stone-700 text-stone-400 hover:border-amber-500 hover:text-amber-400 text-[11px] font-bold uppercase tracking-widest transition-colors inline-flex items-center gap-1.5 shrink-0"
            title="Copy shareable link"
            type="button"
          >
            <LinkIcon className="w-3.5 h-3.5" />
            Share
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={TrendingUp} label="Net Assets (AUM)" value={formatLargeCurrency(aum)} tone="amber" />
          <StatCard icon={Building2} label="Holdings Shown" value={`${data.holdings.length}`} tone="emerald" />
          <StatCard icon={FileText} label="Fund Filings" value={`${data.filingCount}`} tone="sky" />
          <StatCard icon={Calendar} label="Holdings As Of" value={data.holdingsAsOf || '—'} tone="stone" small />
        </div>
      </div>

      {assetBreakdown.length > 0 && (
        <section className="mb-8">
          <SectionHeader icon={PieChart} title="Asset Class Breakdown" />
          <div className="border-2 border-stone-800 bg-stone-900/30 p-4">
            <div className="space-y-2.5">
              {assetBreakdown.map((cat: AnyValue) => (
                <div key={cat.category}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-stone-200 font-bold">{cat.label}</span>
                      <span className="text-[10px] text-stone-500">
                        {cat.count} {cat.count === 1 ? 'holding' : 'holdings'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 tabular-nums">
                      <span className="text-stone-400">{formatLargeCurrency(cat.value)}</span>
                      <span className="text-amber-400 font-bold min-w-[3rem] text-right">
                        {cat.pctOfNav.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <div className="h-1.5 bg-stone-800 overflow-hidden">
                    <div
                      className="h-full bg-amber-500"
                      style={{ width: `${Math.min(100, cat.pctOfNav)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] text-stone-500 leading-relaxed">
              Percentages are based on the top {data.holdings.length} holdings by value.
              Smaller positions beyond the top 100 are not shown.
            </p>
          </div>
        </section>
      )}

      <section className="mb-8">
        <SectionHeader icon={Landmark} title="Top Holdings" subtitle={holdingsAsOfLabel} />
        {data.holdings.length === 0 ? (
          <div className="border-2 border-stone-800 bg-stone-900/30 p-6 text-center">
            <p className="text-sm text-stone-400 mb-1">Could not parse holdings from N-PORT filing</p>
            <p className="text-[11px] text-stone-600">
              The N-PORT XML may be in a non-standard format or the filing is too large to process.
            </p>
          </div>
        ) : (
          <HoldingsTable holdings={data.holdings} />
        )}
      </section>

      <section className="mb-8">
        <SectionHeader icon={FileText} title="Recent Fund Filings" />
        <FundFilingsTable filings={data.filings} cik={data.cik} />
      </section>

      <p className="mt-6 text-[11px] text-stone-500 leading-relaxed">
        Data source: SEC N-PORT monthly portfolio filings. N-PORT disclosures are filed with a
        60-day public delay per SEC rules. Holdings shown may not reflect current portfolio
        composition. AUM (Net Assets) = Total Assets – Total Liabilities as reported in N-PORT.
      </p>
    </>
  );
}

// ============================================================================
// HoldingsTable
// ============================================================================

function HoldingsTable({ holdings }: { holdings: AnyValue[] }) {
  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-stone-900 border-b-2 border-stone-800">
          <tr>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400 w-8">#</th>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Holding</th>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Asset Type</th>
            <th className="text-right px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Balance</th>
            <th className="text-right px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Value (USD)</th>
            <th className="text-right px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">% of NAV</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h: AnyValue, i: number) => (
            <tr key={`${h.cusip || h.name}-${i}`} className="border-b border-stone-800/60 hover:bg-amber-500/5">
              <td className="px-4 py-2.5 text-stone-500 tabular-nums">{i + 1}</td>
              <td className="px-4 py-2.5">
                <div className="text-stone-100 font-bold text-xs truncate max-w-md">{h.name}</div>
                {h.cusip && (
                  <div className="text-[10px] text-stone-500 font-mono">
                    CUSIP {h.cusip}
                    {h.tickerSymbol && <> · {h.tickerSymbol}</>}
                  </div>
                )}
              </td>
              <td className="px-4 py-2.5">
                <span className="text-[10px] text-stone-400 uppercase tracking-widest">
                  {ASSET_CAT_LABELS[h.assetCat] || h.assetCat || '—'}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-stone-300">
                {h.balance != null ? formatBalance(h.balance, h.units) : '—'}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums font-bold text-stone-100">
                {formatLargeCurrency(h.value)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-amber-400 font-bold">
                {h.pctOfNav != null ? `${h.pctOfNav.toFixed(2)}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// FundFilingsTable
// ============================================================================

function FundFilingsTable({ filings, cik }: { filings: AnyValue[]; cik: string }) {
  if (!filings?.length) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6 text-center">
        <p className="text-sm text-stone-500">No recent fund filings</p>
      </div>
    );
  }

  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-stone-900 border-b-2 border-stone-800">
          <tr>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Form</th>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Filed</th>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Period</th>
            <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Accession</th>
            <th className="text-center px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Link</th>
          </tr>
        </thead>
        <tbody>
          {filings.map((f: AnyValue) => {
            const cikStripped = String(cik).replace(/^0+/, '');
            const accnNoHyphens = f.accession.replace(/-/g, '');
            const docUrl = f.primaryDoc
              ? `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accnNoHyphens}/${f.primaryDoc}`
              : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikStripped}&type=&dateb=&owner=include&count=40`;
            return (
              <tr key={f.accession} className="border-b border-stone-800/60 hover:bg-amber-500/5">
                <td className="px-4 py-2.5">
                  <span className="inline-block px-2 py-0.5 bg-stone-800 text-stone-300 text-[10px] font-black uppercase tracking-wider border border-stone-700">
                    {f.form}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-stone-300 tabular-nums text-xs">{f.filingDate}</td>
                <td className="px-4 py-2.5 text-stone-400 tabular-nums text-xs">{f.reportDate || '—'}</td>
                <td className="px-4 py-2.5 text-stone-500 font-mono text-[10px]">{f.accession}</td>
                <td className="px-4 py-2.5 text-center">
                  <a href={docUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// Small subcomponents
// ============================================================================

interface SectionHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
}

function SectionHeader({ icon: Icon, title, subtitle }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-2 mb-4 pb-2 border-b-2 border-stone-800">
      <Icon className="w-5 h-5 text-amber-400" />
      <h3 className="text-sm uppercase tracking-[0.25em] font-black text-stone-200">{title}</h3>
      {subtitle && (
        <span className="text-[10px] text-stone-500 ml-2 lowercase tracking-widest">{subtitle}</span>
      )}
    </div>
  );
}

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: 'amber' | 'emerald' | 'sky' | 'stone';
  small?: boolean;
}

function StatCard({ icon: Icon, label, value, tone = 'stone', small = false }: StatCardProps) {
  const toneClasses = {
    amber: 'text-amber-400',
    emerald: 'text-emerald-400',
    sky: 'text-sky-400',
    stone: 'text-stone-200',
  };
  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className={`w-3.5 h-3.5 ${toneClasses[tone]}`} />
        <span className="text-[9px] uppercase tracking-widest text-stone-500 font-bold">{label}</span>
      </div>
      <div className={`${small ? 'text-xs' : 'text-sm'} font-black truncate ${toneClasses[tone]}`} title={value}>
        {value}
      </div>
    </div>
  );
}

function formatLargeCurrency(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return '—';
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${val.toFixed(0)}`;
}

function formatBalance(val: number | null, units: string | undefined): string {
  if (val == null || !Number.isFinite(val)) return '—';
  const abs = Math.abs(val);
  const unitLabel = units === 'PA' ? '' : units === 'NS' ? '' : ` ${units || ''}`;
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(2)}B${unitLabel}`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M${unitLabel}`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K${unitLabel}`;
  return `${val.toLocaleString()}${unitLabel}`;
}
