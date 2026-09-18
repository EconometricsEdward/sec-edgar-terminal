import { getOperatingDirectory } from './tickerMap.js';
import { readPreparedFund, loadFund } from './fundResearchServer.js';
import { create13FCache } from './thirteenFCache.js';
import { loadThirteenF } from './thirteenFServer.js';
import { normalizeOwnershipRequest, ownershipCompanyTarget, projectCompanyOwnership, OWNERSHIP_FUNDS, OWNERSHIP_MANAGERS } from './companyOwnership.js';

const managerCache = create13FCache();
/** A small projection of existing validated bodies. Reading never prepares a
 * portfolio or downloads SEC holdings documents. It does not copy full reports. */
export function createCompanyOwnershipReader({ directory = getOperatingDirectory,
  readFund = readPreparedFund, readManager = managerCache.readSnapshot,
  prepareFund = loadFund, prepareManager = loadThirteenF,
  funds = OWNERSHIP_FUNDS, managers = OWNERSHIP_MANAGERS, now = Date.now,
} = {}) {
  const results = new Map(), pending = new Map(), preparing = new Map();
  const keyFor = (ticker, asOf) => `${ticker}:${asOf}`;
  async function mapBounded(items, worker, signal) {
    let cursor = 0;
    const output = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
      while (cursor < items.length && !signal?.aborted) {
        const index = cursor++;
        try { output[index] = await worker(items[index]); }
        catch { output[index] = { ...items[index], data: null, saved: null }; }
      }
    }));
    signal?.throwIfAborted();
    return output;
  }
  async function fundSnapshot(item, asOf, signal) {
    let data = await readFund(item.id, '', { signal, allowStale: true });
    if (asOf && data?.filingDate > asOf) {
      const selected = [...(data.reports || [])].filter(row => row.filingDate <= asOf && row.reportDate <= asOf)
        .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filingDate.localeCompare(a.filingDate))[0];
      if (selected) data = await readFund(item.id, selected.accession, { signal, allowStale: true }) || data;
    }
    return { ...item, data };
  }
  async function managerSnapshot(item, asOf, signal) {
    let saved = await readManager(item.id, '', signal);
    if (asOf && saved?.data?.portfolio?.filings?.some(row => row.filingDate > asOf)) {
      const selected = [...(saved.data.reports || [])].filter(row => row.latestFiled <= asOf && row.period <= asOf)
        .sort((a, b) => b.period.localeCompare(a.period))[0];
      if (selected) saved = await readManager(item.id, selected.period, signal) || saved;
    }
    return { ...item, saved };
  }
  async function build(ticker, asOf, signal) {
    const index = await directory();
    const company = index[ticker];
    if (!company) throw new RangeError('No SEC operating-company identity was found for this ticker.');
    const target = ownershipCompanyTarget(ticker, index, { asOf, now: now() });
    // Two readers total, rather than a per-fund SEC acquisition fanout. Dispose
    // of complete bodies after projecting the small company-specific response.
    const fundSnapshots = await mapBounded(funds, item => fundSnapshot(item, asOf, signal), signal);
    const identifiers = new Set(projectCompanyOwnership({ ticker, target, asOf, now: now(), funds: fundSnapshots }).identity.cusips);
    const managerSnapshots = await mapBounded(managers, async item => {
      const snapshot = await managerSnapshot(item, asOf, signal);
      // Complete bodies are validated by the existing cache before this narrow
      // projection. Retain their full denominator while releasing all unrelated
      // positions as each manager finishes, especially large index managers.
      const p = snapshot.saved?.data?.portfolio;
      if (p) snapshot.saved = { ...snapshot.saved, data: { ...snapshot.saved.data, portfolio: { ...p,
        holdings: p.holdings.filter(row => identifiers.has(row.cusip) && row.putCall === null && row.quantityType === 'SH') } } };
      return snapshot;
    }, signal);
    const result = projectCompanyOwnership({ ticker, target, asOf, now: now(),
      funds: fundSnapshots, managers: managerSnapshots });
    return result;
  }
  async function read(tickerInput, { asOf: asOfInput = '', signal, fresh = false } = {}) {
    const { ticker, asOf } = normalizeOwnershipRequest(tickerInput, asOfInput, now()), key = keyFor(ticker, asOf);
    signal?.throwIfAborted();
    const cached = results.get(key);
    if (!fresh && cached?.expires > now()) return cached.data;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 6) throw Object.assign(new Error('Ownership research is busy. Retry shortly.'), { status: 503 });
    // Shared work owns a short deadline. One browser cancellation must not
    // cancel the common cache read for another visitor.
    const task = build(ticker, asOf, AbortSignal.timeout(20000)).then(data => {
      results.delete(key);
      while (results.size >= 24) results.delete(results.keys().next().value);
      results.set(key, { data, expires: now() + 120000 });
      return data;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }
  async function prepare(tickerInput, { kind, id, asOf: asOfInput = '', signal } = {}) {
    const { ticker, asOf } = normalizeOwnershipRequest(tickerInput, asOfInput, now());
    const cohort = kind === 'fund' ? funds : kind === 'manager' ? managers : [];
    if (typeof id !== 'string' || !cohort.some(item => item.id === id)) throw new RangeError('Select one of the listed SEC reports to prepare.');
    const index = await directory();
    if (!index[ticker]) throw new RangeError('No SEC operating-company identity was found for this ticker.');
    const key = `${kind}:${id}:${asOf}`;
    if (!preparing.has(key)) {
      if (preparing.size >= 2) throw Object.assign(new Error('Two reports are already being prepared. Retry shortly.'), { status: 503 });
      const prepareSignal = AbortSignal.timeout(100000);
      const task = (async () => {
        if (kind === 'fund') {
          const current = await prepareFund(id, '', { signal: prepareSignal });
          if (current?.status !== 'ready') throw new Error('A complete N-PORT portfolio is not available for this fund. Open its research page for coverage.');
          if (asOf && current.filingDate > asOf) {
            const selected = [...(current.reports || [])].filter(row => row.filingDate <= asOf && row.reportDate <= asOf)
              .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filingDate.localeCompare(a.filingDate))[0];
            if (!selected) throw new Error('No eligible fund report was found before this filing cutoff.');
            await prepareFund(id, selected.accession, { signal: prepareSignal });
          }
        } else {
          const current = await prepareManager(id, { signal: prepareSignal });
          if (current?.status !== 'ready' || !current.portfolio?.complete) throw new Error('A complete 13F portfolio is not available for this manager. Open its research page for coverage.');
          if (asOf && current.portfolio.filings.some(row => row.filingDate > asOf)) {
            const selected = [...(current.reports || [])].filter(row => row.latestFiled <= asOf && row.period <= asOf)
              .sort((a, b) => b.period.localeCompare(a.period))[0];
            if (!selected) throw new Error('No eligible manager report was found before this filing cutoff.');
            await prepareManager(id, { period: selected.period, signal: prepareSignal });
          }
        }
        results.clear();
      })().finally(() => preparing.delete(key));
      preparing.set(key, task);
    }
    await preparing.get(key);
    signal?.throwIfAborted();
    // Do not reuse a projection that began before the newly prepared report.
    const previous = pending.get(keyFor(ticker, asOf));
    if (previous) await previous.catch(() => {});
    const result = await read(ticker, { asOf, signal, fresh: true });
    if (result.coverage.notPrepared.some(row => row.kind === kind && row.id === id))
      throw Object.assign(new Error('The prepared report is not available yet. Retry shortly, or open its research page for coverage.'), { status: 503 });
    return result;
  }
  return { read, prepare };
}
export const companyOwnership = createCompanyOwnershipReader();
