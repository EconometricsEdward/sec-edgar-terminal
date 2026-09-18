import { getOperatingTicker } from './tickerMap.js';
import { secResearchJson } from './secResearchData.js';
import { secFetch } from './secClient.js';
import { readBoundedFilingResponse } from './filingsReader.js';
import { companyExposureFilings } from './companyExposureServer.js';
import { extractRiskNoteFacts, verifiesJointRegistrantFacts, RISK_NOTE_FACTS_VERSION, RISK_NOTE_MAX_BYTES } from './riskNoteFacts.js';
import { SEC_EVIDENCE_CONTINUITY } from './secEvidenceContinuity.js';
import { warmGet, warmSet } from './warmCache.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const completeRows = rows => Array.isArray(rows?.accessionNumber)
  && ['form', 'filingDate', 'reportDate', 'primaryDocument'].every(key => Array.isArray(rows[key]) && rows[key].length === rows.accessionNumber.length);
const annualForms = new Set(['10-K', '20-F', '40-F']);
export const RISK_NOTE_LIMITATIONS = [
  'This view reads standard derivative-notional and credit-concentration facts in one SEC primary filing. Custom concepts, typed dimensions, non-USD amounts and untagged narrative tables are outside this extraction.',
  'Derivative notionals are contract reference amounts, not fair values, expected losses, net currency exposure or estimates of hedge effectiveness. Designated and nondesignated contracts remain separate.',
  'Concentration percentages retain their reported benchmark. Customer groups may overlap, and anonymous customer or vendor labels do not establish the same counterparty across filings.',
  'Comparisons use matching concept, unit and dimensions within the same filing. An absent fact or comparison is not zero risk. SEC context dates remain available with each value.',
];

export function parseRiskNoteRequest(input, now = new Date()) {
  const params = new URL(input).searchParams;
  if ([...params.keys()].some(key => !['ticker', 'basis', 'asOf'].includes(key) || params.getAll(key).length !== 1))
    throw fail('Use an exact ticker, basis and optional filing-date cutoff.');
  const ticker = (params.get('ticker') || '').trim().toUpperCase(), basis = params.get('basis') || 'ttm', asOf = params.has('asOf') ? params.get('asOf') : null;
  if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker) || !['annual', 'ttm'].includes(basis)) throw fail('Provide a valid company ticker and annual or ttm basis.');
  if (asOf !== null && (!validDate(asOf) || asOf < '1994-01-01' || asOf > new Date(now).toISOString().slice(0, 10))) throw fail('Use a valid filing-date cutoff between 1994 and today.');
  return { ticker, basis, asOf };
}

export function selectRiskNoteFiling(filings, basis) {
  return [...filings].filter(filing => basis !== 'annual' || annualForms.has(filing.form))
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filed.localeCompare(a.filed))[0] || null;
}
async function loadHtml(filing, signal) {
  const response = await secFetch(filing.url, { signal, timeoutMs: 18_000, retries: 1, maxBytes: RISK_NOTE_MAX_BYTES, redirect: 'error', headers: { Accept: 'text/html,text/plain' } });
  if (!response.ok) throw fail('The selected SEC filing could not be retrieved. Please retry.', 503);
  if (/application\/pdf|image\/|application\/(?:zip|octet-stream)/i.test(response.headers.get('content-type') || '')) throw fail('The selected SEC filing does not contain readable inline facts.', 422);
  return readBoundedFilingResponse(response, RISK_NOTE_MAX_BYTES);
}

/** One document per request, selected only from the verified issuer manifest.
 * A historical cutoff may inspect two SEC manifest archives; it never silently
 * substitutes an older readable filing when the selected document fails.
 */
