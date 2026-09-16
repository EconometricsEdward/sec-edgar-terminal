import { loadThirteenF, normalize13FRequest } from './thirteenFServer.js';
import { project13FHistoryQuarter } from './thirteenFHistory.js';

export function normalize13FHistoryRequest(cikInput, periodInput, keysInput) {
  const request = normalize13FRequest(cikInput, periodInput);
  const invalid = () => { throw Object.assign(new Error('Choose one reporting quarter and up to 32 valid security keys.'), { status: 400, code: 'INVALID_HISTORY_REQUEST' }); };
  if (!request.period || typeof keysInput !== 'string' || keysInput.length > 1800) invalid();
  let keys;
  try { keys = JSON.parse(keysInput); } catch { invalid(); }
  if (!Array.isArray(keys) || keys.length > 32 || keys.some(key => typeof key !== 'string' || !/^[A-Z0-9*@#]{9}\|(SECURITY|PUT|CALL)\|(SH|PRN)$/.test(key)) || new Set(keys).size !== keys.length) invalid();
  return { ...request, keys };
}

export function create13FHistoryLoader({ loadReport = loadThirteenF } = {}) {
  return async function loadHistoryQuarter(cik, { period, keys, signal } = {}) {
    const request = normalize13FHistoryRequest(cik, period, JSON.stringify(keys));
    const data = await loadReport(request.cik, { period: request.period, signal });
    if (!data || !['ready', 'unavailable'].includes(data.status) || data.manager?.cik !== request.cik || data.selectedPeriod !== request.period || data.status === 'ready' && (data.portfolio?.cik !== request.cik || data.portfolio?.period !== request.period)) {
      throw Object.assign(new Error('The historical report did not match the selected manager and quarter.'), { status: 502 });
    }
    return { status: data.status, manager: data.manager, selectedPeriod: data.selectedPeriod,
      projection: data.status === 'ready' ? {
        ...project13FHistoryQuarter(data.portfolio, request.keys),
        observedAt: data.observedAt,
        checkedAt: data.cache?.checkedAt || data.observedAt,
        stale: data.cache?.stale === true,
      } : null,
      coverage: data.coverage, observedAt: data.observedAt, cache: data.cache, reason: data.reason || null };
  };
}

export const load13FHistoryQuarter = create13FHistoryLoader();
