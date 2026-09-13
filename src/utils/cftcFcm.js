import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';

export const CFTC_FCM_SCHEMA_VERSION = 'edgar.cftc-fcm.v1';
export const CFTC_FCM_INDEX_URL = 'https://www.cftc.gov/MarketReports/financialfcmdata/index.htm';
export const CFTC_FCM_DEFINITIONS_URL = 'https://www.cftc.gov/MarketReports/financialfcmdata/DescriptionofReportDataFields/index.htm';
export const CFTC_FCM_MAX_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export class CftcFcmError extends Error {
  constructor(message, { code = 'CFTC_FCM_SOURCE_INVALID', status = 502 } = {}) {
    super(message); this.name = 'CftcFcmError'; this.code = code; this.status = status;
  }
}

function invalid(message) { throw new CftcFcmError(message); }
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const header = value => clean(value).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function decodeXml(text) {
  return String(text).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) invalid('The CFTC workbook contains an invalid XML character.');
      return String.fromCodePoint(value);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[entity.toLowerCase()];
  });
}

function attribute(text, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(text);
  return match ? decodeXml(match[2]) : null;
}

export function fcmIsoDate(value) {
  const text = clean(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!iso && !us) return null;
  const [year, month, day] = iso ? iso.slice(1).map(Number) : [Number(us[3]), Number(us[1]), Number(us[2])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2199 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function isOfficialFcmUrl(value, { workbook = false } = {}) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.cftc.gov' && !url.port && !url.username && !url.password && !url.search && !url.hash
      && (workbook ? url.pathname.startsWith('/sites/default/files/') && /\.xlsx$/i.test(url.pathname) : url.href === CFTC_FCM_INDEX_URL);
  } catch { return false; }
}

