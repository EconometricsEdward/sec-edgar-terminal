import { CFTC_FAMILIES, CFTC_REPORT_BASIS, cftcDate, isCftcContractCode, isCftcFamily, parseCftcNumber } from './cftc.js';

export const CFTC_CONCENTRATION_SCHEMA_VERSION = 'edgar.cftc-concentration.v1';
export const CFTC_CONCENTRATION_DEFINITIONS_URL = 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/ExplanatoryNotes/index.htm';

// Verified against /api/views/gpe5-46if.json and /api/views/72hh-3qpy.json.
// Both families use these exact All-maturities fields. Disaggregated _1/_2
// fields mean Old/Other crop years; the net fields offset each trader first.
export const CFTC_CONCENTRATION_FIELDS = Object.freeze({
  top4Long: 'conc_gross_le_4_tdr_long',
  top4Short: 'conc_gross_le_4_tdr_short',
  top8Long: 'conc_gross_le_8_tdr_long',
  top8Short: 'conc_gross_le_8_tdr_short',
});
const SOURCE_FIELDS = Object.freeze([
  'id', 'market_and_exchange_names', 'report_date_as_yyyy_mm_dd',
  'cftc_contract_market_code', 'cftc_market_code', 'contract_units',
  'futonly_or_combined', 'open_interest_all', ...Object.values(CFTC_CONCENTRATION_FIELDS),
]);

function sourceError(message) {
  return Object.assign(new Error(message), { code: 'CFTC_CONCENTRATION_INVALID', status: 502 });
}

export function cftcConcentrationQuery({ family, code, reportDate }) {
  if (!isCftcFamily(family) || !isCftcContractCode(code) || cftcDate(reportDate) !== reportDate) throw sourceError('Invalid CFTC concentration identity.');
  return {
    '$select': SOURCE_FIELDS.join(','),
    '$where': `futonly_or_combined='FutOnly' AND cftc_contract_market_code='${code}' AND report_date_as_yyyy_mm_dd='${reportDate}T00:00:00.000'`,
    '$order': 'id ASC',
    '$limit': 3,
  };
}

export function cftcConcentrationSourceUrl(options) {
  const query = cftcConcentrationQuery(options), url = new URL(CFTC_FAMILIES[options.family].sourceUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url.toString();
}

function sourceText(value) {
  return typeof value === 'string' && value.trim() && value.length <= 300 && !/[\x00-\x1f]/.test(value) ? value.trim() : null;
}

function captureRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw sourceError('The CFTC concentration row is invalid.');
  return Object.fromEntries(SOURCE_FIELDS.map(field => {
    const value = row[field] ?? null;
    if (value !== null && !(typeof value === 'string' && value.length <= 300) && !(typeof value === 'number' && Number.isFinite(value))) throw sourceError('The CFTC concentration field is invalid.');
    return [field, value];
  }));
}

/** Published percentages, never inferred from a selected trader group's positions.
 * Each side uses total OI. Top four are included in top eight; long/short lists
 * can overlap. A published 0.0 is retained (CFTC rounds percentages below .05).
 */
