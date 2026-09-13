import { createHash } from 'node:crypto';
import { MEMBERSHIP_SOURCES, parseHoldingsCsv } from './quantMembership.js';
import {
  SEC_COVERAGE_REFERENCE_URL, buildSecCoverageUniverse, compareSecCoverageUniverses,
  normalizeSecCoverageCik, normalizeSecCoverageTicker, validateSecCoverageUniverse,
} from './secCoverageMembership.js';
import { secFetch } from './secClient.js';

const IVV_SOURCE = MEMBERSHIP_SOURCES.find(source => source.fund === 'IVV');
export const SEC_COVERAGE_DIRECTORY_URL = 'https://www.sec.gov/files/company_tickers.json';
export const SEC_COVERAGE_SOURCE_LIMITS = Object.freeze({ holdingsBytes: 750000, directoryBytes: 8000000, requestMs: 15000, totalMs: 45000, unlistedResidualUsd: 100000 });
const fail = (message, code = 'SEC_COVERAGE_SOURCE_INVALID') => {
  throw Object.assign(new Error(`SEC coverage membership: ${message}`), { code });
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function boundedSignal(signal, remainingMs) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) fail('source check deadline reached.', 'SEC_COVERAGE_SOURCE_DEADLINE');
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(SEC_COVERAGE_SOURCE_LIMITS.requestMs, remainingMs))));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBytes(response, maximum, signal, label) {
  if (!response?.ok || !response.body?.getReader) {
    await response?.body?.cancel().catch(() => {});
    fail(`${label} is unavailable.`, 'SEC_COVERAGE_SOURCE_UNAVAILABLE');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body.cancel().catch(() => {});
    fail(`${label} exceeds the download limit.`);
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) fail(`${label} exceeds the download limit.`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!size) fail(`${label} is empty.`);
  return Buffer.concat(chunks, size);
}

function decodeUtf8(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(`${label} is not valid UTF-8.`); }
}

function calendarDate(value) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const text = String(value || '').trim();
  let date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  const written = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (written && [...months, ...monthNames].includes(written[1].toLowerCase())) {
    date = `${written[3]}-${String(months.indexOf(written[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${written[2].padStart(2, '0')}`;
  }
  if (!date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail('holdings calendar date is invalid.');
  return date;
}

/** A conservative preflight: never let the shared parser silently omit equity rows. */
function auditCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = '';
      if (character === '\n') { rows.push(row); row = []; }
    } else cell += character;
  }
  if (quoted) fail('incomplete holdings CSV.');
  if (cell || row.length) rows.push([...row, cell.replace(/\r$/, '')]);
  const dates = rows.filter(values => values[0]?.trim() === 'Fund Holdings as of');
  const headers = rows.flatMap((values, index) => values[0] === 'Ticker' && values.includes('Asset Class') ? [index] : []);
  if (dates.length !== 1 || headers.length !== 1) fail('holdings date or header is ambiguous.');
  const names = rows[headers[0]];
  if (['Ticker', 'Name', 'Sector', 'Asset Class', 'Exchange'].some(name => names.filter(value => value === name).length !== 1)) {
    fail('holdings columns are incomplete or ambiguous.');
  }
  const index = name => names.indexOf(name), seen = new Set(), equityTickers = new Set(), exclusions = [];
  const decimal = value => typeof value === 'string' && /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(value)
    ? Number(value.replaceAll(',', '')) : NaN;
  let residualUsd = 0;
  let ended = false;
  for (const values of rows.slice(headers[0] + 1)) {
    const equity = values[index('Asset Class')] === 'Equity';
    if (!values.some(value => value.trim())) { ended = true; continue; }
    if (values.length !== names.length) {
      // Official CSV footnotes follow the completed holdings table. No shortened
      // table row, including a malformed equity row, is accepted inside it.
      if (!ended || equity) fail('holdings row is incomplete.');
      continue;
    }
    if (ended) fail('holdings rows appear after the table ended.');
    if (!equity) continue;
    const ticker = normalizeSecCoverageTicker(values[index('Ticker')]);
    const exchange = values[index('Exchange')]?.trim();
    if (ticker && equityTickers.has(ticker)) fail('a normalized equity ticker is duplicated.');
    if (ticker) equityTickers.add(ticker);
    if (!values[index('Name')]?.trim() || values[index('Name')].length > 300) fail('an equity holding has no valid name.');
    if (ticker && exchange.length <= 100 && /^NO MARKET(?:\s|$)/i.test(exchange || '')) {
      const marketValueUsd = decimal(values[index('Market Value')]);
      const weightPercent = decimal(values[index('Weight (%)')]);
      if (exclusions.length < 25 && values[index('Currency')] === 'USD' && weightPercent === 0 && marketValueUsd >= 0
        && residualUsd + marketValueUsd <= SEC_COVERAGE_SOURCE_LIMITS.unlistedResidualUsd) {
        residualUsd += marketValueUsd;
        exclusions.push({ ticker, name: values[index('Name')], exchange, currency: 'USD', marketValueUsd, weightPercent,
          reason: 'Unlisted residual holding, excluded from listed-security research coverage.' });
        continue;
      }
    }
    if (!ticker || !exchange || /^(NO MARKET|-$)/i.test(exchange)) fail('an equity holding has no unambiguous listed security.');
    seen.add(ticker);
  }
  // iShares supplies a calendar date, not a timestamp in the worker's timezone.
  // Keep the downloaded bytes untouched; normalize only the parser's input.
  dates[0][1] = `${calendarDate(dates[0][1])}T00:00:00Z`;
  const parserText = rows.map(values => values.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\n');
  return { securities: seen, parserText, exclusions };
}

