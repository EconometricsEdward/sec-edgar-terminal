/**
 * Pure normalization and calculation utilities for the two CFTC COT
 * futures-only datasets used by EDGAR Terminal. No network or cache access
 * belongs in this module so every interpretation can be fixture-tested.
 */

export const CFTC_SCHEMA_VERSION = 'edgar.cftc-positioning.v1';
export const CFTC_CALCULATION_VERSION = 'cftc-positioning-1.0.0';
export const CFTC_REPORT_BASIS = 'futures_only';
export const CFTC_HISTORY_WINDOWS = { '1y': 52, '3y': 156, '5y': 260 };

const COMMON_FIELDS = [
  'id', 'market_and_exchange_names', 'report_date_as_yyyy_mm_dd',
  'contract_market_name', 'cftc_contract_market_code', 'cftc_market_code',
  'cftc_region_code', 'cftc_commodity_code', 'commodity_name',
  'open_interest_all', 'contract_units', 'cftc_subgroup_code', 'commodity',
  'commodity_subgroup_name', 'commodity_group_name', 'futonly_or_combined',
];

export const CFTC_FAMILIES = {
  tff: {
    id: 'tff',
    label: 'Traders in Financial Futures',
    shortLabel: 'TFF',
    datasetId: 'gpe5-46if',
    sourceUrl: 'https://publicreporting.cftc.gov/resource/gpe5-46if.json',
    documentationUrl: 'https://dev.socrata.com/foundry/publicreporting.cftc.gov/gpe5-46if',
    groups: [
      { id: 'dealer', label: 'Dealer/Intermediary', long: 'dealer_positions_long_all', short: 'dealer_positions_short_all', spread: 'dealer_positions_spread_all' },
      { id: 'asset-manager', label: 'Asset Manager/Institutional', long: 'asset_mgr_positions_long', short: 'asset_mgr_positions_short', spread: 'asset_mgr_positions_spread' },
      { id: 'leveraged-funds', label: 'Leveraged Funds', long: 'lev_money_positions_long', short: 'lev_money_positions_short', spread: 'lev_money_positions_spread' },
      { id: 'other-reportables', label: 'Other Reportables', long: 'other_rept_positions_long', short: 'other_rept_positions_short', spread: 'other_rept_positions_spread' },
      { id: 'non-reportables', label: 'Non-reportables', long: 'nonrept_positions_long_all', short: 'nonrept_positions_short_all', spread: null },
    ],
  },
  disaggregated: {
    id: 'disaggregated',
    label: 'Disaggregated',
    shortLabel: 'Disaggregated',
    datasetId: '72hh-3qpy',
    sourceUrl: 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json',
    documentationUrl: 'https://dev.socrata.com/foundry/publicreporting.cftc.gov/72hh-3qpy',
    groups: [
      { id: 'producer-merchant', label: 'Producer/Merchant/Processor/User', long: 'prod_merc_positions_long', short: 'prod_merc_positions_short', spread: null },
      { id: 'swap-dealers', label: 'Swap Dealers', long: 'swap_positions_long_all', short: 'swap__positions_short_all', spread: 'swap__positions_spread_all' },
      { id: 'managed-money', label: 'Managed Money', long: 'm_money_positions_long_all', short: 'm_money_positions_short_all', spread: 'm_money_positions_spread' },
      { id: 'other-reportables', label: 'Other Reportables', long: 'other_rept_positions_long', short: 'other_rept_positions_short', spread: 'other_rept_positions_spread' },
      { id: 'non-reportables', label: 'Non-reportables', long: 'nonrept_positions_long_all', short: 'nonrept_positions_short_all', spread: null },
    ],
  },
};

for (const family of Object.values(CFTC_FAMILIES)) {
  family.fields = [...COMMON_FIELDS, ...new Set(family.groups.flatMap(group => [group.long, group.short, group.spread].filter(Boolean)))];
}

