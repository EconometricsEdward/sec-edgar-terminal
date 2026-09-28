import { bankScopeStore } from './scopeStore.js';
import { EXPOSURE_VERSION } from './exposureDefinitions.js';
import { createCachedExposureReport } from './exposureReportStore.js';

/** Hash-pinned, read-only enrichment of retained Call Reports; never contacts FFIEC. */
export function createExposureService({ store = bankScopeStore, now = Date.now, cache, env = process.env } = {}) {
  const report = createCachedExposureReport({ store, now, cache, env });
  return async (rssd, period) => {
    const state = await store('read', { rssds: [rssd] });
    const periods = [...new Set(state.periods || [])].filter(p => p <= period).sort().slice(-4);
    if (!periods.includes(period)) return { rssd, period, periods: [], reports: [], missing: [], unavailable: 'period_outside_available_history' };
    const selected = state.reports?.find(r => Number(r.id_rssd) === Number(rssd) && r.report_date === period && r.validation?.passed);
    if (!selected) return { rssd, period, periods, reports: [], missing: periods, unavailable: 'validated_report_unavailable' };
    // Fail current-quarter requests visibly; history failures remain gaps and can be retried.
    const [current, ...historical] = await Promise.allSettled([report(selected), ...periods.filter(p => p !== period).map(p => {
      const r = state.reports?.find(r => Number(r.id_rssd) === Number(rssd) && r.report_date === p && r.validation?.passed);
      return r ? report(r) : Promise.reject(new Error('Report unavailable'));
    })]);
    if (current.status === 'rejected') throw current.reason;
    const reports = [current.value, ...historical.filter(r => r.status === 'fulfilled').map(r => r.value)].sort((a,b) => a.period.localeCompare(b.period));
    return { rssd, period, periods, reports, missing: periods.filter(p => !reports.some(r => r.period === p)), mappingVersion: EXPOSURE_VERSION };
  };
}
export const getExposures = createExposureService();