export function buildCftcConcentration({ family, code, reportDate, rows, retrievedAt }) {
  const url = cftcConcentrationSourceUrl({ family, code, reportDate });
  if (!Array.isArray(rows) || rows.length >= 3) throw sourceError('The CFTC concentration selection is ambiguous or incomplete.');
  if (!Number.isFinite(Date.parse(retrievedAt)) || reportDate > String(retrievedAt).slice(0, 10)) throw sourceError('The CFTC concentration retrieval date is invalid.');
  const captured = rows.map(captureRow), raw = captured[0] || null;
  if (captured.some(row => JSON.stringify(row) !== JSON.stringify(raw))) throw sourceError('Conflicting CFTC concentration rows were returned.');

  let contract = null;
  if (raw) {
    const date = cftcDate(raw.report_date_as_yyyy_mm_dd);
    if (raw.futonly_or_combined !== 'FutOnly' || sourceText(raw.cftc_contract_market_code) !== code || date !== reportDate || ![date, `${date}T00:00:00.000`].includes(raw.report_date_as_yyyy_mm_dd)) throw sourceError('The CFTC concentration row does not match the requested report.');
    const sourceRowId = sourceText(raw.id), marketName = sourceText(raw.market_and_exchange_names), venueCode = sourceText(raw.cftc_market_code), units = sourceText(raw.contract_units);
    if (!sourceRowId || !marketName || !venueCode || !units) throw sourceError('The CFTC concentration market identity is incomplete.');
    const parsedOi = parseCftcNumber(raw.open_interest_all).value;
    const openInterest = Number.isSafeInteger(parsedOi) && parsedOi > 0 ? parsedOi : null;
    contract = { code, marketName, venueCode, units, openInterest, sourceRowId };
  }

  const unavailable = {}, values = {};
  for (const [key, field] of Object.entries(CFTC_CONCENTRATION_FIELDS)) {
    const parsed = parseCftcNumber(raw?.[field]);
    const reason = parsed.reason || (parsed.value < 0 || parsed.value > 100 ? 'outside_percentage_range' : null) || (contract?.openInterest == null ? 'open_interest_unavailable' : null);
    values[key] = reason ? null : parsed.value;
    if (reason) unavailable[field] = reason;
  }
  for (const side of ['Long', 'Short']) {
    const four = `top4${side}`, eight = `top8${side}`;
    if (values[four] !== null && values[eight] !== null && values[four] > values[eight]) {
      values[four] = null; values[eight] = null;
      unavailable[CFTC_CONCENTRATION_FIELDS[four]] = 'top_four_exceeds_top_eight';
      unavailable[CFTC_CONCENTRATION_FIELDS[eight]] = 'top_four_exceeds_top_eight';
    }
  }
  const available = Object.values(values).filter(value => value !== null).length;
  return {
    schema_version: CFTC_CONCENTRATION_SCHEMA_VERSION,
    status: available === 4 ? 'ready' : available ? 'partial' : 'unavailable',
    report_family: family, report_basis: CFTC_REPORT_BASIS, report_date: reportDate,
    contract,
    concentration: {
      basis: 'gross', population: 'all_reportable_traders', denominator: 'total_open_interest',
      top4: { longPct: values.top4Long, shortPct: values.top4Short },
      top8: { longPct: values.top8Long, shortPct: values.top8Short }, unavailable,
    },
    retrieved_at: retrievedAt,
    source: {
      publisher: 'CFTC', datasetId: CFTC_FAMILIES[family].datasetId, url,
      documentationUrl: CFTC_FAMILIES[family].documentationUrl,
      definitionsUrl: CFTC_CONCENTRATION_DEFINITIONS_URL,
      fields: { ...CFTC_CONCENTRATION_FIELDS }, raw,
    },
  };
}

/** Reject mismatched optional detail, including a valid row from another market.
 * Rebuild from captured source fields before accepting displayed percentages.
 */
export function cftcConcentrationMatchesHistory(response, selected) {
  try {
    if (!response || !selected || selected.reportBasis !== CFTC_REPORT_BASIS || response.report_family !== selected.family || response.report_basis !== selected.reportBasis || response.report_date !== selected.reportDate) return false;
    if (Date.parse(response.retrieved_at) > Date.now() + 60_000 || !['source', 'memory'].includes(response.freshness?.cache_status) || response.freshness?.retrieved_at !== response.retrieved_at) return false;
    const expected = buildCftcConcentration({ family: selected.family, code: selected.code, reportDate: selected.reportDate, rows: response.source?.raw ? [response.source.raw] : [], retrievedAt: response.retrieved_at });
    const same = (a, b) => {
      if (a === b) return true;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
      return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
    };
    if (!Object.keys(expected).every(key => same(response[key], expected[key]))) return false;
    return response.contract === null || ['code', 'venueCode', 'units', 'openInterest'].every(key => response.contract[key] === selected[key]);
  } catch { return false; }
}