export const CFTC_LAUNCH_CATALOG = [
  { family: 'tff', code: '13874A', category: 'equity-indices', label: 'E-mini S&P 500' },
  { family: 'tff', code: '209742', category: 'equity-indices', label: 'Nasdaq-100 E-mini' },
  { family: 'tff', code: '239742', category: 'equity-indices', label: 'Russell 2000 E-mini' },
  { family: 'tff', code: '043602', category: 'rates', label: 'U.S. Treasury 10-Year Note' },
  { family: 'tff', code: '042601', category: 'rates', label: 'U.S. Treasury 2-Year Note' },
  { family: 'tff', code: '020601', category: 'rates', label: 'U.S. Treasury Bond' },
  { family: 'tff', code: '134741', category: 'rates', label: 'Three-Month SOFR' },
  { family: 'tff', code: '099741', category: 'currencies', label: 'Euro FX' },
  { family: 'tff', code: '097741', category: 'currencies', label: 'Japanese Yen' },
  { family: 'tff', code: '096742', category: 'currencies', label: 'British Pound' },
  { family: 'tff', code: '1170E1', category: 'other', label: 'VIX Futures' },
  { family: 'tff', code: '133741', category: 'other', label: 'Bitcoin Futures' },
  { family: 'tff', code: '146021', category: 'other', label: 'Ether Futures' },
  { family: 'disaggregated', code: '067651', category: 'energy', label: 'WTI Physical Crude Oil' },
  { family: 'disaggregated', code: '023651', category: 'energy', label: 'NYMEX Natural Gas' },
  { family: 'disaggregated', code: '088691', category: 'metals', label: 'Gold' },
  { family: 'disaggregated', code: '084691', category: 'metals', label: 'Silver' },
  { family: 'disaggregated', code: '085692', category: 'metals', label: 'Copper No. 1' },
  { family: 'disaggregated', code: '002602', category: 'agriculture', label: 'Corn' },
  { family: 'disaggregated', code: '001602', category: 'agriculture', label: 'Wheat SRW' },
  { family: 'disaggregated', code: '005602', category: 'agriculture', label: 'Soybeans' },
  { family: 'disaggregated', code: '057642', category: 'agriculture', label: 'Live Cattle' },
  { family: 'disaggregated', code: '083731', category: 'agriculture', label: 'Coffee C' },
  { family: 'disaggregated', code: '073732', category: 'agriculture', label: 'Cocoa' },
  { family: 'disaggregated', code: '033661', category: 'agriculture', label: 'Cotton No. 2' },
];

export const CFTC_CATEGORY_LABELS = {
  'equity-indices': 'Equity indices', rates: 'Rates', currencies: 'Currencies',
  energy: 'Energy', metals: 'Metals', agriculture: 'Agriculture', other: 'Other',
};

const CFTC_VERIFIED_CATEGORY_CODES = Object.freeze({
  'tff|124603': 'equity-indices',
  'tff|124608': 'equity-indices',
  'tff|13874U': 'equity-indices',
  'tff|209747': 'equity-indices',
  'tff|098662': 'currencies',
});

export function isCftcFamily(value) { return Object.hasOwn(CFTC_FAMILIES, value); }
export function cftcGroup(family, id) { return CFTC_FAMILIES[family]?.groups.find(group => group.id === id) || null; }
export function isCftcContractCode(value) { return typeof value === 'string' && /^[A-Z0-9+]{3,12}$/.test(value); }

export function parseCftcNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { value, reason: null } : { value: null, reason: 'nonfinite' };
  if (value == null) return { value: null, reason: 'absent' };
  const text = String(value).trim();
  if (!text) return { value: null, reason: 'blank' };
  if (text === '.' || text === '·' || /^suppressed$/i.test(text)) return { value: null, reason: 'suppressed' };
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return { value: null, reason: 'nonnumeric' };
  const parsed = Number(text);
  return Number.isFinite(parsed) ? { value: parsed, reason: null } : { value: null, reason: 'nonfinite' };
}

export function cftcDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
}

export function cftcCategory(row, family) {
  const code = String(row.cftc_contract_market_code || '').trim().toUpperCase();
  const verified = CFTC_VERIFIED_CATEGORY_CODES[`${family}|${code}`];
  if (verified) return verified;
  const subgroup = `${row.commodity_subgroup_name || ''} ${row.commodity_group_name || ''}`.toUpperCase();
  if (/STOCK INDIC/.test(subgroup)) return 'equity-indices';
  if (/INTEREST RATE|TREASURY|SOFR/.test(subgroup)) return 'rates';
  if (/CURRENCY/.test(subgroup)) return 'currencies';
  if (/PETROLEUM|NATURAL GAS|ELECTRIC/.test(subgroup)) return 'energy';
  if (/METAL/.test(subgroup)) return 'metals';
  if (/AGRICULTURE/.test(subgroup)) return 'agriculture';
  return CFTC_LAUNCH_CATALOG.find(item => item.family === family && item.code === code)?.category
    || 'other';
}

