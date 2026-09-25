import { FUND_CATALOG } from './fundResearch.js';

export function fundSearchSuggestions(query, directory = {}, mode = 'explore', remote = []) {
  const q = String(query).trim().toUpperCase(), words = q.split(/\s+/).filter(Boolean);
  if (!q) return [];
  const entries = new Map(FUND_CATALOG.map(f => [f.ticker, { ...f, isFund: true }]));
  for (const [ticker, item] of Object.entries(directory || {})) entries.set(ticker, { ...item, ticker, name: entries.get(ticker)?.name || item.name });
  for (const item of remote) if (item.ticker) entries.set(item.ticker, { ...entries.get(item.ticker), ...item, isFund: true });
  const rank = item => item.ticker === q ? 0 : item.ticker.startsWith(q) ? 1 : item.name?.toUpperCase().startsWith(q) ? 2 : 3;
  return [...entries.values()].filter(item => (mode !== 'fund' || item.isFund)
    && words.every(word => `${item.ticker} ${item.name || ''} ${item.detail || ''}`.toUpperCase().includes(word)))
    .sort((a, b) => rank(a) - rank(b) || (mode === 'explore' ? Number(b.isFund) - Number(a.isFund) : 0) || a.ticker.localeCompare(b.ticker))
    .slice(0, 12).map(item => ({ ...item, kind: item.isFund ? 'fund' : 'company' }));
}

export const companyHoldingQuery = name => String(name || '').replace(/\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc)\b\.?/gi, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().replace(/\s+/g, ' ');
