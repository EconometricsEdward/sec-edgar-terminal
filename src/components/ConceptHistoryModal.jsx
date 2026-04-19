import React, { useState, useEffect } from 'react';
import { X, Loader2, ExternalLink, AlertCircle, History, Info } from 'lucide-react';
import { secDataUrl } from '../utils/secApi.js';

/**
 * Modal showing the complete history of a single XBRL concept for a company.
 *
 * Useful for tracing:
 *   - How a value changed across amended filings (restatements)
 *   - Which fiscal periods used which tag variants
 *   - Discrepancies between original and subsequent reports
 *
 * Uses SEC's companyconcept endpoint, which returns every reported value
 * of a single concept across all the company's filings.
 *
 * Props:
 *   cik: 10-digit CIK string
 *   companyName: display name for header
 *   tag: XBRL concept name (e.g. "Revenues", "NetIncomeLoss")
 *   taxonomy: namespace (usually "us-gaap" or "ifrs-full")
 *   unit: unit label (usually "USD")
 *   onClose: callback when user dismisses
 */
export default function ConceptHistoryModal({ cik, companyName, tag, taxonomy = 'us-gaap', unit = 'USD', onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('annual'); // 'annual' | 'quarterly' | 'all'

  useEffect(() => {
    if (!cik || !tag) return;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const url = secDataUrl(`/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`);
        const res = await fetch(url);
        if (!res.ok) {
          if (res.status === 404) throw new Error(`No ${taxonomy} data for "${tag}"`);
          throw new Error(`SEC API error ${res.status}`);
        }
        const json = await res.json();
        setData(json);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [cik, taxonomy, tag]);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prepare list of observations from the response
  const observations = React.useMemo(() => {
    if (!data?.units?.[unit]) return [];
    const all = data.units[unit];
    // SEC sometimes includes the same fact multiple times across filings (restatements).
    // We show everything so the user can see restatements, but let them filter.
    return all
      .map((obs) => ({
        ...obs,
        periodType: obs.fp === 'FY' ? 'annual' : 'quarterly',
        // end date is required, start is optional (for instant facts it's absent)
      }))
      .sort((a, b) => {
        // Most recent period first, then most recent filing
        const endCmp = (b.end || '').localeCompare(a.end || '');
        if (endCmp !== 0) return endCmp;
        return (b.filed || '').localeCompare(a.filed || '');
      });
  }, [data, unit]);

  const filtered = observations.filter((o) => {
    if (filter === 'all') return true;
    if (filter === 'annual') return o.fp === 'FY';
    if (filter === 'quarterly') return o.fp && o.fp.startsWith('Q');
    return true;
  });

  // Detect restatements: same (end, fp) with different values from different filings
  const restatements = React.useMemo(() => {
    const byPeriod = new Map();
    observations.forEach((o) => {
      const key = `${o.end}-${o.fp}`;
      if (!byPeriod.has(key)) byPeriod.set(key, []);
      byPeriod.get(key).push(o);
    });
    const restated = [];
    byPeriod.forEach((obs, key) => {
      if (obs.length > 1) {
        const values = obs.map((o) => o.val);
        const allSame = values.every((v) => v === values[0]);
        if (!allSame) restated.push({ key, observations: obs });
      }
    });
    return restated;
  }, [observations]);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-stone-950 border-2 border-amber-500/50 w-full max-w-4xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b-2 border-stone-800 bg-stone-900/60">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <History className="w-4 h-4 text-amber-400" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-amber-400 font-bold">
                Concept History
              </span>
            </div>
            <h2 className="text-lg font-black text-stone-100 truncate">
              {data?.label || tag}
            </h2>
            <div className="flex items-center gap-2 text-[11px] text-stone-500 mt-0.5 flex-wrap">
              <span className="font-mono">{taxonomy}:{tag}</span>
              <span className="text-stone-700">·</span>
              <span>{companyName}</span>
              <span className="text-stone-700">·</span>
              <span>unit: {unit}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-stone-500 hover:text-stone-100 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              <span className="ml-3 text-sm text-stone-400">Loading concept history...</span>
            </div>
          )}

          {error && (
            <div className="m-4 p-4 border-2 border-rose-800/60 bg-rose-950/30 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm text-rose-200 font-bold">Could not load concept data</div>
                <div className="text-xs text-rose-300 mt-1">{error}</div>
                <div className="text-[10px] text-stone-500 mt-2">
                  Note: Not every XBRL concept exists for every company. Some tags were introduced
                  in specific reporting years, or may use alternate namespaces.
                </div>
              </div>
            </div>
          )}

          {data && !loading && (
            <>
              {/* Restatement alert */}
              {restatements.length > 0 && (
                <div className="m-4 p-3 border-2 border-amber-700/40 bg-amber-950/20 flex items-start gap-2">
                  <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-200 leading-relaxed">
                    <span className="font-bold">Restatements detected:</span>{' '}
                    {restatements.length} period{restatements.length > 1 ? 's have' : ' has'} different
                    values reported across multiple filings. Look for repeated rows with changing values.
                  </div>
                </div>
              )}

              {/* Summary + filter */}
              <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-2 border-b border-stone-800">
                <div className="text-xs text-stone-400">
                  <span className="font-bold text-stone-200">{observations.length}</span> total
                  observations across all filings
                </div>
                <div className="flex gap-1">
                  {['annual', 'quarterly', 'all'].map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`px-3 py-1 text-[10px] uppercase tracking-widest font-bold border-2 transition-colors ${
                        filter === f
                          ? 'bg-amber-500 text-stone-950 border-amber-500'
                          : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              {/* Observations table */}
              {filtered.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-stone-900/60 border-b-2 border-stone-800 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 text-[10px] uppercase tracking-widest text-stone-400">Period</th>
                        <th className="text-left px-3 py-2 text-[10px] uppercase tracking-widest text-stone-400">FY/FP</th>
                        <th className="text-right px-3 py-2 text-[10px] uppercase tracking-widest text-stone-400">Value</th>
                        <th className="text-left px-3 py-2 text-[10px] uppercase tracking-widest text-stone-400">Filed</th>
                        <th className="text-left px-3 py-2 text-[10px] uppercase tracking-widest text-stone-400">Form</th>
                        <th className="text-left px-3 py-2 text-[10px] uppercase tracking-widest text-stone-400">Accession</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((obs, i) => {
                        // Highlight rows that are restatements
                        const key = `${obs.end}-${obs.fp}`;
                        const isRestated = restatements.some((r) => r.key === key);
                        const archiveUrl = buildFilingUrl(cik, obs.accn);
                        return (
                          <tr
                            key={`${obs.accn}-${obs.end}-${i}`}
                            className={`border-b border-stone-800/60 hover:bg-amber-500/5 ${
                              isRestated ? 'bg-amber-500/5' : ''
                            }`}
                          >
                            <td className="px-3 py-2 tabular-nums text-stone-300">
                              {obs.start ? `${obs.start} → ${obs.end}` : obs.end}
                            </td>
                            <td className="px-3 py-2 text-stone-400">
                              FY{obs.fy} · {obs.fp}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-bold text-stone-100">
                              {formatValue(obs.val, unit)}
                            </td>
                            <td className="px-3 py-2 text-stone-400 tabular-nums">{obs.filed}</td>
                            <td className="px-3 py-2 text-stone-400">{obs.form}</td>
                            <td className="px-3 py-2">
                              <a
                                href={archiveUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300 font-mono text-[10px]"
                              >
                                {obs.accn}
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-8 text-center text-stone-500 text-sm">
                  No observations matching this filter.
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer note */}
        <div className="p-3 border-t-2 border-stone-800 bg-stone-900/40">
          <p className="text-[10px] text-stone-500 leading-relaxed">
            Data from SEC's companyconcept XBRL endpoint. Highlighted rows indicate restatements
            — same fiscal period reported with different values across multiple filings.
            Press <kbd className="px-1 py-0.5 bg-stone-800 text-stone-300 rounded text-[9px]">Esc</kbd> to close.
          </p>
        </div>
      </div>
    </div>
  );
}

function formatValue(val, unit) {
  if (val == null || !Number.isFinite(val)) return '—';
  if (unit === 'USD') {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }
  // Shares and non-USD units: use plain number formatting with abbreviations
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${val.toLocaleString()}`;
}

/**
 * Build the URL to the SEC EDGAR filing browser for a specific accession.
 * Accession is in format "0000320193-24-000123" — we need to strip dashes for the path.
 */
function buildFilingUrl(cik, accn) {
  const cikStripped = String(cik).replace(/^0+/, '');
  const accnStripped = accn.replace(/-/g, '');
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikStripped}&type=&dateb=&owner=include&count=40&action=getcompany`;
}