function exchangeName(marketName) {
  const pieces = String(marketName || '').split(' - ');
  return pieces.length > 1 ? pieces.at(-1).trim() : 'Exchange not published';
}

function parsedField(raw, field, unavailable) {
  const result = parseCftcNumber(raw[field]);
  if (result.reason) unavailable[field] = result.reason;
  return result.value;
}

function sourceReportDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00\.000)?$/.exec(value);
  return match && cftcDate(match[1]) === match[1] ? match[1] : null;
}

export function normalizeCftcRow(raw, familyId) {
  const family = CFTC_FAMILIES[familyId];
  if (!family) return { ok: false, reason: 'unsupported_report_family', raw };
  const reportDate = sourceReportDate(raw?.report_date_as_yyyy_mm_dd);
  const code = typeof raw?.cftc_contract_market_code === 'string' ? raw.cftc_contract_market_code.trim().toUpperCase() : '';
  if (!reportDate) return { ok: false, reason: 'invalid_report_date', raw };
  if (!isCftcContractCode(code)) return { ok: false, reason: 'invalid_contract_code', raw };
  if (raw?.futonly_or_combined !== 'FutOnly') return { ok: false, reason: 'not_futures_only', raw };
  const unavailable = {};
  const openInterest = parsedField(raw, 'open_interest_all', unavailable);
  if (openInterest != null && openInterest < 0) return { ok: false, reason: 'negative_open_interest', raw };
  const groups = {};
  for (const definition of family.groups) {
    const long = parsedField(raw, definition.long, unavailable);
    const short = parsedField(raw, definition.short, unavailable);
    const spreading = definition.spread ? parsedField(raw, definition.spread, unavailable) : null;
    if ([long, short, spreading].some(value => value != null && value < 0)) return { ok: false, reason: 'negative_position', raw };
    groups[definition.id] = {
      id: definition.id, label: definition.label, long, short, spreading,
      spreadingStatus: definition.spread ? (spreading == null ? 'unavailable' : 'reported') : 'not_applicable',
      net: long != null && short != null ? long - short : null,
      netPctOi: long != null && short != null && openInterest > 0 ? 100 * (long - short) / openInterest : null,
      rawFields: { long: definition.long, short: definition.short, spreading: definition.spread },
    };
  }
  const longReconciled = family.groups.reduce((sum, definition) => {
    const group = groups[definition.id];
    return sum + (group.long ?? 0) + (definition.spread ? group.spreading ?? 0 : 0);
  }, 0);
  const shortReconciled = family.groups.reduce((sum, definition) => {
    const group = groups[definition.id];
    return sum + (group.short ?? 0) + (definition.spread ? group.spreading ?? 0 : 0);
  }, 0);
  const reconciliationAvailable = openInterest != null && family.groups.every(definition => {
    const group = groups[definition.id];
    return group.long != null && group.short != null && (!definition.spread || group.spreading != null);
  });
  const marketName = String(raw.market_and_exchange_names || '').trim();
  const category = cftcCategory(raw, familyId);
  const longDifference = reconciliationAvailable ? longReconciled - openInterest : null;
  const shortDifference = reconciliationAvailable ? shortReconciled - openInterest : null;
  return { ok: true, value: {
    identity: `${familyId}|${CFTC_REPORT_BASIS}|${code}|${reportDate}`,
    family: familyId, reportBasis: CFTC_REPORT_BASIS, reportDate, code,
    sourceRowId: typeof raw.id === 'string' ? raw.id : null,
    venueCode: String(raw.cftc_market_code || '').trim() || null,
    marketName, contractName: String(raw.contract_market_name || '').trim(),
    exchange: exchangeName(marketName), commodity: String(raw.commodity_name || raw.commodity || '').trim(),
    category, categoryLabel: CFTC_CATEGORY_LABELS[category], units: String(raw.contract_units || '').trim() || null,
    openInterest, groups, unavailable,
    reconciliation: { available: reconciliationAvailable, status: !reconciliationAvailable ? 'unavailable' : longDifference === 0 && shortDifference === 0 ? 'ok' : 'mismatch', tolerance: 0, longTotal: reconciliationAvailable ? longReconciled : null, shortTotal: reconciliationAvailable ? shortReconciled : null, longDifference, shortDifference },
    raw: Object.fromEntries(family.fields.map(field => [field, raw[field] ?? null])),
  } };
}

