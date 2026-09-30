// The ISR page already supplies a validated public snapshot. Avoid downloading
// it again during hydration, while retaining recovery for stale/static fallbacks.
export const MARKET_PAGE_RECHECK_MS = 15 * 60 * 1000;
export function shouldRefreshMarketPage(snapshot, checkedAt, now = Date.now()) {
  const checked = Date.parse(checkedAt);
  return snapshot?.availability !== 'ready' || !Number.isFinite(checked)
    || checked > now || now - checked >= MARKET_PAGE_RECHECK_MS;
}
