// ============================================================================
// src/utils/fundCheck.js
//
// On-demand authoritative fund detection. Used by AnalysisPage and FilingsPage
// to verify the TickerSearchBar heuristic before routing. If a ticker's filer
// has N-PORT filings in recent history, it's a fund and should route to /fund.
//
// This is the same detection logic used server-side in api/fund.js, but runs
// client-side via CORS-enabled SEC data endpoints — no extra serverless
// functions needed.
//
// Design rationale: heuristic-based detection in TickerSearchBar is fast but
// can misclassify. This function provides a safety net at the moment of
// submission, at the cost of ~300-800ms added latency on the first ticker
// fetch (subsequent fetches of the same ticker are cached by the browser).
// ============================================================================

import { secDataUrl } from './secApi.js';

// Cache results within the session to avoid re-checking the same CIK on
// multiple submissions. Maps CIK → { isFund, checkedAt }.
const fundCheckCache = new Map();

/**
 * Check if a CIK belongs to a fund by looking for N-PORT filings.
 *
 * @param {string} cik - 10-digit zero-padded CIK
 * @param {number} timeoutMs - Give up after this many ms (default 3000)
 * @returns {Promise<boolean|null>} true if fund, false if not a fund,
 *          null if check couldn't complete (timeout, network error)
 */
export async function checkIsFund(cik, timeoutMs = 3000) {
  if (!cik) return null;

  // Session cache hit
  if (fundCheckCache.has(cik)) {
    return fundCheckCache.get(cik).isFund;
  }

  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(secDataUrl(`/submissions/CIK${cik}.json`), {
      signal: controller.signal,
    });
    clearTimeout(timeoutHandle);

    if (!res.ok) {
      // 404 or similar — treat as unknown, don't cache
      return null;
    }

    const data = await res.json();
    const recent = data?.filings?.recent;
    if (!recent?.form) {
      // No filings → definitely not a fund
      const result = false;
      fundCheckCache.set(cik, { isFund: result, checkedAt: Date.now() });
      return result;
    }

    // Count N-PORT filings. Require at least 2 to avoid false positives from
    // operating companies that accidentally filed a single fund-adjacent form.
    // Funds file N-PORT quarterly, so real funds have many.
    let nportCount = 0;
    for (const form of recent.form) {
      if (form === 'NPORT-P' || form === 'N-PORT' || form === 'NPORT-EX') {
        nportCount++;
        if (nportCount >= 2) break; // early exit once threshold met
      }
    }

    const isFund = nportCount >= 2;
    fundCheckCache.set(cik, { isFund, checkedAt: Date.now() });
    return isFund;
  } catch (err) {
    // AbortError (timeout) or network error — return null so caller falls
    // through to default behavior. Don't cache — we may succeed later.
    if (err.name !== 'AbortError') {
      console.warn(`Fund check failed for CIK ${cik}:`, err.message);
    }
    return null;
  }
}

/**
 * Clear the session cache. Mainly for testing.
 */
export function clearFundCheckCache() {
  fundCheckCache.clear();
}
