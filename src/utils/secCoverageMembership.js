import { createHash } from 'node:crypto';
import { QUANT_GROUPS } from './quantGroups.js';

export const SEC_COVERAGE_VERSION = 'sec-coverage-v1';
export const SEC_COVERAGE_REFERENCE_URL = 'https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv';
const DAY_MS = 86400000;
const SECTORS = new Set(QUANT_GROUPS.map(group => group.label));
const fail = message => { throw new Error(`SEC coverage membership: ${message}`); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function normalizeSecCoverageTicker(value) {
  if (typeof value !== 'string') return null;
  const ticker = value.trim().toUpperCase().replace(/[ .]/g, '-');
  return /^[A-Z][A-Z0-9-]{0,9}$/.test(ticker) ? ticker : null;
}

export function normalizeSecCoverageCik(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const cik = String(value);
  return /^\d{1,10}$/.test(cik) && Number(cik) > 0 ? cik.padStart(10, '0') : null;
}

/** Stable issuer identity includes every share class, sector, and representative ticker. */
export function secCoverageFingerprint(issuers) {
  return sha256(JSON.stringify(issuers.map(row => [row.cik, row.ticker, row.name, row.sector, row.fund, [...row.aliases].sort()])
    .sort((a, b) => a[0].localeCompare(b[0]))));
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/**
 * Validate archived membership independently of its age. Freshness gates apply when
 * admitting a replacement, never when reading the last reviewed deployment snapshot.
 */
export function validateSecCoverageUniverse(value, { now = Date.now(), maxSourceAgeMs = null } = {}) {
  if (!Number.isFinite(now) || value?.version !== SEC_COVERAGE_VERSION || value.reference?.fund !== 'IVV'
    || value.reference?.url !== SEC_COVERAGE_REFERENCE_URL) fail('unsupported source or version.');
  const { reference, sourceSnapshot, issuers, securities } = value;
  if (!validDate(reference.asOf) || !Number.isFinite(Date.parse(reference.checkedAt))
    || Date.parse(reference.asOf) > Date.parse(reference.checkedAt)
    || Date.parse(reference.checkedAt) > now + 60000) fail('invalid source dates.');
  if (maxSourceAgeMs !== null && (!Number.isFinite(maxSourceAgeMs) || maxSourceAgeMs < 0
    || now - Date.parse(reference.asOf) > maxSourceAgeMs)) fail('source snapshot is stale.');
  if (!sourceSnapshot || !/^[a-f0-9]{64}$/.test(sourceSnapshot.sha256 || '')
    || typeof sourceSnapshot.path !== 'string' || !sourceSnapshot.path.length) fail('missing source snapshot evidence.');
  if (!Array.isArray(issuers) || issuers.length < 475 || issuers.length > 525
    || issuers.length !== value.issuerCount) fail('incomplete issuer count.');
  if (!Array.isArray(securities) || securities.length < 475 || securities.length > 550
    || securities.length !== value.securityCount) fail('incomplete security count.');

  const ciks = new Set(), aliases = new Map();
  for (const row of issuers) {
    if (!row || row.cik !== normalizeSecCoverageCik(row.cik) || ciks.has(row.cik)
      || row.ticker !== normalizeSecCoverageTicker(row.ticker) || row.fund !== 'IVV'
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 300
      || !SECTORS.has(row.sector) || !Array.isArray(row.aliases) || !row.aliases.length
      || row.aliases.length > 10 || !row.aliases.includes(row.ticker)) fail('invalid or duplicated issuer identity.');
    ciks.add(row.cik);
    for (const ticker of row.aliases) {
      if (ticker !== normalizeSecCoverageTicker(ticker) || aliases.has(ticker)) fail('ambiguous or duplicated security mapping.');
      aliases.set(ticker, row.cik);
    }
  }
  const observedSecurities = new Set();
  for (const row of securities) {
    if (!row || aliases.get(row.ticker) !== row.cik || observedSecurities.has(row.ticker)) fail('security and issuer mappings disagree.');
    observedSecurities.add(row.ticker);
  }
  if (aliases.size !== securities.length) fail('a share class was lost.');
  const fingerprint = secCoverageFingerprint(issuers);
  if (value.membershipFingerprint !== fingerprint
    || value.id !== `${SEC_COVERAGE_VERSION}:ivv:${reference.asOf}:${fingerprint.slice(0, 16)}`) fail('membership fingerprint differs.');
  return value;
}

/** Reuse the existing reviewed fund universe without introducing a new provider. */
export function buildSecCoverageUniverse(membership, { sourceSha256, sourcePath = 'src/data/quant-coverage.json', now = Date.now() } = {}) {
  if (membership?.version !== 'fund-holdings-1' || !Array.isArray(membership.sources) || !Array.isArray(membership.rows)) fail('invalid input manifest.');
  const sources = membership.sources.filter(source => source.fund === 'IVV');
  if (sources.length !== 1) fail('exactly one IVV source is required.');
  const source = sources[0];
  const issuers = membership.rows.filter(row => row.fund === 'IVV').map(row => ({
    ticker: row.ticker, cik: row.cik, name: row.name, sector: row.sector, fund: row.fund,
    aliases: Array.isArray(row.aliases) ? [...row.aliases].sort() : [],
  })).sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  const securities = issuers.flatMap(row => row.aliases.map(ticker => ({ ticker, cik: row.cik })))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (source.securities !== securities.length) fail('source security count differs from mapped share classes.');
  const membershipFingerprint = secCoverageFingerprint(issuers);
  return validateSecCoverageUniverse({
    version: SEC_COVERAGE_VERSION,
    id: `${SEC_COVERAGE_VERSION}:ivv:${source.as_of}:${membershipFingerprint.slice(0, 16)}`,
    label: 'S&P 500 coverage reference (IVV holdings)',
    reference: {
      fund: 'IVV', asOf: source.as_of, checkedAt: membership.checked_at, url: source.url,
      description: 'Listed equity holdings of IVV are a dated coverage proxy, not certified current index membership or SPY holdings.',
    },
    sourceSnapshot: { path: sourcePath, sha256: sourceSha256 },
    mapping: {
      sourceUrl: 'https://www.sec.gov/files/company_tickers.json',
      description: 'SEC CIK mappings preserved from the existing reviewed coverage manifest. One issuer may have multiple securities.',
    },
    membershipFingerprint, issuerCount: issuers.length, securityCount: securities.length, issuers, securities,
  }, { now, maxSourceAgeMs: 14 * DAY_MS });
}

/** New membership can be reviewed without dropping departed issuers' stored history. */
export function compareSecCoverageUniverses(previous, next, { now = Date.now() } = {}) {
  validateSecCoverageUniverse(previous, { now });
  validateSecCoverageUniverse(next, { now, maxSourceAgeMs: 14 * DAY_MS });
  if (Date.parse(next.reference.asOf) < Date.parse(previous.reference.asOf)) fail('source date moved backward.');
  const before = new Map(previous.issuers.map(row => [row.cik, row]));
  const after = new Map(next.issuers.map(row => [row.cik, row]));
  const added = next.issuers.filter(row => !before.has(row.cik));
  const removed = previous.issuers.filter(row => !after.has(row.cik));
  if (added.length > previous.issuerCount * 0.05 || removed.length > previous.issuerCount * 0.05) fail('membership turnover exceeds the review limit.');
  return { added, removed, changed: next.membershipFingerprint !== previous.membershipFingerprint };
}