/** Fresh identity admission uses the existing application-wide SEC gate, without stale-cache fallback. */
export async function resolveFreshSecCoverageTickers(tickers, { signal, deadline = Date.now() + SEC_COVERAGE_SOURCE_LIMITS.requestMs, now = Date.now, fetchSec = secFetch } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const requestSignal = boundedSignal(signal, deadline - clock());
  const response = await fetchSec(SEC_COVERAGE_DIRECTORY_URL, {
    signal: requestSignal, timeoutMs: Math.min(SEC_COVERAGE_SOURCE_LIMITS.requestMs, Math.max(1, deadline - clock())),
    maxBytes: SEC_COVERAGE_SOURCE_LIMITS.directoryBytes, retries: 0, cache: 'no-store', headers: { Accept: 'application/json' },
  });
  const bytes = await readBytes(response, SEC_COVERAGE_SOURCE_LIMITS.directoryBytes, requestSignal, 'SEC ticker directory');
  let raw;
  try { raw = JSON.parse(decodeUtf8(bytes, 'SEC ticker directory')); }
  catch { fail('SEC ticker directory is invalid.'); }
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') fail('SEC ticker directory is invalid.');
  const entries = Object.values(raw);
  if (entries.length < 475 || entries.length > 50000) fail('SEC ticker directory is incomplete.');
  const wanted = new Set(tickers), directory = Object.create(null);
  for (const entry of entries) {
    const ticker = normalizeSecCoverageTicker(entry?.ticker);
    if (!wanted.has(ticker)) continue;
    const cik = normalizeSecCoverageCik(entry.cik_str);
    if (!cik || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 300) fail('SEC ticker identity is invalid.');
    if (directory[ticker] && directory[ticker].cik !== cik) fail('SEC ticker identity is ambiguous.');
    directory[ticker] = { cik, name: entry.title.trim() };
  }
  return { directory, sourceSha256: sha256(bytes), checkedAt: new Date(clock()).toISOString() };
}

