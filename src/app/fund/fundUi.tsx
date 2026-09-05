'use client';
import { useEffect, useState } from 'react';
import type { Fund } from './fundTypes';
export function money(n: number | null | undefined) { return n == null || !Number.isFinite(n) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(n); }
export function pct(n: number | null | undefined) { return n == null ? '—' : `${n.toFixed(2)}%`; }
export function number(n: number | null | undefined) { return n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }); }
export function ageDays(asOf: string) { return Math.max(0, Math.floor((Date.now() - Date.parse(asOf + 'T00:00:00Z')) / 86400000)); }
export function useFundShelf() {
  const [saved, setSaved] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  useEffect(() => { try { const value = JSON.parse(localStorage.getItem('edgar-funds-shelf-v1') || '[]'); if (Array.isArray(value)) setSaved(value.filter(v => typeof v === 'string' && /^[A-Z0-9.-]{1,15}$/.test(v)).slice(0, 30)); } catch { setStorageError('Saved funds are unavailable in this browser.'); } setReady(true); }, []);
  const toggle = (ticker: string) => { const next = saved.includes(ticker) ? saved.filter(t => t !== ticker) : [...saved, ticker].slice(-30); setSaved(next); try { localStorage.setItem('edgar-funds-shelf-v1', JSON.stringify(next)); setStorageError(''); } catch { setStorageError('Could not save to this browser. Your selection lasts for this visit.'); } };
  return { saved, ready, toggle, storageError };
}
export function researchBrief(fund: Fund, notes = '') {
  return `# ${fund.ticker} — ${fund.name}\n\nPortfolio as of ${fund.asOf}; filed ${fund.filingDate}.\nRegistrant: ${fund.registrant} (CIK ${fund.cik}).\nSeries: ${fund.seriesId || 'Not assigned'}; class: ${fund.classId || 'Not assigned'}.\nPortfolio net assets: ${money(fund.fundInfo.netAssets)}. Series-level totals may include multiple share classes.\nReported positions: ${fund.summary.count}; top 10 positive position weights: ${pct(fund.summary.top10Weight)} of net assets.\nLargest reported positive position: ${fund.summary.largest?.name || 'Unavailable'} (${pct(fund.summary.largest?.pctOfNav)}).\n\nSEC filing: ${fund.filingUrl}\nRaw N-PORT: ${fund.sourceUrl}\nAccession: ${fund.accession}\nRetrieved: ${fund.retrievedAt}\n\nHistorical reported holdings; not a live portfolio. Derivative fair values are not notional exposure.\n${notes ? `\n## Research notes\n${notes}\n` : ''}`;
}
