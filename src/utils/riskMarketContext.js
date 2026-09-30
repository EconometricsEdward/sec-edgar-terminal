import { fundingSeries, swapView } from './marketPlumbing/model.js';
import { ASSETS, SWAP_REPORTS, SWAPS_NOTES } from './marketPlumbing/catalog.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Bounded, public projections of the SAME prepared Market datasets. Values
 * retain their provider units: rates in percent, fails/swaps in USD millions.
 * No issuer-specific market cache, upstream fetch, or persisted copy. */
export function projectRiskMarketContext(funding, derivatives) {
  let fundingView = null;
  if (funding?.kind === 'funding' && Array.isArray(funding.rates) && Array.isArray(funding.fails)) {
    const view = fundingSeries(funding, '3m');
    const rates = view.rates.slice(-67);
    const last = rates.at(-1);
    // Cross-series spreads require a common date. Missing rates stay null.
    fundingView = { generatedAt: funding.generatedAt, availability: funding.availability,
      notice: funding.notice, sources: funding.sources, rates,
      fails: view.fails.slice(-14), latestDate: last?.date || null,
      latest: { sofr: last?.SOFR ?? null, tgcr: last?.TGCR ?? null, bgcr: last?.BGCR ?? null,
        spreadBps: finite(last?.SOFR) && finite(last?.TGCR) ? Math.round((last.SOFR - last.TGCR) * 10000) / 100 : null,
        dispersionBps: finite(last?.p99) && finite(last?.p1) ? Math.round((last.p99 - last.p1) * 10000) / 100 : null,
        volumeBillions: last?.volume ?? null } };
  }
  const swaps = derivatives?.kind === 'derivatives' && Array.isArray(derivatives.observations)
    ? Object.entries(ASSETS).map(([asset, label]) => {
      const view = swapView(derivatives, { asset, measure: 'outstanding', product: 'TOTAL' });
      return { asset, label, date: view.date || null, total: view.total,
        cleared: view.cleared, uncleared: view.uncleared,
        // Do not clamp inconsistent denominators into a plausible share.
        clearedShare: finite(view.total) && view.total > 0 && finite(view.cleared) && view.cleared >= 0 && view.cleared <= view.total ? view.cleared / view.total * 100 : null,
        trend: view.trend.slice(-16), sourceUrl: SWAP_REPORTS.find(r => r.asset === asset && r.measure === 'outstanding')?.url,
        notesUrl: SWAPS_NOTES };
    }) : [];
  return { version: 'risk-market-context-v1', funding: fundingView,
    derivatives: derivatives ? { generatedAt: derivatives.generatedAt, availability: derivatives.availability, swaps } : null };
}

/** One in-memory entry shared by all companies, with single-flight and a
 * short failure cooldown. An explicit reader keeps budget behavior testable. */
export function createRiskContextRead({ read, now = Date.now, derivativesEnabled = true } = {}) {
  let cached = null, pending = null, retryAt = 0;
  return async () => {
    if (cached && now() < cached.until) return cached.value;
    if (pending) return pending;
    if (now() < retryAt) throw new Error('Market context is temporarily unavailable.');
    pending = (async () => {
      const [funding, derivatives] = await Promise.allSettled([read('funding'), derivativesEnabled ? read('derivatives') : Promise.resolve(null)]);
      const value = projectRiskMarketContext(funding.status === 'fulfilled' ? funding.value : null,
        derivatives.status === 'fulfilled' ? derivatives.value : null);
      if (!value.funding && !value.derivatives) throw new Error('Market context is temporarily unavailable.');
      cached = { value, until: now() + (value.funding && (!derivativesEnabled || value.derivatives) ? 60000 : 10000) };
      return value;
    })().catch(error => { retryAt = now() + 10000; throw error; }).finally(() => { pending = null; });
    return pending;
  };
}