/** Discover only report links actually published in the official monthly index. */
export function discoverFcmReports(html, now = new Date()) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > CFTC_FCM_MAX_BYTES) invalid('The CFTC FCM index exceeded the size limit.');
  const today = new Date(now).toISOString().slice(0, 10), reports = new Map();
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const row = match[1], text = clean(decodeXml(row.replace(/<[^>]+>/g, ' ')));
    const date = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})[, .]+(20\\d{2})\\b`, 'i').exec(text);
    if (!date) continue;
    const month = MONTHS.findIndex(item => item.toLowerCase() === date[1].toLowerCase()) + 1;
    const reportDate = fcmIsoDate(`${date[3]}-${String(month).padStart(2, '0')}-${date[2].padStart(2, '0')}`);
    if (!reportDate || reportDate > today || new Date(`${reportDate}T00:00:00Z`).getUTCDate() !== new Date(Date.UTC(Number(date[3]), month, 0)).getUTCDate()) continue;
    for (const link of row.matchAll(/<a\b([^>]*)>/gi)) {
      const href = attribute(link[1], 'href');
      if (!href) continue;
      let url;
      try { url = new URL(href, CFTC_FCM_INDEX_URL).href; } catch { continue; }
      if (!isOfficialFcmUrl(url, { workbook: true })) continue;
      if (reports.has(reportDate) && reports.get(reportDate).url !== url) invalid('The CFTC index contains conflicting files for one report month.');
      reports.set(reportDate, { reportDate, url });
    }
  }
  const sorted = [...reports.values()].sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  if (sorted.length < 2) invalid('Two official monthly CFTC FCM Excel reports could not be verified.');
  return sorted.slice(0, 2);
}

/** The published workbook is in whole US dollars. Blank is unavailable; zero is zero. */
export function fcmDollarValue(value) {
  if (value == null || clean(value) === '' || /^(?:n\/a|na|—|–|-)$/i.test(clean(value))) return null;
  const text = clean(value).replace(/^\((.*)\)$/, '-$1').replace(/[$,\s]/g, '');
  if (!/^[+-]?\d+(?:\.0+)?$/.test(text) || !Number.isSafeInteger(Number(text))) invalid('A CFTC FCM financial value is not an exact whole-dollar amount.');
  return Number(text);
}

export function fcmEntityId(legalName) {
  // No registry identifier is present in these CFTC files. Preserve punctuation
  // and suffixes: only letter case and whitespace are normalized for comparison.
  return `fcm-${createHash('sha256').update(clean(legalName).toUpperCase()).digest('hex').slice(0, 24)}`;
}

const FIELDS = {
  legalName: 'Futures Commission Merchant / Retail Foreign Exchange Dealer',
  registration: 'Registered As', dsro: 'DSRO', reportDate: 'As of Date',
  adjustedNetCapital: 'Adjusted Net Capital', netCapitalRequirement: 'Net Capital Requirement', excessNetCapital: 'Excess Net Capital',
  customerAssetsInSegregation: "Customers' Assets in Seg", customerSegregationRequired: "Customers' Seg Required 4d(a)(2)",
  customerSegregationExcess: 'Excess/Deficient Funds in Seg', targetResidualInterest: 'Target Residual Interest in Seg',
  part30Assets: 'Funds in Separate Section 30.7 Accounts', part30Required: 'Customer Amount Pt. 30 Required',
  part30Excess: 'Excess/Deficient Funds in Separate Section 30.7 Accounts',
  clearedSwapsAssets: 'Funds in Separate Cleared Swap Segregation', clearedSwapsRequired: 'Customer Amount Cleared Swap Seg Required',
  clearedSwapsExcess: 'Excess/Deficient Funds in Cleared Swap Seg Accounts', retailForexObligation: 'Total Amount of Retail Forex Obligation',
};
export const CFTC_FCM_NUMERIC_FIELDS = Object.keys(FIELDS).filter(key => !['legalName', 'registration', 'dsro', 'reportDate'].includes(key));

/** Recompute financial annotations from source values for both ingestion and cache validation. */
export function deriveFcmFinancials(firm) {
  const validationNotes = [];
  if (firm.adjustedNetCapital != null && firm.netCapitalRequirement != null && firm.excessNetCapital != null && Math.abs(firm.adjustedNetCapital - firm.netCapitalRequirement - firm.excessNetCapital) > 1) validationNotes.push('Published excess capital does not reconcile to adjusted capital less the requirement.');
  if (firm.reportDate !== firm.sourceReportDate) validationNotes.push('This entity has an older as-of date than the source report month.');
  return {
    capitalCoverage: firm.adjustedNetCapital != null && firm.netCapitalRequirement > 0 ? firm.adjustedNetCapital / firm.netCapitalRequirement : null,
    unavailableFields: CFTC_FCM_NUMERIC_FIELDS.filter(key => firm[key] == null),
    validationNotes,
  };
}

function readWorkbook(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CFTC_FCM_MAX_BYTES) invalid('The CFTC FCM workbook exceeded the size limit.');
  let expanded = 0, entries = 0, parts;
  try {
    parts = unzipSync(bytes, { filter(file) {
      expanded += file.originalSize; entries += 1;
      if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0 || expanded > MAX_EXPANDED_BYTES || entries > 100 || /(^|\/)\.\.(\/|$)|\\/.test(file.name)) invalid('The CFTC FCM workbook archive exceeds the allowed bounds.');
      return /^(?:xl\/(?:workbook\.xml|sharedStrings\.xml|worksheets\/sheet\d+\.xml))$/.test(file.name);
    } });
  } catch (error) { if (error instanceof CftcFcmError) throw error; invalid('The CFTC FCM source was not a valid XLSX workbook.'); }
  const xml = {};
  for (const [name, value] of Object.entries(parts)) {
    if (value.length > MAX_EXPANDED_BYTES) invalid('The CFTC FCM workbook XML exceeds the size limit.');
    const text = strFromU8(value);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) invalid('The CFTC workbook contains unsupported XML declarations.');
    if (/\b(?:amounts?\s+in|dollars?\s+in|in)\s+(?:US\s+dollars?\s+)?(?:thousands|millions)\b/i.test(text)) invalid('The CFTC workbook monetary scale differs from the supported whole-dollar report.');
    xml[name] = text;
  }
  if (!xml['xl/workbook.xml']) invalid('The CFTC workbook metadata is missing.');
  const date1904 = /<workbookPr\b[^>]*\bdate1904=["'](?:1|true)["']/i.test(xml['xl/workbook.xml']);
  const strings = [...(xml['xl/sharedStrings.xml'] || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(part => decodeXml(part[1])).join(''));
  const sheets = [];
  for (const [name, text] of Object.entries(xml)) {
    if (!name.startsWith('xl/worksheets/')) continue;
    const rows = [];
    for (const match of text.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= 1200) invalid('The CFTC workbook exceeded the row limit.');
      const row = [], used = new Set();
      for (const cell of match[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const coordinate = /^([A-Z]{1,2})([1-9]\d{0,4})$/.exec(attribute(cell[1], 'r') || '');
        if (!coordinate) invalid('The CFTC workbook has an invalid cell coordinate.');
        const column = [...coordinate[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        if (column >= 60 || used.has(column)) invalid('The CFTC workbook has unsupported or duplicate columns.');
        used.add(column);
        const body = cell[2] || '', type = attribute(cell[1], 't');
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        let value = decodeXml(raw);
        if (type === 's') {
          if (!/^\d+$/.test(raw) || Number(raw) >= strings.length) invalid('The CFTC workbook has an invalid shared string.');
          value = strings[Number(raw)];
        } else if (type === 'inlineStr') value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(item => decodeXml(item[1])).join('');
        else if (type === 'e') value = null;
        row[column] = value;
      }
      rows.push({ cells: row, rowNumber: Number(attribute(match[1], 'r')) });
    }
    sheets.push({ name, rows });
  }
  return { sheets, date1904 };
}

function rowDate(value, date1904) {
  const plain = fcmIsoDate(value);
  if (plain) return plain;
  if (!/^\d+$/.test(clean(value))) return null;
  const serial = Number(value);
  if (serial < 36526 || serial > 100000) return null;
  return fcmIsoDate(new Date((date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + serial * 86400_000).toISOString().slice(0, 10));
}

/** Parse headers by meaning, never by hard-coded column offsets or displayed scale. */
export function parseFcmWorkbook(bytes, { reportDate, url }) {
  if (fcmIsoDate(reportDate) !== reportDate || !isOfficialFcmUrl(url, { workbook: true })) invalid('Invalid CFTC FCM source provenance.');
  const { sheets, date1904 } = readWorkbook(bytes), candidates = [];
  for (const sheet of sheets) {
    const index = sheet.rows.findIndex(row => row.cells.some(value => header(value) === header(FIELDS.adjustedNetCapital)) && row.cells.some(value => header(value) === header(FIELDS.legalName)));
    if (index >= 0) candidates.push({ ...sheet, index });
  }
  if (candidates.length !== 1) invalid('A single CFTC FCM financial-data worksheet could not be verified.');
  const sheet = candidates[0], headers = sheet.rows[sheet.index].cells.map(header), columns = {};
  for (const [key, label] of Object.entries(FIELDS)) {
    const matches = headers.flatMap((value, index) => value === header(label) ? [index] : []);
    if (matches.length !== 1) invalid(`The CFTC FCM column could not be verified: ${label}.`);
    columns[key] = matches[0];
  }
  const firms = [], identities = new Set();
  for (const { cells, rowNumber } of sheet.rows.slice(sheet.index + 1)) {
    const legalName = clean(cells[columns.legalName]), registration = clean(cells[columns.registration]);
    if (!/\b(?:FCM|RFED|FCMRFD)\b/.test(registration)) continue; // Footnotes and totals are not entities.
    if (!legalName || legalName.length > 180 || /[\x00-\x1f]/.test(legalName)) invalid('The CFTC FCM legal entity name is invalid.');
    const asOf = rowDate(cells[columns.reportDate], date1904);
    if (!asOf || asOf > reportDate) invalid(`The CFTC as-of date could not be verified for ${legalName}.`);
    const id = fcmEntityId(legalName);
    if (identities.has(id)) invalid('The CFTC FCM workbook contains duplicate legal entity identities.');
    identities.add(id);
    const firm = { id, legalName, nfaId: null, identityBasis: 'published-legal-name', registration, dsro: clean(cells[columns.dsro]), reportDate: asOf, sourceReportDate: reportDate, sourceUrl: url, sourceRow: rowNumber, units: 'USD' };
    for (const key of CFTC_FCM_NUMERIC_FIELDS) firm[key] = fcmDollarValue(cells[columns[key]]);
    if (firm.netCapitalRequirement != null && firm.netCapitalRequirement < 0) invalid('The CFTC FCM net-capital requirement is negative.');
    Object.assign(firm, deriveFcmFinancials(firm));
    firms.push(firm);
  }
  if (!firms.length || firms.length > 500 || !firms.some(firm => firm.adjustedNetCapital != null && firm.netCapitalRequirement != null)) invalid('The CFTC FCM workbook contained no verifiable financial rows.');
  return { reportDate, url, firms: firms.sort((a, b) => a.legalName.localeCompare(b.legalName)) };
}

const difference = (current, prior) => current != null && prior != null ? current - prior : null;

export function buildFcmSnapshot(current, previous, retrievedAt = new Date().toISOString()) {
  if (previous.reportDate >= current.reportDate) invalid('CFTC FCM comparison dates are not in chronological order.');
  const prior = new Map(previous.firms.map(firm => [firm.id, firm]));
  const previousMonth = new Date(`${current.reportDate}T00:00:00Z`); previousMonth.setUTCDate(0);
  const consecutiveMonths = previousMonth.toISOString().slice(0, 10) === previous.reportDate;
  const firms = current.firms.map(firm => {
    const match = prior.get(firm.id);
    const comparable = consecutiveMonths && match && firm.reportDate === current.reportDate && match.reportDate === previous.reportDate && !firm.validationNotes.length && !match.validationNotes.length;
    return {
      ...firm, previous: comparable ? match : null,
      comparisonStatus: comparable ? 'matched-legal-name' : 'no-comparable-prior-row',
      changes: comparable ? {
        ...Object.fromEntries([...CFTC_FCM_NUMERIC_FIELDS, 'capitalCoverage'].map(key => [key, difference(firm[key], match[key])])),
        excessNetCapitalPct: firm.excessNetCapital != null && match.excessNetCapital > 0 ? (firm.excessNetCapital - match.excessNetCapital) / match.excessNetCapital * 100 : null,
      } : null,
    };
  });
  const warnings = [];
  if (!consecutiveMonths) warnings.push('The two latest published reports are not consecutive months. Monthly changes are unavailable.');
  if (firms.some(firm => firm.comparisonStatus !== 'matched-legal-name')) warnings.push('Monthly comparisons are unavailable for some entities because the same legal name and consecutive as-of dates could not be verified, or a published capital reconciliation needs review.');
  return {
    schema_version: CFTC_FCM_SCHEMA_VERSION, status: 'ready', reportDate: current.reportDate, previousReportDate: previous.reportDate, retrievedAt, units: 'USD',
    source: { publisher: 'CFTC', indexUrl: CFTC_FCM_INDEX_URL, definitionsUrl: CFTC_FCM_DEFINITIONS_URL, reports: [current, previous].map(({ reportDate, url }) => ({ reportDate, url })) },
    methodology: {
      identity: 'Published legal names, normalized only for whitespace and case; no NFA ID is supplied in these files. Name changes and parent companies are not automatically linked.',
      capitalCoverage: 'Adjusted net capital / net capital requirement. Unavailable when the requirement is zero or either amount is missing.',
      excessNetCapitalPct: '100 × (current excess net capital − prior excess net capital) / prior excess net capital; unavailable for a nonpositive prior amount.',
      customerFunds: 'Customer segregation requirements and segregated assets are customer-protection amounts, not the firm’s own liquidity or freely available capital.',
      publication: 'Monthly financial reports are published with a lag. The CFTC states that posted figures are not revised for subsequently received amendments.',
      dates: 'reportDate on each entity is its published as-of date; the top-level reportDate is the monthly source report. Retrieval time is not publication time.',
    },
    notes: ['FCM and retail forex dealer legal entities are separate from their consolidated parent companies.', 'Customer segregated assets and requirements are customer-protection balances, not the firm’s own available liquidity.', 'CFTC monthly reports have a publication lag and are not revised for subsequently received amendments.'],
    warnings, firms,
  };
}
