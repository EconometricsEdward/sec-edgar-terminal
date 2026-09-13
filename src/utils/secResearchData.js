import { getOperatingTicker } from './tickerMap.js';
import { buildFilingUrl } from './filingTextParser.js';
import { warmGet, warmSet } from './warmCache.js';
import { RESEARCH_FORMS } from './researchWorkspace.js';
import { secFetch } from './secClient.js';
import { readPreparedSecDocument, sampleSecShadow } from './secDocumentStore.js';

const MAX_RESEARCH_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_SOURCES = 8;
function researchIdentity(path) {
  const current = /^\/submissions\/CIK(\d{10})(-submissions-\d+)?\.json$/.exec(path);
  const facts = /^\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/.exec(path);
  const cik = current?.[1] || facts?.[1];
  if (!cik || Number(cik) === 0) throw new Error('Invalid SEC data path.');
  return { cik, facts: Boolean(facts), archive: Boolean(current?.[2]) };
}
function validateResearchSource(data, identity) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || (!identity.archive && String(data.cik || '').replace(/^0+/, '') !== identity.cik.replace(/^0+/, ''))
    || (identity.facts ? !data.facts || typeof data.facts !== 'object' || Array.isArray(data.facts)
      : !Array.isArray((identity.archive ? data : data.filings?.recent)?.accessionNumber)))
    throw new Error('SEC research source failed company identity or contents validation.');
  return data;
}

/** Requests share a bounded source fetch; canceling one reader does not cancel
 * other readers. This disposable cache covers every valid CIK and does not
 * enroll user searches into the separately maintained immutable archive.
 */
export function createSecResearchJson({
  readPrepared = readPreparedSecDocument, read = warmGet, write = warmSet,
  fetchSec = secFetch, sample = sampleSecShadow,
} = {}) {
  const pending = new Map();
  return async (path, signal) => {
    const identity = researchIdentity(path);
    signal?.throwIfAborted();
    let entry = pending.get(path);
    if (!entry) {
      if (pending.size >= MAX_PENDING_SOURCES) throw Object.assign(new Error('SEC research retrieval is busy. Retry shortly.'), { status: 503 });
      const controller = new AbortController();
      entry = { controller, readers: 0, settled: false, task: null };
      const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
      entry.task = (async () => {
        // Raw JSON callers cannot label last-good input. Never extend the five
        // minute cache freshness or restamp stale sources as new calculations.
        const prepared = await readPrepared(path, { allowStale: false });
        if (prepared) return validateResearchSource(prepared.payload, identity);
        let cached;
        try { cached = await read('research-sec-v1', path); } catch { /* A cache outage keeps the bounded SEC retrieval path available. */ }
        if (cached) {
          try { validateResearchSource(cached, identity); }
          catch { cached = null; }
          if (cached) { await sample(path, cached); return cached; }
        }
        requestSignal.throwIfAborted();
        const response = await fetchSec(`https://data.sec.gov${path}`, {
          headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com', Accept: 'application/json' },
          signal: requestSignal, timeoutMs: 15000, maxBytes: MAX_RESEARCH_SOURCE_BYTES,
        });
        if (!response.ok) throw new Error(`SEC data request returned HTTP ${response.status}.`);
        const data = validateResearchSource(await response.json(), identity);
        requestSignal.throwIfAborted();
        try { await write('research-sec-v1', path, data, 300); } catch { /* A valid source result survives optional cache persistence failure. */ }
        await sample(path, data);
        return data;
      })().finally(() => {
        entry.settled = true;
        if (pending.get(path) === entry) pending.delete(path);
      });
      pending.set(path, entry);
    }
    entry.readers++;
    try {
      return await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || new Error('SEC research reader aborted.'));
        signal?.addEventListener('abort', abort, { once: true });
        entry.task.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
        if (signal?.aborted) abort();
      });
    } finally {
      entry.readers--;
      if (!entry.readers && !entry.settled) entry.controller.abort(new Error('No SEC research readers remain.'));
    }
  };
}

export const secResearchJson = createSecResearchJson();

export function submissionRows(recent, cik) {
  return (recent?.accessionNumber || []).flatMap((accession, i) => {
    if (!RESEARCH_FORMS.test(recent.form[i])) return [];
    const primaryDoc = recent.primaryDocument?.[i];
    if (!primaryDoc) return [];
    return [{ accession, form: recent.form[i], filingDate: recent.filingDate[i], reportDate: recent.reportDate?.[i], primaryDoc, documentUrl: buildFilingUrl(cik, accession, primaryDoc) }];
  });
}

export async function loadResearchCompany(ticker, { history = false, since = '', signal } = {}) {
  const entry = await getOperatingTicker(ticker);
  if (!entry) throw new Error('No SEC operating company matched that ticker.');
  const cik = String(entry.cik).padStart(10, '0');
  const [submissions, data] = await Promise.all([
    secResearchJson(`/submissions/CIK${cik}.json`, signal),
    secResearchJson(`/api/xbrl/companyfacts/CIK${cik}.json`, signal),
  ]);
  if (!data?.facts) throw new Error('SEC company facts were unavailable.');
  let filings = submissionRows(submissions.filings?.recent, cik);
  let historyLimited = false;
  if (history) {
    const cutoff = since || new Date(Date.now() - 800 * 86400000).toISOString().slice(0, 10);
    const files = (submissions.filings?.files || []).filter((f) => f.filingTo >= cutoff);
    historyLimited = files.length > 8;
    for (const file of files.slice(0, 8)) {
      if (!/^CIK\d{10}-submissions-\d+\.json$/.test(file.name)) continue;
      try {
        const response = await secFetch(`https://data.sec.gov/submissions/${file.name}`, { headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com' }, signal, timeoutMs: 8000 });
        if (!response.ok) { historyLimited = true; continue; }
        filings.push(...submissionRows(await response.json(), cik));
      } catch { historyLimited = true; }
    }
  }
  filings = [...new Map(filings.map((f) => [f.accession, f])).values()].sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession));
  return { ticker, cik, companyName: submissions.name || entry.name, sic: submissions.sic, facts: data.facts, filings, historyLimited };
}
