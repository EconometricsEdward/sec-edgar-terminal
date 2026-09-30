import { loadFilingsCompany, loadFilingsArchive } from './filingsResearchServer.js';
import { fetchReaderDocument } from './filingsReader.js';
import { RISK_TIMELINE_LIMITS, RISK_TIMELINE_TOPICS, extractTimelineDisclosures, compareTimelineDisclosures } from './riskTimelineDisclosures.js';
import { RISK_TIMELINE_RESPONSE_VERSION, matchesRiskTimelineResponse } from './riskTimelineResponse.js';

const fail = (message, status = 400, code = 'INVALID_RISK_TIMELINE') => Object.assign(new Error(message), { status, code });
const annualForms = new Set(['10-K', '20-F', '40-F']);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const RISK_TIMELINE_LIMITATIONS = [
  'On-demand review of at most four original SEC primary reports. Amendments, exhibits, custom numeric facts, tables and event reports are outside this comparison.',
  'Reporting dates position the timeline; filing dates determine availability at the selected cutoff. Compared reports can skip reporting periods, and their dates and gap remain visible.',
  'Similar full passages are compared only within the same report form and identified section. Wording changes are approximate matches, not evidence that a risk was introduced, resolved, increased or reduced.',
  'Missing mentions, unrecognized sections and failed reads are incomplete evidence. Review the original reports; absence is not zero risk.',
  'Customer groups and anonymous labels do not identify the same counterparty across reports. Concentration benchmarks and reporting durations can differ or overlap.',
  'Covenant or collateral wording does not establish covenant breach, borrowing availability, or an asset encumbrance amount. No metric values are inferred from prose.',
  'Excerpts retain paragraph openings and can append text around a revision beyond the opening preview. Ellipses mark omitted text; highlighted wording is approximate. Open the source for full qualifications.',
];

export function parseRiskTimelineRequest(input, now = new Date()) {
  const params = new URL(input).searchParams;
  if ([...params.keys()].some(key => !['ticker', 'basis', 'asOf'].includes(key) || params.getAll(key).length !== 1))
    throw fail('Use one exact ticker, reporting basis and optional filing-date cutoff.');
  const ticker = (params.get('ticker') || '').trim().toUpperCase(), basis = params.get('basis') || 'ttm';
  const asOf = params.has('asOf') ? params.get('asOf') : null;
  if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker) || !['annual', 'ttm'].includes(basis))
    throw fail('Provide a valid company ticker and annual or ttm basis.');
  if (asOf !== null && (!validDate(asOf) || asOf < '1994-01-01' || asOf > new Date(now).toISOString().slice(0, 10)))
    throw fail('Use a valid filing-date cutoff between 1994 and today.');
  return { ticker, basis, asOf };
}

/** The issuer manifest is the only authority for accession/document bindings.
 * An accession prefix can belong to a filing agent rather than the issuer. */
