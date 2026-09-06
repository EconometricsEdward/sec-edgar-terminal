import { getOperatingTicker, getFundTicker } from './tickerMap.js';
import { warmGet, warmSet } from './warmCache.js';
import { validTicker } from './researchWorkspace.js';
import { normalizeFilingRows, validFilingDate } from './filingsResearch.js';

export const FILINGS_VERSION = 'filings-v1';
const localCache = new Map();
function failure(message, status = 502, code = 'SEC_UNAVAILABLE') {
  return Object.assign(new Error(message), { status, code });
}
function validateSubmissions(data, path) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('SEC returned an invalid submissions response. Retry this request.');
  const archived = path.includes('-submissions-');
  if (!archived) {
    const cik = path.slice(3, 13);
    if (String(data.cik || '').replace(/^0+/, '') !== String(Number(cik))) throw failure('SEC submissions did not match the requested company identity.');
    // An absent/malformed manifest is unknown history, never an empty archive list.
    if (!Array.isArray(data.filings?.files)) throw failure('SEC returned an incomplete archive manifest. Retry this request.');
  }
  const recent = archived ? data : data.filings?.recent;
  if (!Array.isArray(recent?.accessionNumber) || !Array.isArray(recent?.form) || !Array.isArray(recent?.filingDate)) throw failure(`SEC returned incomplete ${archived ? 'archived' : 'recent'} filing metadata. Retry this request.`);
  return data;
}
async function secJson(path, signal) {
  if (!/^CIK\d{10}(?:-submissions-\d+)?\.json$/.test(path)) throw failure('Invalid SEC submissions path.', 400, 'INVALID_ARCHIVE');
  signal?.throwIfAborted();
  const now = Date.now();
  const local = localCache.get(path);
  if (local?.expiresAt > now) return local.data;
  const cached = await warmGet('filings-submissions-v1', path);
  if (cached) {
    try { return validateSubmissions(cached, path); }
    catch { /* A bad cache entry must not prevent a fresh SEC retry. */ }
  }
  const response = await fetch(`https://data.sec.gov/submissions/${path}`, {
    headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com', Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    cache: 'no-store',
  });
  if (!response.ok) throw failure(`SEC submissions are temporarily unavailable (HTTP ${response.status}). Retry this request.`);
  // Validate before caching, so a transient malformed response can be retried.
  const data = validateSubmissions(await response.json(), path);
  while (localCache.size >= 18) localCache.delete(localCache.keys().next().value);
  localCache.set(path, { data, expiresAt: now + 300000 });
  await warmSet('filings-submissions-v1', path, data, 300);
  return data;
}
export function normalizeFilingsArchives(files, cik) {
  if (!Array.isArray(files) || !/^\d{10}$/.test(String(cik))) return [];
  const byName = new Map();
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !new RegExp(`^CIK${cik}-submissions-\\d+\\.json$`).test(file.name)
      || !validFilingDate(file.filingFrom) || !validFilingDate(file.filingTo) || file.filingFrom > file.filingTo) continue;
    byName.set(file.name, { name: file.name, filingFrom: file.filingFrom, filingTo: file.filingTo,
      filingCount: Number.isInteger(file.filingCount) && file.filingCount >= 0 ? file.filingCount : null });
  }
  return [...byName.values()].sort((a, b) => b.filingTo.localeCompare(a.filingTo) || b.filingFrom.localeCompare(a.filingFrom) || a.name.localeCompare(b.name));
}
export async function loadFilingsCompany(input, { signal } = {}) {
  const ticker = String(input || '').trim().toUpperCase();
  if (!validTicker(ticker)) throw failure('Provide a valid company ticker.', 400, 'INVALID_TICKER');
  signal?.throwIfAborted();
  let identity;
  try { identity = await getOperatingTicker(ticker); }
  catch { throw failure('The SEC company directory is temporarily unavailable. Retry the lookup.'); }
  if (!identity) {
    let fund;
    try { fund = await getFundTicker(ticker); }
    catch { throw failure('The SEC fund directory is temporarily unavailable. Retry the lookup.'); }
    if (fund) return { ticker, ...fund, kind: 'fund', name: ticker, filings: [], archives: [], redirect: `/fund/${encodeURIComponent(ticker)}`, observedAt: new Date().toISOString() };
    throw failure(`No SEC company or fund matched the exact ticker ${ticker}.`, 404, 'UNKNOWN_TICKER');
  }
  const cik = String(identity.cik).padStart(10, '0');
  if (!/^\d{10}$/.test(cik) || Number(cik) <= 0) throw failure('SEC company identity could not be validated. Retry the lookup.');
  const submissions = await secJson(`CIK${cik}.json`, signal);
  if (String(submissions.cik || '').replace(/^0+/, '') !== String(Number(cik))) throw failure('SEC submissions did not match the requested company identity.');
  const recent = submissions.filings?.recent;
  if (!Array.isArray(recent?.accessionNumber) || !Array.isArray(recent?.form) || !Array.isArray(recent?.filingDate)) throw failure('SEC returned incomplete recent filing metadata. Retry this request.');
  const filings = normalizeFilingRows(recent, cik);
  const archives = normalizeFilingsArchives(submissions.filings?.files, cik);
  const omittedRecords = Math.max(0, recent.accessionNumber.length - filings.length);
  const omittedArchives = Array.isArray(submissions.filings?.files) ? Math.max(0, submissions.filings.files.length - archives.length) : 0;
  return {
    ticker, cik, kind: 'operating', name: submissions.name || identity.name,
    sic: submissions.sic == null ? '' : String(submissions.sic), sicDescription: submissions.sicDescription || '',
    exchange: Array.isArray(submissions.exchanges) ? submissions.exchanges.filter((e) => typeof e === 'string').join(', ') : '',
    filings, archives, omittedRecords, omittedArchives, coverage: { omittedRecords, omittedArchives },
    observedAt: new Date().toISOString(),
  };
}
export async function loadFilingsArchive(ticker, name, { signal } = {}) {
  if (typeof name !== 'string' || !/^CIK\d{10}-submissions-\d+\.json$/.test(name)) throw failure('Provide a valid SEC archive name.', 400, 'INVALID_ARCHIVE');
  const company = await loadFilingsCompany(ticker, { signal });
  if (company.kind === 'fund') throw failure('Open this ticker in the Funds workspace.', 400, 'FUND_TICKER');
  const archive = company.archives.find((item) => item.name === name);
  if (!archive) throw failure('This archive is not listed in the requested company’s SEC submissions manifest.', 400, 'INVALID_ARCHIVE');
  const recent = await secJson(name, signal);
  if (!Array.isArray(recent.accessionNumber) || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) throw failure('SEC returned incomplete archived filing metadata. Retry this archive.');
  const filings = normalizeFilingRows(recent, company.cik).map((filing) => ({ ...filing, archive: name }));
  const omittedRecords = Math.max(0, recent.accessionNumber.length - filings.length);
  return { ticker: company.ticker, cik: company.cik, filings, archive, omittedRecords, coverage: { omittedRecords }, observedAt: new Date().toISOString() };
}
