import React, { useState, useEffect } from 'react';
import {
  Building2, Loader2, AlertCircle, ExternalLink, Info, TrendingUp, Award,
} from 'lucide-react';

/**
 * HoldersSection — shows top 13F institutional holders of a given company.
 *
 * Props:
 *   ticker: ticker symbol (string)
 *   cik: target company's CIK (for display only)
 *   companyName: company name (for display)
 */
export default function HoldersSection({ ticker, cik, companyName }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!ticker) return;
    setLoading(true);
    setError(null);
    setData(null);

    (async () => {
      try {
        const res = await fetch(`/api/holders?ticker=${encodeURIComponent(ticker)}`);
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const json = await res.json();
        setData(json);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [ticker]);

  return (
    <section id="holders" className="mb-8 scroll-mt-4">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b-2 border-stone-800">
        <Building2 className="w-5 h-5 text-amber-400" />
        <h3 className="text-sm uppercase tracking-[0.25em] font-black text-stone-200">
          Institutional Holders
        </h3>
        {data?.meta?.totalFilings != null && (
          <span className="text-[10px] text-stone-500 ml-2">
            From {data.meta.totalFilings} recent 13F filings
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8 border-2 border-stone-800 bg-stone-900/30">
          <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />
          <span className="ml-3 text-sm text-stone-400">
            Searching 13F filings for {ticker} holders...
          </span>
        </div>
      )}

      {error && (
        <div className="border-2 border-rose-800/60 bg-rose-950/30 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm text-rose-200 font-bold">Could not load holder data</div>
            <div className="text-xs text-rose-300 mt-1">{error}</div>
          </div>
        </div>
      )}

      {data && !loading && !error && (
        <>
          {data.meta?.message && data.holders?.length === 0 && (
            <div className="border-2 border-stone-800 bg-stone-900/30 p-6 text-center">
              <Info className="w-6 h-6 text-stone-500 mx-auto mb-2" />
              <p className="text-sm text-stone-400 mb-1">{data.meta.message}</p>
              <p className="text-[11px] text-stone-600 mt-2">
                Currently supports common large-cap tickers. More coverage coming.
              </p>
            </div>
          )}

          {data.holders?.length > 0 && (
            <>
              {/* Summary stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <StatCard
                  icon={Award}
                  label="Top Holder"
                  value={shortenFilerName(data.holders[0]?.filerName)}
                  tone="amber"
                />
                <StatCard
                  icon={Building2}
                  label="Holders Shown"
                  value={`${data.holders.length}`}
                  tone="stone"
                />
                <StatCard
                  icon={TrendingUp}
                  label="Combined Value"
                  value={formatCurrency(data.holders.reduce((s, h) => s + (h.value || 0), 0))}
                  tone="emerald"
                />
                <StatCard
                  icon={Info}
                  label="CUSIP"
                  value={data.meta?.cusip || '—'}
                  tone="sky"
                  isMono
                />
              </div>

              {/* Holders table */}
              <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-stone-900 border-b-2 border-stone-800">
                    <tr>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400 w-8">#</th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Filer (Institution)</th>
                      <th className="text-right px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Shares</th>
                      <th className="text-right px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Value (USD)</th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">As Of</th>
                      <th className="text-center px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Filing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.holders.map((h, i) => {
                      const filingUrl = buildFilingUrl(h.filerCik, h.accession);
                      return (
                        <tr key={`${h.filerCik}-${h.accession}`} className="border-b border-stone-800/60 hover:bg-amber-500/5">
                          <td className="px-4 py-2.5 text-stone-500 tabular-nums">{i + 1}</td>
                          <td className="px-4 py-2.5">
                            <div className="text-stone-100 font-bold text-xs">
                              {shortenFilerName(h.filerName)}
                            </div>
                            <div className="text-[10px] text-stone-500 font-mono">CIK {h.filerCik}</div>
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-stone-300">
                            {formatShares(h.shares)}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums font-bold text-stone-100">
                            {formatCurrency(h.value)}
                          </td>
                          <td className="px-4 py-2.5 text-stone-400 tabular-nums text-xs">
                            {h.periodOfReport || h.fileDate}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <a
                              href={filingUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300"
                              title={`Accession ${h.accession}`}
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p className="mt-3 text-[10px] text-stone-500 leading-relaxed">
                Top 13F-HR institutional holders reporting in the past 6 months. Data parsed
                from SEC-filed information tables. Value reflects market value at report date.
                Click any filing icon to open the original 13F-HR on SEC.gov.
                This is a subset of all holders — 13F filers report quarterly with a 45-day delay.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

function StatCard({ icon: Icon, label, value, tone = 'stone', isMono = false }) {
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
        <span className="text-[9px] uppercase tracking-widest text-stone-500 font-bold">
          {label}
        </span>
      </div>
      <div className={`text-sm font-black truncate ${toneClasses[tone]} ${isMono ? 'font-mono' : ''}`} title={value}>
        {value}
      </div>
    </div>
  );
}

/**
 * Shorten long institutional names. "BERKSHIRE HATHAWAY INC" → "Berkshire Hathaway".
 * Handles ALL CAPS names common in SEC filings.
 */
function shortenFilerName(name) {
  if (!name) return 'Unknown';
  // Title-case if all uppercase
  if (name === name.toUpperCase() && name.length > 4) {
    name = name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // Remove common suffixes that add noise
  name = name.replace(/\s+(Inc|LLC|LP|LTD|Corp|Corporation|Company|Co|Trust|Group|Holdings|Mgmt|Management)\.?$/i, '');
  // Truncate if still very long
  if (name.length > 40) return name.slice(0, 37) + '...';
  return name;
}

function formatShares(shares) {
  if (shares == null || !Number.isFinite(shares)) return '—';
  if (shares >= 1e9) return `${(shares / 1e9).toFixed(2)}B`;
  if (shares >= 1e6) return `${(shares / 1e6).toFixed(2)}M`;
  if (shares >= 1e3) return `${(shares / 1e3).toFixed(1)}K`;
  return shares.toLocaleString();
}

function formatCurrency(val) {
  if (val == null || !Number.isFinite(val)) return '—';
  const abs = Math.abs(val);
  if (abs >= 1e12) return `$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(0)}K`;
  return `$${val.toFixed(0)}`;
}

function buildFilingUrl(cik, accession) {
  const cikStripped = String(cik).replace(/^0+/, '');
  const accnStripped = accession.replace(/-/g, '');
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikStripped}&type=13F-HR&dateb=&owner=include&count=10`;
}
