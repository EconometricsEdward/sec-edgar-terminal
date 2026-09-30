import { loadFilingsCompany, loadFilingsArchive } from './filingsResearchServer.js';
import { fetchReaderDocument, validateReaderDocument } from './filingsReader.js';
import { secResearchJson } from './secResearchData.js';
import { buildRiskFinancialTimeline, compareRiskTimelinePassages, extractRiskTimelinePassages,
  RISK_TIMELINE_LIMITS, RISK_TIMELINE_VERSION, RISK_TIMELINE_TOPICS, selectRiskTimelineFilings } from './riskTimeline.js';

const cache = new Map(), pending = new Map();
const MAX_CACHE_BYTES = 2_000_000;
let activeDocuments = 0;
/** No new persistent dataset. Text reuses the approved compressed reader cache. */
export async function loadRiskTimeline(ticker, { mode = 'annual', includeText = false, signal } = {}, dependencies = {}) {
  const key = `${ticker}:${mode}:${includeText}`;
  const local = cache.get(key);
  if (!Object.keys(dependencies).length && local?.until > Date.now()) return local.data;
  const loadCompany = dependencies.loadCompany || loadFilingsCompany;
  const loadArchive = dependencies.loadArchive || loadFilingsArchive;
  const loadFacts = dependencies.loadFacts || ((cik, requestSignal) => secResearchJson(`/api/xbrl/companyfacts/CIK${cik}.json`, requestSignal));
  const loadDocument = dependencies.loadDocument || fetchReaderDocument;
  const company = await loadCompany(ticker, { signal });
  if (company.kind === 'fund') throw Object.assign(new Error('Choose an SEC operating company.'), { status: 422 });
  if (company.ticker !== ticker || !/^\d{10}$/.test(company.cik || '') || Number(company.cik) <= 0)
    throw Object.assign(new Error('The SEC filing manifest did not verify this issuer.'), { status: 502 });
  let rows = company.filings, filings = selectRiskTimelineFilings(rows, mode), archiveErrors = 0, inspectedArchives = 0;
  for (const archive of company.archives.slice(0, RISK_TIMELINE_LIMITS.archives)) {
    if (filings.length >= RISK_TIMELINE_LIMITS.filings) break;
    signal?.throwIfAborted(); inspectedArchives++;
    try {
      const older = await loadArchive(ticker, archive.name, { signal });
      if (older.ticker !== ticker || older.cik !== company.cik) throw new Error('Archive issuer mismatch.');
      rows = rows.concat(older.filings);
    } catch { signal?.throwIfAborted(); archiveErrors++; }
    filings = selectRiskTimelineFilings(rows, mode);
  }
  filings = filings.map(f => ({ accession: f.accession, form: f.form, reportDate: f.reportDate,
    filingDate: f.filingDate, primaryDoc: f.primaryDoc, url: validateReaderDocument(company.cik, f), archive: f.archive || '' }));
  const notices = [];
  let financial = { events: [], observations: [], coverage: [] };
  let sourceFailure = archiveErrors > 0;
  if (filings.length > 0) {
    try {
      const companyFacts = await loadFacts(company.cik, signal);
      if (String(companyFacts.cik).replace(/^0+/, '') !== String(Number(company.cik)) || !companyFacts.facts)
        throw new Error('Company facts issuer mismatch.');
      financial = buildRiskFinancialTimeline(companyFacts.facts, company.sic, company.cik, filings);
    } catch {
      signal?.throwIfAborted(); sourceFailure = true;
      notices.push('Financial source inputs are temporarily unavailable. Retry to compare reported amounts.');
      financial.coverage = filings.slice(1).flatMap((filing, index) => ['cash', 'refinancing'].map(topic => ({
        topic, current: filing.accession, prior: filings[index].accession, status: 'unavailable', reason: 'Financial source inputs could not be read.' })));
    }
  }
  const documents = new Map(), textCoverage = [], disclosureEvents = [];
  if (includeText) {
    const queue = [...filings];
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length) {
        signal?.throwIfAborted();
        const filing = queue.shift();
        let reserved = false;
        try {
          if (activeDocuments >= 4) throw new Error('Filing readers are busy. Retry shortly.');
          activeDocuments++; reserved = true;
          const document = await loadDocument(company.cik, filing, { signal });
          signal?.throwIfAborted();
          if (typeof document.text !== 'string' || Buffer.byteLength(document.text) > 24_000_000) throw new Error('Filing text unavailable or oversized.');
          documents.set(filing.accession, extractRiskTimelinePassages(document.text, filing));
        } catch {
          signal?.throwIfAborted(); sourceFailure = true;
          textCoverage.push({ accession: filing.accession, status: 'unavailable', reason: 'Filing text could not be read. Open the SEC original or retry.' });
        } finally { if (reserved) activeDocuments--; }
      }
    }));
    for (let i = 1; i < filings.length; i++) {
      const prior = documents.get(filings[i - 1].accession), current = documents.get(filings[i].accession);
      if (!prior || !current) {
        textCoverage.push(...RISK_TIMELINE_TOPICS.map(topic => ({ topic: topic.id, current: filings[i].accession,
          prior: filings[i - 1].accession, status: 'unavailable', reason: 'One or both filing texts could not be read.' })));
        continue;
      }
      const result = compareRiskTimelinePassages(prior, current, filings[i - 1], filings[i]);
      disclosureEvents.push(...result.events); textCoverage.push(...result.coverage);
    }
  }
  if (filings.length < 2) notices.push('Fewer than two original reports were found in the inspected filing history.');
  if (archiveErrors) notices.push('Some archived filing history could not be read.');
  const data = { version: RISK_TIMELINE_VERSION, ticker, cik: company.cik, companyName: company.name, mode,
    status: sourceFailure ? 'partial' : filings.length < 2 ? 'limited' : 'ready', includeText,
    filings, events: [...financial.events, ...disclosureEvents].sort((a, b) => b.date.localeCompare(a.date)),
    observations: financial.observations, coverage: { financial: financial.coverage, text: textCoverage,
      documentsRead: documents.size, inspectedArchives,
      historyLimited: filings.length < RISK_TIMELINE_LIMITS.filings || archiveErrors > 0 }, notices, generatedAt: new Date().toISOString() };
  // Cap the response as well as the process cache. No hidden truncation of evidence.
  let responseBytes = Buffer.byteLength(JSON.stringify(data));
  while (responseBytes > 256_000 && data.events.some(event => event.kind === 'disclosure')) {
    const index = data.events.findLastIndex(event => event.kind === 'disclosure');
    data.events.splice(index, 1);
    data.coverage.eventsOmitted = (data.coverage.eventsOmitted || 0) + 1;
    responseBytes = Buffer.byteLength(JSON.stringify(data));
  }
  if (data.coverage.eventsOmitted) { data.status = 'partial'; notices.push('Some passage changes were omitted to keep the response bounded.'); }
  if (!Object.keys(dependencies).length && !sourceFailure && !data.coverage.eventsOmitted) {
    if (responseBytes < MAX_CACHE_BYTES) {
      cache.delete(key); cache.set(key, { data, size: responseBytes, until: Date.now() + 300_000 });
      let bytes = [...cache.values()].reduce((n, item) => n + item.size, 0);
      while (cache.size > 12 || bytes > MAX_CACHE_BYTES) { const first = cache.keys().next().value; bytes -= cache.get(first).size; cache.delete(first); }
    }
  }
  return data;
}
export async function readRiskTimeline(ticker, options) {
  const key = `${ticker}:${options.mode}:${options.includeText}`;
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= 4) throw Object.assign(new Error('Filing comparisons are busy. Please retry shortly.'), { status: 503 });
  const task = loadRiskTimeline(ticker, { ...options, signal: AbortSignal.timeout(48_000) }).finally(() => pending.delete(key));
  pending.set(key, task); return task;
}
