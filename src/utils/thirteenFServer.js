import { loadFilingsCompany, loadFilingsArchive } from './filingsResearchServer.js';
import { mergeFilings, validFilingDate, validFilingDocument } from './filingsResearch.js';
import { secFetch } from './secClient.js';
import { parse13FCover, parse13FInformationTable, reconcile13FTable, assemble13FPeriod, summarize13FPortfolio } from './thirteenF.js';
import { create13FCache, THIRTEEN_F_FRESH_MS, THIRTEEN_F_STALE_MS } from './thirteenFCache.js';

const FORM = /^13F-(HR|NT)(?:\/A)?$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const MAX_ARCHIVES = 8;
const MAX_PERIODS = 40;
const MAX_PERIOD_FILINGS = 16;
const MAX_XML_BYTES = 12 * 1024 * 1024;
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;
const encoder = new TextEncoder();
function failure(message, status = 502, code = 'SEC_13F_UNAVAILABLE') {
  return Object.assign(new Error(message), { status, code });
}
export function normalize13FRequest(cikInput, periodInput = '') {
  const raw = String(cikInput ?? '').trim();
  if (!/^\d{1,10}$/.test(raw) || Number(raw) <= 0) throw failure('Enter a positive SEC CIK of up to 10 digits.', 400, 'INVALID_CIK');
  const period = String(periodInput ?? '').trim();
  if (period && (!validFilingDate(period) || !/-(03-31|06-30|09-30|12-31)$/.test(period))) throw failure('Select a valid 13F calendar quarter end.', 400, 'INVALID_PERIOD');
  return { cik: raw.padStart(10, '0'), period };
}
function periodRows(filings) {
  const periods = new Map();
  for (const filing of filings) {
    if (!FORM.test(filing.form) || !validFilingDate(filing.reportDate)) continue;
    const row = periods.get(filing.reportDate) || { period: filing.reportDate, filingCount: 0, latestFiled: '', forms: [] };
    row.filingCount++;
    row.latestFiled = row.latestFiled > filing.filingDate ? row.latestFiled : filing.filingDate;
    if (!row.forms.includes(filing.form)) row.forms.push(filing.form);
    periods.set(row.period, row);
  }
  return [...periods.values()].sort((a, b) => b.period.localeCompare(a.period));
}
function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Request aborted.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function limitedText(response, maxBytes, budget, signal) {
  if (!response.ok) throw failure(`SEC 13F documents are temporarily unavailable (HTTP ${response.status}). Retry this request.`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) throw failure('This SEC document exceeds the supported size. Open the original SEC filing.', 422, 'DOCUMENT_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) throw failure('SEC returned an empty document response. Retry this request.');
  const decoder = new TextDecoder();
  let result = '', count = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      budget.bytes += value.byteLength;
      if (count > maxBytes || budget.bytes > MAX_REQUEST_BYTES) throw failure('This SEC report exceeds the supported size. Open the original SEC filing.', 422, 'DOCUMENT_TOO_LARGE');
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
/** Inject dependencies for deterministic tests; production always uses the shared SEC transport. */
export function createThirteenFLoader({
  companyLoader = loadFilingsCompany, archiveLoader = loadFilingsArchive, fetchSec = secFetch,
  now = Date.now, maxCacheBytes = MAX_CACHE_BYTES, maxPending = 6, deadlineMs = 50000,
  sharedCache = create13FCache({ now }),
} = {}) {
  const cache = new Map(), pending = new Map();
  let cacheBytes = 0;
  function put(key, data, ttl) {
    const existing = cache.get(key);
    if (existing && Date.parse(existing.data.cache?.checkedAt || existing.data.observedAt) > Date.parse(data.cache?.checkedAt || data.observedAt)) return;
    if (existing?.invalidatedAt && Date.parse(existing.invalidatedAt) > Date.parse(data.cache?.checkedAt || data.observedAt)) return;
    const bytes = encoder.encode(JSON.stringify(data)).length;
    if (bytes > maxCacheBytes) return;
    if (cache.has(key)) { cacheBytes -= cache.get(key).bytes; cache.delete(key); }
    while (cache.size && (cacheBytes + bytes > maxCacheBytes || cache.size >= 24)) {
      const first = cache.keys().next().value;
      cacheBytes -= cache.get(first).bytes;
      cache.delete(first);
    }
    cache.set(key, { data, bytes, expires: now() + ttl });
    cacheBytes += bytes;
  }
  async function fetchDocument(url, signal, budget, maxBytes = MAX_XML_BYTES) {
    signal.throwIfAborted();
    const response = await fetchSec(url, { signal, timeoutMs: 15000, retries: 0, maxBytes, cache: 'no-store', headers: { Accept: 'application/json, application/xml, text/xml, text/plain;q=0.9' } });
    return limitedText(response, maxBytes, budget, signal);
  }
  async function loadReport(cik, filing, signal, budget, { coverOnly = false } = {}) {
    if (!ACCESSION.test(filing.accession) || !FORM.test(filing.form)) throw failure('The selected SEC filing metadata is invalid. Retry this request.');
    // SEC accession documents are immutable; amendments have new accessions.
    // A short-lived report head is rebuilt against current submissions metadata.
    const prepared = !coverOnly ? await sharedCache.readFiling(cik, filing, signal) : null;
    if (prepared) return prepared;
    const rootPath = `/Archives/edgar/data/${Number(cik)}/${filing.accession.replaceAll('-', '')}`;
    const root = `https://www.sec.gov${rootPath}`;
    let index;
    try { index = JSON.parse(await fetchDocument(`${root}/index.json`, signal, budget, 1024 * 1024)); }
    catch (error) { if (error.code || signal.aborted) throw error; throw failure('SEC returned an invalid filing document index. Retry this request.'); }
    if (index?.directory?.name !== rootPath || !Array.isArray(index.directory.item) || index.directory.item.length > 2000) throw failure('SEC document index did not match the requested filing. Retry this request.');
    const names = new Set();
    for (const item of index.directory.item) {
      if (typeof item?.name !== 'string' || !/^[\w][\w.-]{0,239}$/.test(item.name) || item.name.includes('..')) throw failure('SEC returned an invalid document name. Retry this request.');
      names.add(item.name);
    }
    const xmlNames = [...names].filter(name => /\.xml$/i.test(name));
    if (!xmlNames.length || xmlNames.length > 16) throw failure('The structured 13F documents could not be identified. Open the original SEC filing.', 422, 'UNSUPPORTED_13F_DOCUMENT');
    const primaryName = validFilingDocument(filing.primaryDoc) ? filing.primaryDoc.split('/').pop() : '';
    if (!primaryName || !names.has(primaryName) || !/\.xml$/i.test(primaryName)) throw failure('The SEC 13F cover document could not be verified in the filing index. Open the original SEC filing.', 422, 'UNSUPPORTED_13F_DOCUMENT');
    const primaryUrl = `${root}/${primaryName}`;
    const coverXml = await fetchDocument(primaryUrl, signal, budget);
    const cover = parse13FCover(coverXml, { cik, filingDate: filing.filingDate, form: filing.form, period: filing.reportDate || undefined });
    const tableUrls = [], rows = [], issues = [];
    let complete = true;
    if (!coverOnly && !/^13F-NT/.test(filing.form)) {
      // A table is identified by its XML root, never by a guessed attachment name.
      for (const name of xmlNames.filter(name => name !== primaryName)) {
        const url = `${root}/${name}`;
        const xml = await fetchDocument(url, signal, budget);
        const documentStart = xml.replace(/^\uFEFF/, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trimStart();
        if (!/^<(?:[\w.-]+:)?informationTable(?:\s|>)/i.test(documentStart)) continue;
        const table = parse13FInformationTable(xml, cover, { validateTotals: false });
        tableUrls.push(url);
        rows.push(...table.holdings);
        issues.push(...table.issues);
        complete = complete && table.complete;
      }
      if (!tableUrls.length) throw failure('The SEC 13F information table could not be located. Open the filing index or retry.', 422, 'MISSING_INFORMATION_TABLE');
      const reconciled = reconcile13FTable(rows, cover);
      issues.push(...reconciled.issues);
      complete = complete && reconciled.complete;
      if (rows.length > 20000) throw failure('This 13F report exceeds the supported position limit. Open the original SEC information table.', 422, 'REPORT_TOO_LARGE');
    }
    const report = { cover, holdings: rows, complete, issues: [...new Set(issues)], filing: {
      accession: filing.accession, filingDate: filing.filingDate, reportDate: cover.period, form: filing.form,
      primaryUrl, indexUrl: `${root}/${filing.accession}-index.html`, tableUrls,
    } };
    if (!coverOnly && complete) await sharedCache.writeFiling(cik, filing, report, signal);
    return report;
  }
  async function build(cik, requestedPeriod, signal) {
    const checkStartedAt = now();
    // Only cache-head misses reach this path. Refresh mutable submissions
    // metadata; immutable verified accession documents remain reusable.
    const company = await companyLoader(cik, { signal, refresh: true });
    if (company.cik !== cik || !company.name || company.kind === 'fund') throw failure('The SEC manager identity could not be verified. Retry this request.');
    let filings = mergeFilings(company.filings).map(filing => ({ ...filing }));
    const archives = company.archives || [], loaded = new Set();
    let omittedRecords = company.omittedRecords || 0;
    const omittedArchives = company.omittedArchives || 0;
    const budget = { bytes: 0 };
    
    async function addArchive(archive) {
      const history = await archiveLoader(cik, archive.name, { signal, refresh: true });
      if (history.cik !== cik || history.archive?.name !== archive.name) throw failure('The archived SEC filings did not match this manager. Retry this request.');
      filings = mergeFilings(filings, history.filings).map(filing => ({ ...filing }));
      omittedRecords += history.omittedRecords || 0;
      loaded.add(archive.name);
    }
    // Recent submissions usually contain years of 13F reports. Extend short histories
    // with at most two verified archives before choosing the latest report period.
    for (const archive of archives.slice(0, 2)) {
      if (periodRows(filings).length >= 8 && filings.some(f => FORM.test(f.form))) break;
      await addArchive(archive);
    }
    let selectedPeriod = requestedPeriod || periodRows(filings)[0]?.period || '';
    const needed = archives.filter(archive => !loaded.has(archive.name) && (!selectedPeriod || archive.filingTo >= selectedPeriod));
    for (const archive of needed) {
      if (loaded.size >= MAX_ARCHIVES) break;
      await addArchive(archive);
    }
    // Missing report dates are not silently discarded: inspect their verified cover.
    const undated = filings.filter(f => FORM.test(f.form) && !validFilingDate(f.reportDate) && (!selectedPeriod || f.filingDate >= selectedPeriod));
    if (undated.length > 8) throw failure('Several SEC 13F records are missing report periods. Review the SEC filing history before selecting a quarter.', 422, 'INCOMPLETE_PERIOD_METADATA');
    for (const filing of undated) {
      const report = await loadReport(cik, filing, signal, budget, { coverOnly: true });
      filing.reportDate = report.cover.period;
    }
    const allPeriods = periodRows(filings);
    selectedPeriod = requestedPeriod || allPeriods[0]?.period || '';
    // Cover dates may reveal a different latest quarter; recheck its archive boundary.
    for (const archive of archives) {
      if (loaded.size >= MAX_ARCHIVES) break;
      if (!loaded.has(archive.name) && (!selectedPeriod || archive.filingTo >= selectedPeriod)) await addArchive(archive);
    }
    const remaining = archives.filter(archive => !loaded.has(archive.name));
    const unresolved = filings.filter(f => FORM.test(f.form) && !validFilingDate(f.reportDate));
    const periodComplete = !omittedRecords && !omittedArchives && !remaining.some(archive => !selectedPeriod || archive.filingTo >= selectedPeriod)
      && !unresolved.some(f => !selectedPeriod || f.filingDate >= selectedPeriod);
    const historyComplete = !remaining.length && !omittedRecords && !omittedArchives && !unresolved.length;
    const finalPeriods = periodRows(filings);
    const reports = finalPeriods.slice(0, MAX_PERIODS);
    if (selectedPeriod && !reports.some(report => report.period === selectedPeriod)) {
      const selected = finalPeriods.find(report => report.period === selectedPeriod);
      if (selected) reports.push(selected);
    }
    const coverage = {
      historyComplete, selectedPeriodComplete: periodComplete, archivesLoaded: loaded.size, archivesRemaining: remaining.length,
      oldestFilingDate: filings.map(f => f.filingDate).sort()[0] || null, omittedRecords, omittedArchives, unresolvedPeriods: unresolved.length,
      periodsAvailable: finalPeriods.length, periodsShown: reports.length,
      note: !periodComplete ? 'Some relevant SEC history could not be included. Holdings and quarter comparisons may be incomplete.'
        : !historyComplete ? 'The selected quarter includes all relevant loaded and archived SEC filings. Earlier history remains available in the filing browser.'
          : 'All SEC submissions archives were checked. Public 13F reports can omit confidential positions and securities outside Form 13F coverage.',
    };
    const base = { manager: { cik, name: company.name, submissionsUrl: company.submissionsUrl || `https://data.sec.gov/submissions/CIK${cik}.json` },
      reports, selectedPeriod: selectedPeriod || null, coverage, observedAt: new Date(checkStartedAt).toISOString() };
    if (!selectedPeriod) return { ...base, status: 'unavailable', reason: historyComplete ? 'No Form 13F filings were found in this filer’s SEC submissions history.' : 'No Form 13F filings were found in the SEC history checked. Earlier archives remain available in the filing browser.', portfolio: null, summary: null };
    const selectedFilings = filings.filter(f => FORM.test(f.form) && f.reportDate === selectedPeriod);
    if (!selectedFilings.length) throw failure('This quarter is not present in the SEC 13F history checked. Select an available quarter or open the filing history.', 404, 'PERIOD_NOT_FOUND');
    if (selectedFilings.length > MAX_PERIOD_FILINGS) throw failure('This quarter contains more amendments than can be assembled in one request. Open the SEC filing history.', 422, 'TOO_MANY_AMENDMENTS');
    const documents = [];
    // Sequential document groups keep memory, request starts and upstream pressure bounded.
    for (const filing of selectedFilings) {
      const report = await loadReport(cik, filing, signal, budget);
      documents.push(periodComplete ? report : { ...report, historyComplete: false, complete: false, issues: [...report.issues, coverage.note] });
    }
    const portfolio = assemble13FPeriod(documents);
    if (!portfolio || portfolio.cik !== cik || portfolio.period !== selectedPeriod) throw failure('The assembled 13F portfolio did not match the requested manager and quarter. Retry this request.');
    if (portfolio.holdings.length > 20000 || portfolio.entryCount > 20000) throw failure('This assembled quarter exceeds the supported position limit. Open the original SEC information tables.', 422, 'REPORT_TOO_LARGE');
    const summary = summarize13FPortfolio(portfolio);
    // Rows already include reported-value weights in portfolio; avoid duplicating
    // the entire holdings table in every response and cache entry.
    delete summary.holdings;
    return { ...base, status: 'ready', portfolio, summary };
  }
  function cacheStatus(data, status, checkedAt, message = null) {
    return { ...data, cache: { status, stale: status === 'stale', checkedAt,
      freshUntil: new Date(Date.parse(checkedAt) + THIRTEEN_F_FRESH_MS).toISOString(),
      ...(status === 'stale' ? { refreshAttemptedAt: new Date(now()).toISOString(), message } : {}) } };
  }
  return async function loadThirteenF(cikInput, { period: periodInput = '', signal, refresh = false } = {}) {
    const { cik, period } = normalize13FRequest(cikInput, periodInput);
    signal?.throwIfAborted();
    const key = `${cik}:${period || 'latest'}`;
    const hit = cache.get(key), hitCheckedAt = hit?.data.cache?.checkedAt || hit?.data.observedAt;
    if (!refresh && hit?.expires > now()) { cache.delete(key); cache.set(key, hit); return cacheStatus(hit.data, 'memory', hitCheckedAt); }
    let fallback = hit?.data.status === 'ready' && hit.data.portfolio?.complete && now() - Date.parse(hitCheckedAt) <= THIRTEEN_F_STALE_MS ? hit.data : null;
    // Retain a complete expired snapshot for an explicitly labeled fallback.
    // A read never advances its original observation/check timestamp.
    if (hit && !fallback) { cache.delete(key); cacheBytes -= hit.bytes; }
    const pendingKey = `${key}:${refresh ? 'refresh' : 'read'}`;
    if (pending.has(pendingKey)) return abortable(pending.get(pendingKey), signal);
    if (pending.size >= maxPending) throw failure('Several 13F reports are already loading. Retry shortly.', 503, 'SEC_13F_BUSY');
    const deadline = AbortSignal.timeout(deadlineMs);
    const promise = (async () => {
      const saved = await sharedCache.readSnapshot(cik, period, deadline);
      if (saved) {
        if (!fallback || Date.parse(saved.checkedAt) > Date.parse(fallback.cache?.checkedAt || fallback.observedAt)) fallback = cacheStatus(saved.data, 'shared', saved.checkedAt);
        const age = now() - Date.parse(saved.checkedAt);
        if (!refresh && age < THIRTEEN_F_FRESH_MS && !saved.invalidatedAt
          && !(hit?.invalidatedAt && Date.parse(hit.invalidatedAt) >= Date.parse(saved.checkedAt))) {
          const data = cacheStatus(saved.data, 'shared', saved.checkedAt);
          put(key, data, THIRTEEN_F_FRESH_MS - age);
          return data;
        }
      }
      try {
        const built = await build(cik, period, deadline);
        // This records the metadata observation before document preparation,
        // so a slow older build cannot publish a misleading later check time.
        const data = cacheStatus(built, 'source', built.observedAt);
        // Do not retain incomplete source coverage as if a later retry could not improve it.
        if (data.coverage.selectedPeriodComplete && (!data.portfolio || data.portfolio.complete)) {
          const freshRemaining = Math.max(0, THIRTEEN_F_FRESH_MS - (now() - Date.parse(data.cache.checkedAt)));
          put(key, data, freshRemaining);
          if (data.status === 'ready') {
            const isLatest = data.selectedPeriod === data.reports.map(report => report.period).sort().at(-1);
            const keys = isLatest ? ['', data.selectedPeriod] : [period];
            if (isLatest) {
              put(`${cik}:${data.selectedPeriod}`, data, freshRemaining);
              put(`${cik}:latest`, data, freshRemaining);
            }
            await Promise.allSettled(keys.map(selected => sharedCache.writeSnapshot(data, selected, data.cache.checkedAt, deadline)));
          }
        } else {
          // Newly incomplete source evidence invalidates local freshness of a
          // prior complete observation, which is retained only for fallback.
          for (const alias of [key, `${cik}:latest`, `${cik}:${data.selectedPeriod}`]) {
            const prior = cache.get(alias);
            const affectedPeriod = alias === `${cik}:latest` ? prior?.data.selectedPeriod <= data.selectedPeriod : prior?.data.selectedPeriod === data.selectedPeriod;
            if (prior && affectedPeriod && Date.parse(prior.data.cache?.checkedAt || prior.data.observedAt) <= Date.parse(data.cache.checkedAt)) {
              prior.expires = 0; prior.invalidatedAt = data.cache.checkedAt;
            }
          }
          await Promise.allSettled(['', data.selectedPeriod].map(selected => sharedCache.invalidateSnapshot?.(cik, selected, data.selectedPeriod, data.cache.checkedAt, deadline)));
        }
        return data;
      } catch (error) {
        // A source outage can use a recent complete observation. Invalid input or
        // unsupported/incomplete evidence must remain its actual error/result.
        const sourceFailure = !error.status || error.status >= 500 || error.status === 429;
        const checkedAt = fallback?.cache?.checkedAt || fallback?.observedAt;
        if (sourceFailure && fallback && now() - Date.parse(checkedAt) <= THIRTEEN_F_STALE_MS) {
          return cacheStatus(fallback, 'stale', checkedAt, 'The SEC refresh could not be completed. Showing the last complete report; retry to check for newer filings or amendments.');
        }
        throw error;
      }
    })().finally(() => pending.delete(pendingKey));
    pending.set(pendingKey, promise);
    return abortable(promise, signal);
  };
}
export const loadThirteenF = createThirteenFLoader();
