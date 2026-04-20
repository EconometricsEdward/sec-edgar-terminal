// ============================================================================
// tickerMapLoader — Loads and classifies all SEC tickers
//
// Data sources:
//   1. company_tickers.json       — ~10k operating companies and some funds
//   2. company_tickers_mf.json    — SEC's official mutual fund list
//   3. knownFunds.js (local)      — Curated ETF list for instant classification
//
// Output: A single map keyed by uppercase ticker with fund classification.
//   tickerMap['SPY'] = { cik: '...', name: '...', ticker: 'SPY', isFund: true }
// ============================================================================

import { secFilesUrl } from './secApi.js';
import { KNOWN_ETFS } from './knownFunds.js';

// Cache the loaded map so we don't re-fetch if multiple components need it
let cachedMap = null;
let loadPromise = null;

/**
 * Loads the complete classified ticker map. Safe to call multiple times —
 * subsequent calls return the cached result.
 *
 * @returns {Promise<object>} Map of TICKER → { cik, name, ticker, isFund }
 */
export async function loadClassifiedTickerMap() {
  if (cachedMap) return cachedMap;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const map = {};

    // --- Load both SEC files in parallel ---
    const [companyRes, mutualFundRes] = await Promise.all([
      fetch(secFilesUrl('company_tickers.json')).catch(() => null),
      fetch(secFilesUrl('company_tickers_mf.json')).catch(() => null),
    ]);

    // --- Parse company_tickers.json (operating companies + some funds) ---
    if (companyRes?.ok) {
      try {
        const data = await companyRes.json();
        Object.values(data).forEach((entry) => {
          if (!entry?.ticker) return;
          const ticker = String(entry.ticker).toUpperCase();
          map[ticker] = {
            cik: String(entry.cik_str).padStart(10, '0'),
            name: entry.title || ticker,
            ticker,
            isFund: KNOWN_ETFS.has(ticker),  // Mark known ETFs
          };
        });
      } catch (err) {
        console.warn('Failed to parse company_tickers.json', err);
      }
    }

    // --- Parse company_tickers_mf.json (mutual funds) ---
    // Format: { fields: [...], data: [[cik, seriesId, classId, symbol], ...] }
    if (mutualFundRes?.ok) {
      try {
        const data = await mutualFundRes.json();
        if (data?.data && Array.isArray(data.data)) {
          for (const row of data.data) {
            // Row format varies, but last field is typically the ticker/symbol
            // SEC's MF file format: [cik, seriesId, classId, symbol]
            const cik = row[0];
            const symbol = row[row.length - 1];
            if (!symbol) continue;

            const ticker = String(symbol).toUpperCase();
            if (!map[ticker]) {
              // Add mutual fund that wasn't in main file
              map[ticker] = {
                cik: String(cik).padStart(10, '0'),
                name: `Mutual Fund (${ticker})`,  // MF file doesn't have names, sadly
                ticker,
                isFund: true,
              };
            } else {
              // Mark existing entry as fund
              map[ticker].isFund = true;
            }
          }
        }
      } catch (err) {
        console.warn('Failed to parse company_tickers_mf.json', err);
      }
    }

    cachedMap = map;
    return map;
  })();

  return loadPromise;
}

/**
 * Clears the cache. Useful for testing or forcing a reload.
 */
export function clearTickerMapCache() {
  cachedMap = null;
  loadPromise = null;
}