/** Scheduled ingestion only: returns a candidate and evidence; never changes active membership. */
export async function refreshSecCoverageMembershipSource({ previous, signal, deadline, now = Date.now, fetchImpl = fetch, resolveTickers = resolveFreshSecCoverageTickers } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const startedAt = clock();
  validateSecCoverageUniverse(previous, { now: startedAt });
  const boundedDeadline = Math.min(deadline ?? startedAt + SEC_COVERAGE_SOURCE_LIMITS.totalMs, startedAt + SEC_COVERAGE_SOURCE_LIMITS.totalMs);
  const requestSignal = boundedSignal(signal, boundedDeadline - startedAt);
  const response = await fetchImpl(SEC_COVERAGE_REFERENCE_URL, {
    method: 'GET', signal: requestSignal, cache: 'no-store', redirect: 'error',
    headers: { Accept: 'text/csv,text/plain;q=0.9' },
  });
  const sourceBytes = await readBytes(response, SEC_COVERAGE_SOURCE_LIMITS.holdingsBytes, requestSignal, 'IVV holdings');
  const contentType = response.headers.get('content-type') || '';
  if (/\b(?:text\/html|application\/json)\b/i.test(contentType)) fail('IVV returned an unexpected payload.');
  const fetchedAt = new Date(clock()).toISOString();
  const text = decodeUtf8(sourceBytes, 'IVV holdings'), audited = auditCsv(text);
  const holdings = parseHoldingsCsv(audited.parserText, IVV_SOURCE, clock());
  if (audited.securities.size !== holdings.securities) fail('an equity holding was omitted by the parser.');
  const mapping = await resolveTickers(holdings.rows.map(row => row.ticker), { signal, deadline: boundedDeadline, now: clock });
  const directory = mapping?.directory;
  if (!directory || typeof directory !== 'object' || Array.isArray(directory)
    || !/^[a-f0-9]{64}$/.test(mapping.sourceSha256 || '')
    || !Number.isFinite(Date.parse(mapping.checkedAt))
    || Date.parse(mapping.checkedAt) < startedAt || Date.parse(mapping.checkedAt) > clock() + 60000) fail('fresh SEC mapping evidence is missing.');
  const issuers = new Map(), preferred = new Map(previous.issuers.map(row => [row.cik, row.ticker]));
  for (const row of holdings.rows) {
    const identity = Object.hasOwn(directory, row.ticker) && directory[row.ticker];
    const cik = normalizeSecCoverageCik(identity?.cik);
    if (!cik || typeof identity.name !== 'string' || !identity.name.trim() || identity.name.length > 300) fail(`SEC mapping is unavailable for ${row.ticker}.`);
    const existing = issuers.get(cik);
    if (existing) {
      if (existing.sector !== row.sector || existing.name !== identity.name.trim()) fail('share classes disagree on issuer identity or sector.');
      existing.aliases.push(row.ticker);
    } else issuers.set(cik, { cik, ticker: row.ticker, name: identity.name.trim(), sector: row.sector, fund: 'IVV', aliases: [row.ticker] });
  }
  for (const issuer of issuers.values()) {
    issuer.aliases.sort();
    issuer.ticker = issuer.aliases.includes(preferred.get(issuer.cik)) ? preferred.get(issuer.cik) : issuer.aliases[0];
  }
  const sourceSha256 = sha256(sourceBytes), sourceAsOf = holdings.as_of;
  const candidate = buildSecCoverageUniverse({
    version: 'fund-holdings-1', checked_at: fetchedAt,
    sources: [{ fund: 'IVV', as_of: sourceAsOf, url: SEC_COVERAGE_REFERENCE_URL, securities: holdings.securities }],
    rows: [...issuers.values()],
  }, { sourceSha256, sourcePath: `memberships/ivv/${sourceAsOf}/${sourceSha256}.csv`, now: clock() });
  candidate.mapping = {
    sourceUrl: SEC_COVERAGE_DIRECTORY_URL, sourceSha256: mapping.sourceSha256, checkedAt: mapping.checkedAt,
    description: 'Fresh SEC operating-company ticker directory. Securities remain distinct and are grouped only by their SEC CIK.',
  };
  candidate.sourceExclusions = audited.exclusions;
  const changes = compareSecCoverageUniverses(previous, candidate, { now: clock() });
  const before = new Map(previous.securities.map(row => [row.ticker, row.cik]));
  const after = new Map(candidate.securities.map(row => [row.ticker, row.cik]));
  const changedBefore = previous.securities.filter(row => after.get(row.ticker) !== row.cik).length;
  const changedAfter = candidate.securities.filter(row => before.get(row.ticker) !== row.cik).length;
  if (Math.max(changedBefore, changedAfter) > previous.securityCount * 0.05) fail('security turnover exceeds the review limit.');
  if (clock() >= boundedDeadline) fail('source check deadline reached.', 'SEC_COVERAGE_SOURCE_DEADLINE');
  signal?.throwIfAborted();
  return { candidate, sourceBytes, sourceSha256, sourceAsOf, fetchedAt, changes };
}
