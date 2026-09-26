import { bankScopeStore } from './scopeStore.js';
import { parseCallXbrl } from './parser.js';
import { buildExposureReport } from './exposureModel.js';
import { EXPOSURE_VERSION } from './exposureDefinitions.js';

/** Hash-pinned, read-only enrichment of retained Call Reports; never contacts FFIEC. */
export function createExposureService({ store = bankScopeStore, now = Date.now } = {}) {
  const cache = new Map();
  async function report(r) {
    const key = `${EXPOSURE_VERSION}:${r.id_rssd}:${r.report_date}:${r.form_type}:${r.source_sha256}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.promise;
    if (cache.size >= 48) cache.delete(cache.keys().next().value);
    const entry = { until: now() + 300000, promise: null };
    entry.promise = (async () => {
      const source = await store('source', { rssd: r.id_rssd, period: r.report_date, hash: r.source_sha256 });
      if (!source?.validation?.passed || Number(source.rssd) !== Number(r.id_rssd) || source.reportDate !== r.report_date || source.sha256 !== r.source_sha256) throw new Error('Source unavailable');
      const parsed = parseCallXbrl(source.rawXbrl, { rssd: Number(r.id_rssd), reportDate: r.report_date });
      if (parsed.sha256 !== r.source_sha256) throw new Error('Source hash mismatch');
      return buildExposureReport(parsed, { form: r.form_type, retrievedAt: source.retrievedAt, submission: source.submission });
    })().catch(e => { if (cache.get(key) === entry) cache.delete(key); throw e; });
    cache.set(key, entry);
    return entry.promise;
  }
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