export async function discoverRiskNoteFacts(selection, { now = new Date(), signal, lookupTicker = getOperatingTicker,
  loadSubmissions = (file, requestSignal) => secResearchJson(`/submissions/${file}`, requestSignal), loadFiling = loadHtml, extractFacts = extractRiskNoteFacts } = {}) {
  const checked = parseRiskNoteRequest(`https://example.test/?ticker=${encodeURIComponent(selection.ticker || '')}&basis=${encodeURIComponent(selection.basis || 'ttm')}${selection.asOf == null ? '' : `&asOf=${encodeURIComponent(selection.asOf)}`}`, now);
  const checkedAt = new Date(now).toISOString(), cutoff = checked.asOf || checkedAt.slice(0, 10);
  const entry = await lookupTicker(checked.ticker);
  if (!entry) throw fail('No SEC operating company matched that ticker.', 404);
  const cik = String(entry.cik).padStart(10, '0');
  if (!/^\d{10}$/.test(cik) || Number(cik) <= 0) throw fail('The company SEC identity is unavailable.', 502);
  const manifest = await loadSubmissions(`CIK${cik}.json`, signal);
  if (String(manifest?.cik).padStart(10, '0') !== cik || !completeRows(manifest?.filings?.recent)) throw fail('The SEC manifest did not verify the selected issuer.', 502);
  const result = { schemaVersion: RISK_NOTE_FACTS_VERSION, ...checked, cik, companyName: String(manifest.name || entry.name || checked.ticker).slice(0, 500),
    sic: String(manifest.sic || ''), checkedAt, status: 'no_filing', filing: null, rows: [], coverage: { historyFilesScanned: 0, historyLimited: false, documentBytesLimit: RISK_NOTE_MAX_BYTES }, limitations: RISK_NOTE_LIMITATIONS };
  let filings = companyExposureFilings(manifest.filings.recent, cik, cutoff);
  const archives = (Array.isArray(manifest.filings.files) ? manifest.filings.files : []).filter(file => new RegExp(`^CIK${cik}-submissions-\\d+\\.json$`).test(file.name)
    && validDate(file.filingFrom) && validDate(file.filingTo) && file.filingFrom <= cutoff && file.filingFrom <= file.filingTo)
    .sort((a, b) => b.filingTo.localeCompare(a.filingTo));
  for (const file of archives) {
    const selected = selectRiskNoteFiling(filings, checked.basis);
    if (selected && file.filingTo < selected.filed) break;
    if (result.coverage.historyFilesScanned >= 2) { result.coverage.historyLimited = true; break; }
    result.coverage.historyFilesScanned++;
    const older = await loadSubmissions(file.name, signal);
    if (!completeRows(older)) throw fail('The SEC historical manifest could not be verified.', 502);
    filings = filings.concat(companyExposureFilings(older, cik, cutoff));
  }
  result.filing = selectRiskNoteFiling(filings, checked.basis);
  if (!result.filing) { result.message = 'No eligible original filing was located in the bounded SEC manifest search.'; return result; }
  const html = await loadFiling(result.filing, signal);
  let factCik = cik;
  const transition = SEC_EVIDENCE_CONTINUITY[cik];
  // Only the independently verified joint filing can use predecessor contexts.
  // Its presence in the successor manifest alone does not establish identity.
  if (transition?.predecessorCiks.length === 1 && transition.source.filed <= cutoff
    && result.filing.accession === transition.source.accession && result.filing.reportDate === transition.source.reportDate
    && result.filing.reportDate < transition.effectiveDate
    && verifiesJointRegistrantFacts(html, { cik, predecessorCik: transition.predecessorCiks[0], filing: result.filing })) {
    factCik = transition.predecessorCiks[0];
    result.limitations = [...RISK_NOTE_LIMITATIONS, `This verified joint filing reports predecessor ${transition.predecessorName} (CIK ${factCik}) before the ${transition.effectiveDate} registrant transition.`];
    result.coverage = { ...result.coverage, factCik, registrantTransition: transition.description };
  }
  const extracted = extractFacts(html, { cik: factCik, filing: result.filing });
  result.rows = extracted.rows;
  result.coverage = { ...result.coverage, ...extracted.coverage };
  result.status = result.rows.length ? 'ready' : 'no_matches';
  if (!result.rows.length) result.message = 'No supported tagged note amounts matched the selected filing. Review its disclosures for custom tags, untagged tables and other risks.';
  return result;
}

export async function loadRiskNoteFacts(selection, { signal } = {}) {
  const key = `${selection.ticker}:${selection.basis}:${selection.asOf || 'latest'}`;
  const saved = await warmGet(RISK_NOTE_FACTS_VERSION, key);
  if (saved) return saved;
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45_000)]);
  const result = await discoverRiskNoteFacts(selection, { signal: requestSignal });
  if (!result.coverage.historyLimited) await warmSet(RISK_NOTE_FACTS_VERSION, key, result, result.status === 'ready' ? 3600 : 600);
  return result;
}