function stableObservation(value) {
  const raw = { ...value.raw };
  delete raw.id;
  return JSON.stringify({ ...value, sourceRowId: null, raw });
}

export function normalizeCftcRows(rawRows, family) {
  const quarantine = [], byIdentity = new Map(), conflicts = new Set();
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const normalized = normalizeCftcRow(raw, family);
    if (!normalized.ok) { quarantine.push({ reason: normalized.reason, sourceRowId: raw?.id ?? null }); continue; }
    if (conflicts.has(normalized.value.identity)) { quarantine.push({ reason: 'conflicting_duplicate_identity', identity: normalized.value.identity, sourceRowIds: [normalized.value.sourceRowId] }); continue; }
    const prior = byIdentity.get(normalized.value.identity);
    if (prior) {
      if (stableObservation(prior) !== stableObservation(normalized.value)) {
        quarantine.push({ reason: 'conflicting_duplicate_identity', identity: normalized.value.identity, sourceRowIds: [prior.sourceRowId, normalized.value.sourceRowId] });
        byIdentity.delete(normalized.value.identity); conflicts.add(normalized.value.identity);
      }
      continue;
    }
    byIdentity.set(normalized.value.identity, normalized.value);
  }
  const rows = [...byIdentity.values()];
  rows.sort((a, b) => a.code.localeCompare(b.code) || b.reportDate.localeCompare(a.reportDate));
  return { rows, quarantine };
}