export function verifiedRiskTimelineFilings(rows, cik, cutoff) {
  if (!/^\d{10}$/.test(cik || '') || Number(cik) <= 0) return [];
  const filings = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const filed = row.filingDate ?? row.filed, name = row.primaryDoc;
    if (!annualForms.has(row.form) && row.form !== '10-Q' || !/^\d{10}-\d{2}-\d{6}$/.test(row.accession || '')
      || !validDate(filed) || filed > cutoff || !validDate(row.reportDate) || row.reportDate > filed
      || typeof name !== 'string' || name.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(name)) continue;
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${row.accession.replaceAll('-', '')}/${name}`;
    if ((row.documentUrl ?? row.url) !== url) continue;
    if (!filings.has(row.accession)) filings.set(row.accession, { accession: row.accession, form: row.form, filed,
      reportDate: row.reportDate, primaryDoc: name, url });
  }
  return [...filings.values()].sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession));
}

export function selectRiskTimelineFilings(filings, basis = 'ttm') {
  // Prefer the earliest original filing when a manifest repeats a reporting
  // period. Amendments were already excluded, and no period is duplicated.
  const distinct = rows => {
    const periods = new Map();
    for (const row of [...rows].sort((a, b) => a.filed.localeCompare(b.filed) || a.accession.localeCompare(b.accession)))
      if (!periods.has(row.reportDate)) periods.set(row.reportDate, row);
    return [...periods.values()].sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  };
  const annual = distinct(filings.filter(filing => annualForms.has(filing.form)));
  const quarterly = distinct(filings.filter(filing => filing.form === '10-Q'));
  const selected = basis === 'annual' || !quarterly.length ? annual.slice(0, 4) : [...quarterly.slice(0, 2), ...annual.slice(0, 2)];
  return distinct(selected).sort((a, b) => a.reportDate.localeCompare(b.reportDate) || a.filed.localeCompare(b.filed)).slice(0, RISK_TIMELINE_LIMITS.filings);
}

const topicCoverage = (analysis, status = 'uncompared') => Object.fromEntries(RISK_TIMELINE_TOPICS.map(topic => {
  const part = analysis?.topics[topic.id];
  return [topic.id, { status: status === 'unavailable' ? status : part?.matchingParagraphs ? status : 'missing',
    matches: part?.matchingParagraphs || 0, sectionCoverage: analysis?.sections || [], limited: part?.limited || false, omittedMatches: part?.omittedMatches || 0 }];
}));
const publicFiling = filing => { const { primaryDoc: _primaryDoc, ...value } = filing; return value; };

export async function discoverRiskTimeline(selection, { now = new Date(), signal, loadCompany = loadFilingsCompany,
  loadArchive = loadFilingsArchive, loadDocument = fetchReaderDocument } = {}) {
  const checked = parseRiskTimelineRequest(`https://example.test/?ticker=${encodeURIComponent(selection.ticker || '')}&basis=${encodeURIComponent(selection.basis || 'ttm')}${selection.asOf == null ? '' : `&asOf=${encodeURIComponent(selection.asOf)}`}`, now);
  const checkedAt = new Date(now).toISOString(), cutoff = checked.asOf || checkedAt.slice(0, 10);
  signal?.throwIfAborted();
  const company = await loadCompany(checked.ticker, { signal });
  if (company.kind === 'fund') throw fail('This ticker identifies a fund. Open its Funds workspace.', 422, 'FUND_TICKER');
  const cik = String(company.cik || '').padStart(10, '0');
  if (company.ticker !== checked.ticker || !/^\d{10}$/.test(cik) || Number(cik) <= 0 || !Array.isArray(company.filings) || !Array.isArray(company.archives))
    throw fail('The SEC manifest did not verify the selected issuer.', 502, 'SEC_SOURCE_INVALID');
  let eligible = verifiedRiskTimelineFilings(company.filings, cik, cutoff);
  const archives = company.archives.filter(file => new RegExp(`^CIK${cik}-submissions-\\d+\\.json$`).test(file.name || '')
    && validDate(file.filingFrom) && validDate(file.filingTo) && file.filingFrom <= file.filingTo && file.filingFrom <= cutoff)
    .sort((a, b) => b.filingTo.localeCompare(a.filingTo));
  let historyFilesScanned = 0, historyLimited = Boolean(company.omittedRecords || company.omittedArchives);
  const historyIssues = [];
  for (const archive of archives) {
    const selected = selectRiskTimelineFilings(eligible, checked.basis);
    const enough = checked.basis === 'annual' || !eligible.some(row => row.form === '10-Q')
      ? selected.length === 4 : selected.filter(row => row.form === '10-Q').length === 2 && selected.filter(row => annualForms.has(row.form)).length === 2;
    if (enough && archive.filingTo < selected.reduce((oldest, row) => row.filed < oldest ? row.filed : oldest, '9999-12-31')) break;
    if (historyFilesScanned >= RISK_TIMELINE_LIMITS.historyFiles) { historyLimited = true; break; }
    signal?.throwIfAborted(); historyFilesScanned++;
    try {
      const older = await loadArchive(checked.ticker, archive.name, { signal });
      if (older.ticker !== checked.ticker || older.cik !== cik || !Array.isArray(older.filings))
        throw fail('The SEC archive did not verify the selected issuer.', 502, 'SEC_SOURCE_INVALID');
      eligible = verifiedRiskTimelineFilings([...eligible.map(row => ({ ...row, documentUrl: row.url })), ...older.filings], cik, cutoff);
      if (older.omittedRecords) historyLimited = true;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === 'SEC_SOURCE_INVALID') throw error;
      historyLimited = true; historyIssues.push(String(error.message || 'SEC archive unavailable.').slice(0, 300));
    }
  }
  const selected = selectRiskTimelineFilings(eligible, checked.basis);
  const result = { schemaVersion: RISK_TIMELINE_RESPONSE_VERSION, ...checked, cik,
    companyName: String(company.name || checked.ticker).slice(0, 300), checkedAt, status: 'no_filing', events: [], filings: [],
    coverage: { selected: selected.length, reviewed: 0, failed: 0, historyFilesScanned, historyLimited, historyIssues,
      documentBytesLimit: RISK_TIMELINE_LIMITS.documentBytes, excerptLimit: RISK_TIMELINE_LIMITS.excerpts,
      excerptCharacters: RISK_TIMELINE_LIMITS.excerptCharacters, responseBytesLimit: RISK_TIMELINE_LIMITS.responseBytes, eventsOmitted: 0, analysisLimited: false },
    limitations: RISK_TIMELINE_LIMITATIONS };
  if (!selected.length) { result.message = 'No eligible original periodic filing was located within the bounded manifest search.'; return result; }
  const analyses = new Map(), rows = new Array(selected.length);
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      signal?.throwIfAborted();
      const index = next++, filing = selected[index];
      try {
        const document = await loadDocument(cik, { ...filing, documentUrl: filing.url }, { signal });
        signal?.throwIfAborted();
        if (typeof document.text !== 'string' || document.text.length < 30 || Buffer.byteLength(document.text) > RISK_TIMELINE_LIMITS.documentBytes)
          throw fail('The filing text was unavailable or exceeded the bounded reader limit.', 422, 'SEC_DOCUMENT_UNAVAILABLE');
        const analysis = extractTimelineDisclosures(document.text, filing.form);
        analyses.set(filing.accession, analysis);
        rows[index] = { ...publicFiling(filing), status: 'reviewed', topics: topicCoverage(analysis) };
      } catch (error) {
        signal?.throwIfAborted();
        if (error.code === 'RISK_TIMELINE_BUSY') throw error;
        rows[index] = { ...publicFiling(filing), status: 'fetch-failed', topics: topicCoverage(null, 'unavailable'), error: String(error.message || 'The SEC primary report could not be read.').slice(0, 500) };
      }
    }
  };
  const completed = await Promise.allSettled(Array.from({ length: Math.min(2, selected.length) }, worker));
  const failed = completed.find(entry => entry.status === 'rejected');
  if (failed) throw failed.reason;
  for (let index = 0; index < rows.length; index++) {
    const current = rows[index];
    if (current.status !== 'reviewed') continue;
    // Do not silently jump over an unreadable same-form report to manufacture a
    // clean comparison. A reviewed pair's explicit date gap may still skip
    // reports outside the four selected source documents.
    const prior = rows.slice(0, index).reverse().find(row => row.form === current.form);
    if (!prior || prior.status !== 'reviewed' || prior.filed > current.filed) continue;
    const compared = compareTimelineDisclosures(analyses.get(current.accession), analyses.get(prior.accession), current, prior);
    current.topics = compared.coverage;
    for (const event of compared.events) {
      const used = result.events.reduce((count, row) => count + row.before.evidence.length + row.after.evidence.length, 0);
      const available = Math.floor((RISK_TIMELINE_LIMITS.excerpts - used) / 2);
      if (!available) { result.coverage.eventsOmitted++; continue; }
      event.before.evidence = event.before.evidence.slice(0, available);
      event.after.evidence = event.after.evidence.slice(0, available);
      result.events.push(event);
    }
  }
  result.filings = rows;
  result.coverage.reviewed = rows.filter(row => row.status === 'reviewed').length;
  result.coverage.failed = rows.length - result.coverage.reviewed;
  result.coverage.analysisLimited = rows.some(row => Object.values(row.topics).some(topic => topic.limited));
  result.status = result.coverage.failed || historyLimited || result.coverage.analysisLimited ? 'partial' : result.events.length ? 'ready' : 'no_changes';
  while (Buffer.byteLength(JSON.stringify(result)) > RISK_TIMELINE_LIMITS.responseBytes && result.events.length) {
    result.events.pop(); result.coverage.eventsOmitted++;
  }
  if (result.coverage.eventsOmitted) result.status = 'partial';
  if (Buffer.byteLength(JSON.stringify(result)) > RISK_TIMELINE_LIMITS.responseBytes)
    throw fail('The bounded filing comparison could not be prepared.', 503, 'RISK_TIMELINE_SIZE');
  return result;
}

