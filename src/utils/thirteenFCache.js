import { createHash } from 'node:crypto';
import { cacheGet, cachePut, disposableCacheEnabled } from './disposableCache.js';
import { reconcile13FTable, summarize13FPortfolio } from './thirteenF.js';
import { validFilingDate } from './filingsResearch.js';

export const THIRTEEN_F_CACHE_VERSION = 'edgar.13f-prepared.v1';
export const THIRTEEN_F_FRESH_MS = 5 * 60 * 1000;
export const THIRTEEN_F_STALE_MS = 24 * 60 * 60 * 1000;
export const THIRTEEN_F_SNAPSHOT_TYPE = 'edgar.13f-snapshot.v1:production';
export const THIRTEEN_F_FILING_TYPE = 'edgar.13f-filing.v1:production';
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const FORM = /^13F-(HR|NT)(?:\/A)?$/;
const quarter = value => validFilingDate(value) && /-(03-31|06-30|09-30|12-31)$/.test(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const boundedString = (value, max = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const snapshotId = (cik, period) => `${cik}:${period || 'LATEST'}`;
const reportFields = filing => [filing.accession, filing.reportDate || '', filing.filingDate, filing.form, filing.primaryDoc || ''];

export function thirteenFFilingCacheKey(cik, filing) {
  return `${cik}:${filing.accession}:${hash([THIRTEEN_F_CACHE_VERSION, cik, ...reportFields(filing)])}`;
}
function validHolding(row) {
  return row && /^[A-Z0-9*@#]{9}$/.test(row.cusip) && boundedString(row.issuer) && boundedString(row.classTitle)
    && [null, 'PUT', 'CALL'].includes(row.putCall) && ['SH', 'PRN'].includes(row.quantityType)
    && row.key === [row.cusip, row.putCall || 'SECURITY', row.quantityType].join('|')
    && number(row.quantity) && Number.isSafeInteger(row.valueUsd) && row.valueUsd >= 0
    && Number.isSafeInteger(row.sourceRowCount) && row.sourceRowCount >= 1 && row.sourceRowCount <= 20000
    && typeof row.investmentDiscretion === 'string' && row.investmentDiscretion.split(', ').every(value => ['SOLE', 'DFND', 'OTR'].includes(value))
    && row.votingAuthority && ['sole', 'shared', 'none'].every(key => number(row.votingAuthority[key]));
}
function validSource(filing, cik, period) {
  if (!filing || !ACCESSION.test(filing.accession) || !FORM.test(filing.form) || filing.reportDate !== period
    || !validFilingDate(filing.filingDate) || filing.filingDate < period || !Array.isArray(filing.tableUrls) || filing.tableUrls.length > 15) return false;
  const root = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${filing.accession.replaceAll('-', '')}/`;
  const document = value => typeof value === 'string' && value.startsWith(root)
    && /^[\w][\w.-]{0,239}\.xml$/i.test(value.slice(root.length)) && !value.slice(root.length).includes('..');
  return filing.indexUrl === `${root}${filing.accession}-index.html` && document(filing.primaryUrl)
    && filing.tableUrls.length > 0 && filing.tableUrls.every(document) && new Set(filing.tableUrls).size === filing.tableUrls.length;
}
function validPortfolio(data, cik, period) {
  const p = data?.portfolio;
  if (data?.status !== 'ready' || data.manager?.cik !== cik || !boundedString(data.manager.name) || !quarter(data.selectedPeriod)
    || period && data.selectedPeriod !== period || !iso(data.observedAt) || data.coverage?.selectedPeriodComplete !== true
    || !p || p.cik !== cik || p.period !== data.selectedPeriod || p.complete !== true
    || !Number.isSafeInteger(p.totalValueUsd) || p.totalValueUsd < 0 || !Array.isArray(p.holdings) || p.holdings.length > 20000
    || p.positionCount !== p.holdings.length || !Array.isArray(p.issues) || p.issues.length !== 0
    || !Array.isArray(p.filings) || !p.filings.length || p.filings.length > 16
    || !p.filings.every(f => validSource(f, cik, p.period)) || new Set(p.filings.map(f => f.accession)).size !== p.filings.length
    || !['13F HOLDINGS REPORT', '13F COMBINATION REPORT'].includes(p.reportType) || typeof p.confidentialOmitted !== 'boolean'
    || p.comparable !== (!p.confidentialOmitted && p.reportType === '13F HOLDINGS REPORT')
    || !p.holdings.every(validHolding) || new Set(p.holdings.map(row => row.key)).size !== p.holdings.length) return false;
  const total = p.holdings.reduce((sum, row) => sum + row.valueUsd, 0);
  if (total !== p.totalValueUsd || !Number.isSafeInteger(total)
    || p.entryCount !== p.holdings.reduce((sum, row) => sum + row.sourceRowCount, 0)
    || p.holdings.some(row => p.totalValueUsd > 0 ? row.weightPct !== row.valueUsd / p.totalValueUsd * 100 : row.weightPct !== null)) return false;
  if (!Array.isArray(data.reports) || !data.reports.length || data.reports.length > 41
    || data.reports.some(row => !quarter(row.period) || !Number.isSafeInteger(row.filingCount) || row.filingCount < 1
      || !validFilingDate(row.latestFiled) || !Array.isArray(row.forms) || row.forms.some(form => !FORM.test(form)))
    || new Set(data.reports.map(row => row.period)).size !== data.reports.length) return false;
  const selected = data.reports.find(row => row.period === p.period);
  if (!selected || selected.filingCount !== p.filings.length || selected.latestFiled !== p.filings.map(f => f.filingDate).sort().at(-1)) return false;
  if (!period && data.selectedPeriod !== data.reports.map(row => row.period).sort().at(-1)) return false;
  const summary = summarize13FPortfolio(p); delete summary.holdings;
  return hash(summary) === hash(data.summary);
}

export function valid13FSnapshot(value, cik, period, now = Date.now()) {
  try {
    return value?.schemaVersion === THIRTEEN_F_CACHE_VERSION && value.cik === cik && value.requestedPeriod === (period || '')
      && iso(value.checkedAt) && Date.parse(value.checkedAt) <= now && now - Date.parse(value.checkedAt) <= THIRTEEN_F_STALE_MS
      && (value.invalidatedAt === undefined || iso(value.invalidatedAt) && Date.parse(value.invalidatedAt) >= Date.parse(value.checkedAt) && Date.parse(value.invalidatedAt) <= now)
      && Date.parse(value.data?.observedAt) <= Date.parse(value.checkedAt)
      && value.data?.cache?.stale !== true && validPortfolio(value.data, cik, period)
      && value.sourceChainHash === hash(value.data.portfolio.filings);
  } catch { return false; }
}
export function valid13FFiling(value, cik, filing, now = Date.now()) {
  try {
    const report = value?.report, cover = report?.cover;
    return value?.schemaVersion === THIRTEEN_F_CACHE_VERSION && value.cik === cik && value.key === thirteenFFilingCacheKey(cik, filing)
      && iso(value.observedAt) && Date.parse(value.observedAt) <= now && now - Date.parse(value.observedAt) <= 30 * 86400000
      && cover?.cik === cik && quarter(cover.period) && (!filing.reportDate || cover.period === filing.reportDate)
      && cover.form === filing.form && cover.filingDate === filing.filingDate && boundedString(cover.managerName)
      && ['13F HOLDINGS REPORT', '13F COMBINATION REPORT'].includes(cover.reportType) && /^13F-HR/.test(filing.form)
      && cover.valueMultiplier === (filing.filingDate < '2023-01-03' ? 1000 : 1) && typeof cover.confidentialOmitted === 'boolean'
      && cover.isAmendment === filing.form.endsWith('/A') && (!cover.isAmendment || Number.isSafeInteger(cover.amendmentNumber)
        && cover.amendmentNumber > 0 && ['RESTATEMENT', 'NEW HOLDINGS'].includes(cover.amendmentType))
      && validSource(report.filing, cik, cover.period) && report.filing.accession === filing.accession
      && report.filing.form === filing.form && report.filing.filingDate === filing.filingDate
      && report.filing.primaryUrl.endsWith(`/${filing.primaryDoc.split('/').pop()}`)
      && report.complete === true && Array.isArray(report.issues) && report.issues.length === 0
      && Array.isArray(report.holdings) && report.holdings.length <= 20000 && report.holdings.every(validHolding)
      && reconcile13FTable(report.holdings, cover).complete;
  } catch { return false; }
}

/** Existing production identity and compressed disposable cache; no legacy cache reads. */
export function create13FCache({ enabled = disposableCacheEnabled, read = cacheGet, write = cachePut, now = Date.now,
  maxLocalFilingBytes = 10 * 1024 * 1024, timeoutMs = 1500 } = {}) {
  const local = new Map(), invalidFilingHashes = new Map(); let localBytes = 0;
  function remember(key, value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxLocalFilingBytes) return;
    if (local.has(key)) { localBytes -= local.get(key).bytes; local.delete(key); }
    while (local.size && (localBytes + bytes > maxLocalFilingBytes || local.size >= 48)) {
      const oldest = local.keys().next().value; localBytes -= local.get(oldest).bytes; local.delete(oldest);
    }
    local.set(key, { value, bytes }); localBytes += bytes;
  }
  const options = signal => ({ signal, timeoutMs, deadline: now() + timeoutMs });
  async function readRecord(type, id, signal) {
    if (!enabled() || signal?.aborted) return null;
    try { return await read(type, id, options(signal)); } catch { return null; }
  }
  return {
    async readSnapshot(cik, period, signal) {
      const row = await readRecord(THIRTEEN_F_SNAPSHOT_TYPE, snapshotId(cik, period), signal);
      return valid13FSnapshot(row?.payload, cik, period, now()) ? row.payload : null;
    },
    async writeSnapshot(data, period, checkedAt, signal) {
      const cik = data.manager.cik, id = snapshotId(cik, period);
      const value = { schemaVersion: THIRTEEN_F_CACHE_VERSION, cik, requestedPeriod: period || '', checkedAt,
        sourceChainHash: hash(data.portfolio?.filings), data };
      if (!enabled() || !valid13FSnapshot(value, cik, period, now()) || signal?.aborted) return false;
      const old = await readRecord(THIRTEEN_F_SNAPSHOT_TYPE, id, signal);
      if (valid13FSnapshot(old?.payload, cik, period, now()) && (Date.parse(old.payload.checkedAt) > Date.parse(checkedAt)
        || old.payload.invalidatedAt && Date.parse(old.payload.invalidatedAt) > Date.parse(checkedAt))) return false;
      try { return (await write(THIRTEEN_F_SNAPSHOT_TYPE, id, value, 25 * 3600,
        { ...options(signal), ifHash: old?.rawSha256 || 'absent' }))?.stored === true; } catch { return false; }
    },
    async invalidateSnapshot(cik, period, selectedPeriod, invalidatedAt, signal) {
      if (!enabled() || !iso(invalidatedAt) || Date.parse(invalidatedAt) > now() || signal?.aborted) return false;
      const id = snapshotId(cik, period), old = await readRecord(THIRTEEN_F_SNAPSHOT_TYPE, id, signal);
      if (!valid13FSnapshot(old?.payload, cik, period, now()) || (period ? old.payload.data.selectedPeriod !== selectedPeriod : old.payload.data.selectedPeriod > selectedPeriod)
        || Date.parse(old.payload.checkedAt) > Date.parse(invalidatedAt)
        || old.payload.invalidatedAt && Date.parse(old.payload.invalidatedAt) >= Date.parse(invalidatedAt)) return false;
      const remaining = Math.floor((Date.parse(old.expiresAt) - now()) / 1000);
      if (!Number.isSafeInteger(remaining) || remaining <= 0) return false;
      const value = { ...old.payload, invalidatedAt };
      try { return (await write(THIRTEEN_F_SNAPSHOT_TYPE, id, value, Math.min(25 * 3600, remaining),
        { ...options(signal), ifHash: old.rawSha256, expiresAt: old.expiresAt }))?.stored === true; } catch { return false; }
    },
    async readFiling(cik, filing, signal) {
      const key = thirteenFFilingCacheKey(cik, filing), hit = local.get(key);
      if (valid13FFiling(hit?.value, cik, filing, now())) return hit.value.report;
      if (hit) { localBytes -= hit.bytes; local.delete(key); }
      const row = await readRecord(THIRTEEN_F_FILING_TYPE, key, signal);
      if (!valid13FFiling(row?.payload, cik, filing, now())) {
        if (/^[a-f0-9]{64}$/.test(row?.rawSha256 || '')) {
          while (invalidFilingHashes.size >= 48) invalidFilingHashes.delete(invalidFilingHashes.keys().next().value);
          invalidFilingHashes.set(key, row.rawSha256);
        }
        return null;
      }
      remember(key, row.payload); return row.payload.report;
    },
    async writeFiling(cik, filing, report, signal) {
      const key = thirteenFFilingCacheKey(cik, filing);
      const value = { schemaVersion: THIRTEEN_F_CACHE_VERSION, cik, key, observedAt: new Date(now()).toISOString(), report };
      if (!valid13FFiling(value, cik, filing, now())) return false;
      remember(key, value);
      if (!enabled() || signal?.aborted) return false;
      try { return (await write(THIRTEEN_F_FILING_TYPE, key, value, 30 * 86400,
        { ...options(signal), ifHash: invalidFilingHashes.get(key) || 'absent' }))?.stored === true; } catch { return false; }
    },
  };
}