export function dayDifference(later, earlier) {
  const a = Date.parse(`${later}T00:00:00.000Z`), b = Date.parse(`${earlier}T00:00:00.000Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 86400000) : null;
}

export function cftcPercentile(current, priorValues, required) {
  const values = priorValues.filter(Number.isFinite);
  if (!Number.isFinite(current)) return { value: null, reason: 'current_unavailable', observations: Math.min(values.length, required), required };
  if (values.length < required) return { value: null, reason: 'insufficient_history', observations: values.length, required };
  const sample = values.slice(0, required);
  const below = sample.filter(value => value < current).length;
  const equal = sample.filter(value => value === current).length;
  return { value: 100 * (below + 0.5 * equal) / required, reason: null, observations: required, required };
}

function seriesPercentile(current, priorRows, required, metric) {
  const validPriorRows = priorRows.filter(row => Number.isFinite(metric(row)));
  const comparison = validPriorRows.slice(0, required);
  return {
    ...cftcPercentile(current, validPriorRows.map(metric), required),
    comparisonRange: {
      observations: comparison.length,
      earliest: comparison.at(-1)?.reportDate ?? null,
      latest: comparison[0]?.reportDate ?? null,
    },
  };
}

function findExactDate(rows, selectedDate, days) {
  const target = new Date(`${selectedDate}T00:00:00.000Z`);
  target.setUTCDate(target.getUTCDate() - days);
  return rows.find(row => row.reportDate === target.toISOString().slice(0, 10)) || null;
}

function historyPointProvenance(row, groupId) {
  if (!row?.raw) return { sourceRowId: row?.sourceRowId ?? null, unavailable: row?.unavailable ?? {}, raw: null };
  const rawFields = row.groups?.[groupId]?.rawFields || {};
  const fields = ['id', 'market_and_exchange_names', 'contract_market_name', 'report_date_as_yyyy_mm_dd', 'cftc_contract_market_code', 'cftc_market_code', 'contract_units', 'futonly_or_combined', 'open_interest_all', rawFields.long, rawFields.short, rawFields.spreading].filter(Boolean);
  const raw = Object.fromEntries(fields.map(field => [field, row.raw[field] ?? null]));
  const numericFields = ['open_interest_all', rawFields.long, rawFields.short, rawFields.spreading].filter(Boolean);
  const unavailable = Object.fromEntries(numericFields.filter(field => row.unavailable?.[field]).map(field => [field, row.unavailable[field]]));
  return { sourceRowId: row.sourceRowId ?? null, unavailable, raw };
}

function historyPointDerivedUnavailable(row, groupId) {
  const group = row?.groups?.[groupId], unavailable = {};
  if (group?.net == null) unavailable.net = 'long_or_short_unavailable';
  if (group?.netPctOi == null) unavailable.netPctOi = group?.net == null ? 'net_unavailable' : row?.openInterest == null ? 'open_interest_unavailable' : row.openInterest <= 0 ? 'open_interest_not_positive' : 'calculation_unavailable';
  return unavailable;
}

export function cftcSeries(rows, groupId, selectedDate = null, requestedLookback = 260) {
  const ordered = [...rows].sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  const selected = selectedDate ? ordered.find(row => row.reportDate === selectedDate) : ordered[0];
  if (!selected) return { selected: null, points: [], percentile: { value: null, reason: 'observation_unavailable', observations: 0, required: requestedLookback }, shorterPercentiles: [] };
  const group = selected.groups[groupId];
  if (!group) return { selected: null, points: [], percentile: { value: null, reason: 'unsupported_trader_group', observations: 0, required: requestedLookback }, shorterPercentiles: [] };
  const atOrBefore = ordered.filter(row => row.reportDate <= selected.reportDate && row.code === selected.code && row.venueCode === selected.venueCode && row.units === selected.units);
  const prior = atOrBefore.filter(row => row.reportDate < selected.reportDate);
  const week = findExactDate(atOrBefore, selected.reportDate, 7);
  const fourWeeks = findExactDate(atOrBefore, selected.reportDate, 28);
  const metric = row => row?.groups[groupId]?.netPctOi;
  const net = row => row?.groups[groupId]?.net;
  const previous = prior.find(row => Number.isFinite(net(row))) || null;
  const percentile = seriesPercentile(group.netPctOi, prior, requestedLookback, metric);
  const shorterPercentiles = [52, 156, 260].filter(count => count < requestedLookback || percentile.value == null).map(count => seriesPercentile(group.netPctOi, prior, count, metric)).filter(item => item.value != null);
  let validPriors = 0, historyEnd = atOrBefore.length;
  for (let index = 1; index < atOrBefore.length; index += 1) {
    if (Number.isFinite(metric(atOrBefore[index]))) validPriors += 1;
    if (validPriors === requestedLookback) { historyEnd = index + 1; break; }
  }
  const points = atOrBefore.slice(0, historyEnd).reverse().map(row => ({
    reportDate: row.reportDate,
    ...historyPointProvenance(row, groupId),
    marketName: row.marketName,
    contractName: row.contractName,
    exchange: row.exchange,
    openInterest: row.openInterest,
    long: row.groups[groupId]?.long ?? null,
    short: row.groups[groupId]?.short ?? null,
    spreading: row.groups[groupId]?.spreading ?? null,
    spreadingStatus: row.groups[groupId]?.spreadingStatus ?? 'unavailable',
    net: net(row),
    netPctOi: metric(row),
    derivedUnavailable: historyPointDerivedUnavailable(row, groupId),
  }));
  return { selected: {
    ...selected, selectedGroup: group,
    oneWeekChange: week && net(selected) != null && net(week) != null ? net(selected) - net(week) : null,
    oneWeekNetPctChange: week && metric(selected) != null && metric(week) != null ? metric(selected) - metric(week) : null,
    fourWeekChange: fourWeeks && net(selected) != null && net(fourWeeks) != null ? net(selected) - net(fourWeeks) : null,
    fourWeekNetPctChange: fourWeeks && metric(selected) != null && metric(fourWeeks) != null ? metric(selected) - metric(fourWeeks) : null,
    previousAvailableChange: previous && net(selected) != null && net(previous) != null ? net(selected) - net(previous) : null,
    previousAvailableDate: previous?.reportDate ?? null,
    previousAvailableElapsedDays: previous ? dayDifference(selected.reportDate, previous.reportDate) : null,
  }, points, percentile, shorterPercentiles,
  historyRange: { observations: points.length, earliest: points[0]?.reportDate ?? null, latest: points.at(-1)?.reportDate ?? null, compatibility: { code: selected.code, venueCode: selected.venueCode, units: selected.units } } };
}

export function cftcCatalog(rows, family) {
  const launch = new Map(CFTC_LAUNCH_CATALOG.filter(item => item.family === family).map(item => [item.code, item]));
  return [...rows].sort((a, b) => (a.categoryLabel || '').localeCompare(b.categoryLabel || '') || a.marketName.localeCompare(b.marketName)).map(row => ({
    family, code: row.code, marketName: row.marketName, contractName: row.contractName,
    exchange: row.exchange, commodity: row.commodity, units: row.units,
    category: row.category, categoryLabel: row.categoryLabel,
    launch: launch.has(row.code), launchLabel: launch.get(row.code)?.label || null,
    reportDate: row.reportDate,
  }));
}

function safeCsv(value) {
  if (value == null) return '"Unavailable"';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value);
  const protectedText = /^[\u0000-\u0020\u007f-\u009f\ufeff]*[=+@-]/u.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

export function cftcCsv(response) {
  const group = response?.selection?.group || response?.group || '';
  const rows = Array.isArray(response?.history) ? response.history : Array.isArray(response?.latest) ? response.latest : [];
  const header = ['schema_version', 'calculation_version', 'report_family', 'report_basis', 'contract_code', 'market', 'contract_name', 'exchange', 'contract_units', 'trader_group', 'report_date', 'source_row_id', 'open_interest_contracts', 'long_contracts', 'short_contracts', 'spreading_contracts', 'spreading_status', 'net_contracts', 'net_unavailable_reason', 'net_percent_open_interest', 'net_percent_open_interest_unavailable_reason', 'raw_open_interest_field', 'raw_open_interest_value', 'open_interest_unavailable_reason', 'raw_long_field', 'raw_long_value', 'long_unavailable_reason', 'raw_short_field', 'raw_short_value', 'short_unavailable_reason', 'raw_spreading_field', 'raw_spreading_value', 'spreading_unavailable_reason', 'one_week_change_contracts', 'one_week_change_percentage_points', 'four_week_change_contracts', 'four_week_change_percentage_points', 'previous_available_change_contracts', 'previous_available_report_date', 'previous_available_elapsed_days', 'positioning_percentile', 'percentile_reason', 'percentile_observations', 'percentile_comparison_start', 'percentile_comparison_end', 'history_window', 'required_prior_reports', 'history_start', 'history_end', 'history_observations', 'response_status', 'refresh_warning', 'retrieval_origin_scope', 'retrieval_scope_rows', 'retrieval_source_rows', 'retrieval_source_pages', 'retrieval_source_page_size', 'retrieval_cap_reached', 'retrieval_bounded_scope_rows', 'retrieval_bounded_source_rows', 'required_values_unavailable', 'quarantined_row_count', 'quarantine', 'net_formula', 'percent_open_interest_formula', 'percentile_formula', 'one_week_change_formula', 'one_week_percentage_point_change_formula', 'four_week_change_formula', 'four_week_percentage_point_change_formula', 'previous_available_change_formula', 'source_url', 'history_source_url', 'retrieved_at'];
  const lines = rows.map(row => {
    const selected = row.selected || row;
    const contract = response?.selected || selected;
    const selectedGroup = selected.selectedGroup || selected.groups?.[group] || {};
    const rawFields = selectedGroup.rawFields || response?.selected?.selectedGroup?.rawFields || response?.selected?.groups?.[group]?.rawFields || {};
    const raw = row.raw || selected.raw || {};
    const unavailable = row.unavailable || selected.unavailable || {};
    const rawValue = field => field && Object.hasOwn(raw, field) ? raw[field] : null;
    const unavailableReason = field => field ? unavailable[field] || 'Available' : 'Not applicable';
    const isSelectedDate = selected.reportDate === response?.selected?.reportDate;
    const spreadingStatus = selectedGroup.spreadingStatus ?? row.spreadingStatus ?? 'unavailable';
    const spreading = selectedGroup.spreading ?? row.spreading;
    const spreadingValue = spreading == null && spreadingStatus === 'not_applicable' ? 'Not applicable' : spreading;
    const netValue = selectedGroup.net ?? row.net, netPctValue = selectedGroup.netPctOi ?? row.netPctOi;
    const derivedUnavailable = row.derivedUnavailable || {
      ...(netValue == null ? { net: 'long_or_short_unavailable' } : {}),
      ...(netPctValue == null ? { netPctOi: netValue == null ? 'net_unavailable' : selected.openInterest == null ? 'open_interest_unavailable' : selected.openInterest <= 0 ? 'open_interest_not_positive' : 'calculation_unavailable' } : {}),
    };
    const spreadField = rawFields.spreading || null;
    return [CFTC_SCHEMA_VERSION, CFTC_CALCULATION_VERSION, response.report_family, CFTC_REPORT_BASIS, selected.code || contract.code || response.selection?.contract, selected.marketName ?? contract.marketName, selected.contractName ?? contract.contractName, selected.exchange ?? contract.exchange, selected.units || contract.units, group, selected.reportDate, row.sourceRowId ?? selected.sourceRowId, selected.openInterest, selectedGroup.long ?? row.long, selectedGroup.short ?? row.short, spreadingValue, spreadingStatus, netValue, derivedUnavailable.net || 'Available', netPctValue, derivedUnavailable.netPctOi || 'Available', 'open_interest_all', rawValue('open_interest_all'), unavailableReason('open_interest_all'), rawFields.long, rawValue(rawFields.long), unavailableReason(rawFields.long), rawFields.short, rawValue(rawFields.short), unavailableReason(rawFields.short), spreadField || 'Not applicable', spreadField ? rawValue(spreadField) : 'Not applicable', unavailableReason(spreadField), isSelectedDate ? response.selected?.oneWeekChange ?? selected.oneWeekChange ?? row.oneWeekChange : null, isSelectedDate ? response.selected?.oneWeekNetPctChange ?? selected.oneWeekNetPctChange ?? row.oneWeekNetPctChange : null, isSelectedDate ? response.selected?.fourWeekChange ?? selected.fourWeekChange ?? row.fourWeekChange : null, isSelectedDate ? response.selected?.fourWeekNetPctChange ?? selected.fourWeekNetPctChange ?? row.fourWeekNetPctChange : null, isSelectedDate ? response.selected?.previousAvailableChange : null, isSelectedDate ? response.selected?.previousAvailableDate : null, isSelectedDate ? response.selected?.previousAvailableElapsedDays : null, isSelectedDate ? response.percentile?.value : null, isSelectedDate ? response.percentile?.reason || 'Available' : null, isSelectedDate ? response.percentile?.comparisonRange?.observations ?? response.percentile?.observations : null, isSelectedDate ? response.percentile?.comparisonRange?.earliest : null, isSelectedDate ? response.percentile?.comparisonRange?.latest : null, response.selection?.history_window, response.selection?.required_prior_reports, response.coverage?.earliest, response.coverage?.latest, response.coverage?.observations, response.status, response.refresh_warning, response.retrieval?.origin_scope, response.retrieval?.scope_rows, response.retrieval?.source_rows, response.retrieval?.source_pages, response.retrieval?.source_page_size, response.retrieval?.cap_reached, response.retrieval?.bounded_scope_rows, response.retrieval?.bounded_source_rows, JSON.stringify(response.coverage?.required_values_unavailable || []), Array.isArray(response.quarantine) ? response.quarantine.length : null, JSON.stringify(response.quarantine || []), response.formula?.net_contracts || response.methodology?.net_contracts, response.formula?.net_percent_open_interest || response.methodology?.net_percent_open_interest, response.formula?.percentile || response.methodology?.percentile, response.formula?.one_week_change || response.methodology?.weekly_change, response.formula?.one_week_net_percent_open_interest_change || response.methodology?.weekly_net_percent_open_interest_change, response.formula?.four_week_change || response.methodology?.four_week_change, response.formula?.four_week_net_percent_open_interest_change || response.methodology?.four_week_net_percent_open_interest_change, response.formula?.previous_available_change || response.methodology?.previous_available_change, response.source?.url, response.source?.history_url, response.retrieved_at].map(safeCsv).join(',');
  });
  return [header.map(safeCsv).join(','), ...lines].join('\r\n');
}