/** Small process-local reuse only: no timeline cache namespace or persisted
 * text. Shared work is cancelled only after every subscriber has left. */
export function createRiskTimelineLoader({ now = () => Date.now(), discover = discoverRiskTimeline, ...dependencies } = {}) {
  const saved = new Map(), pending = new Map();
  let savedBytes = 0, activeDocuments = 0;
  const forget = key => { const entry = saved.get(key); if (entry) { savedBytes -= entry.bytes; saved.delete(key); } };
  const prune = () => { for (const [key, entry] of saved) if (entry.expires <= now()) forget(key); };
  const loadDocument = async (...args) => {
    if (activeDocuments >= 4) throw fail('Filing comparisons are busy. Please retry.', 503, 'RISK_TIMELINE_BUSY');
    activeDocuments++;
    try { return await (dependencies.loadDocument || fetchReaderDocument)(...args); }
    finally { activeDocuments--; }
  };
  return async (selection, { signal } = {}) => {
    const checked = parseRiskTimelineRequest(`https://example.test/?ticker=${encodeURIComponent(selection.ticker || '')}&basis=${encodeURIComponent(selection.basis || 'ttm')}${selection.asOf == null ? '' : `&asOf=${encodeURIComponent(selection.asOf)}`}`, new Date(now()));
    const key = `${checked.ticker}:${checked.basis}:${checked.asOf || 'latest'}`;
    signal?.throwIfAborted(); prune();
    const cached = saved.get(key);
    if (cached) {
      saved.delete(key); saved.set(key, cached);
      if (cached.error) throw fail(cached.error.message, cached.error.status, cached.error.code);
      return cached.value;
    }
    let shared = pending.get(key);
    if (!shared) {
      if (pending.size >= 12) throw fail('Filing comparisons are busy. Please retry.', 503, 'RISK_TIMELINE_BUSY');
      while (saved.size && saved.size + pending.size >= 12) forget(saved.keys().next().value);
      const controller = new AbortController();
      shared = { controller, subscribers: 0, settled: false, task: null };
      const entry = shared;
      const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(RISK_TIMELINE_LIMITS.requestMs)]);
      entry.task = (async () => {
        try {
          const value = await discover(checked, { ...dependencies, now: new Date(now()), signal: requestSignal, loadDocument });
          requestSignal.throwIfAborted();
          if (!matchesRiskTimelineResponse(value, checked.ticker, checked.basis, checked.asOf))
            throw fail('The SEC comparison response did not verify the selected sources.', 502, 'SEC_SOURCE_INVALID');
          const bytes = Buffer.byteLength(JSON.stringify(value));
          while (saved.size && (saved.size >= 12 || savedBytes + bytes > 1_048_576)) forget(saved.keys().next().value);
          saved.set(key, { value, bytes, expires: now() + (value.coverage.failed || value.coverage.historyIssues.length ? 20_000 : 300_000) }); savedBytes += bytes;
          return value;
        } catch (error) {
          if (!controller.signal.aborted) {
            const failure = { message: String(error.message || 'Filing comparison unavailable.').slice(0, 500), status: error.status || 503, code: error.code || 'RISK_TIMELINE_UNAVAILABLE' };
            const bytes = Buffer.byteLength(JSON.stringify(failure));
            while (saved.size && (saved.size >= 12 || savedBytes + bytes > 1_048_576)) forget(saved.keys().next().value);
            saved.set(key, { error: failure, bytes, expires: now() + 20_000 }); savedBytes += bytes;
          }
          throw error;
        } finally { entry.settled = true; if (pending.get(key) === entry) pending.delete(key); }
      })();
      pending.set(key, entry);
    }
    const entry = shared; entry.subscribers++;
    return new Promise((resolve, reject) => {
      let released = false;
      const finish = (callback, value) => {
        if (released) return; released = true;
        signal?.removeEventListener('abort', abort); entry.subscribers--;
        if (!entry.settled && !entry.subscribers) { if (pending.get(key) === entry) pending.delete(key); entry.controller.abort(); }
        callback(value);
      };
      const abort = () => finish(reject, signal.reason || new DOMException('Filing comparison cancelled.', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      entry.task.then(value => finish(resolve, value), error => finish(reject, error));
    });
  };
}

export const loadRiskTimeline = createRiskTimelineLoader();
