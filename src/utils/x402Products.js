import { createHash } from 'node:crypto';
import { readPreparedAnalysis } from './preparedFinancialData.js';
import { readUniverseSnapshot, isUniverseSnapshot } from './marketUniverseServer.js';
import { readCachedRefinancingWall } from './refinancing/publicRead.js';
import { retainedRefinancingWall } from './refinancing/server.js';
import { UNIVERSE_METRICS } from './marketFundamentals.js';
import { createPaidResearchReaders, X402_DATA_HEADERS, x402DataError } from './x402Research.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const metricKeys = UNIVERSE_METRICS.map(metric => metric.key);
export { X402_PRODUCT_RESPONSE_SCHEMAS } from './x402ProductSchemas.js';
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const invalid = () => x402DataError('INVALID_SELECTION', 'Use the documented bounded product selectors. This request is not charged.', 400);
const unavailable = () => x402DataError('DATA_NOT_PREPARED', 'Validated prepared product data is unavailable. No source downloads are started and this request is not charged.', 503);
const slug = value => /^[a-z][a-z0-9-]{0,79}$/.test(value);
const enumValue = (query, key, fallback, options) => {
  const value = query.get(key) ?? fallback;
  return options.includes(value) ? value : null;
};
function numberValue(query, key, nonnegative = false) {
  if (!query.has(key)) return undefined;
  const value = query.get(key);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return finite(parsed) && Math.abs(parsed) <= 1e15 && (!nonnegative || parsed >= 0) ? parsed : null;
}
function pageSelection(query) {
  const limit = query.get('limit') ?? '100', offset = query.get('offset') ?? '0', snapshot = query.get('snapshot') ?? '';
  if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100 || !/^(0|[1-9]\d{0,3})$/.test(offset)
    || snapshot && !/^[a-f0-9]{64}$/.test(snapshot)) return null;
  return { limit: Number(limit), offset: Number(offset), snapshot };
}

/** Strict selection happens before the payment middleware or any data read. */
export function paidProductSelection(request, kind) {
  const query = new URL(request.url).searchParams;
  const common = ['format'];
  const pages = ['sector', 'limit', 'offset', 'snapshot', 'sort', 'order'];
  const allowed = kind === 'financial-batch' ? [...common, 'tickers', 'basis']
    : kind === 'fundamental-screen' ? [...common, ...pages, 'basis', 'metric', 'field', 'min', 'max', 'missing']
      : kind === 'credit-screen' ? [...common, ...pages, 'minDebt', 'maxCashCoverage', 'minInterestCoverage', 'coverage'] : [];
  if (!allowed.length || [...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1 || !query.get(key))) return null;
  const format = enumValue(query, 'format', 'json', ['json', 'csv']);
  if (!format) return null;
  if (kind === 'financial-batch') {
    const tickers = (query.get('tickers') || '').split(',').map(value => value.trim().toUpperCase());
    const basis = enumValue(query, 'basis', 'annual', ['annual', 'quarter', 'ytd', 'ttm']);
    if (!basis || tickers.length > 10 || tickers.some(ticker => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker))
      || new Set(tickers).size !== tickers.length) return null;
    return { tickers, basis, format };
  }
  const page = pageSelection(query), sector = query.get('sector') ?? 'all';
  const order = enumValue(query, 'order', 'desc', ['asc', 'desc']);
  if (!page || !slug(sector) || !order) return null;
  if (kind === 'fundamental-screen') {
    const basis = enumValue(query, 'basis', 'ttm', ['ttm', 'annual']);
    const metric = enumValue(query, 'metric', 'revenueGrowth', metricKeys);
    const field = enumValue(query, 'field', 'change', ['current', 'prior', 'change']);
    const sort = enumValue(query, 'sort', 'metric', ['metric', 'ticker']);
    const missing = enumValue(query, 'missing', 'exclude', ['exclude', 'include']);
    const min = numberValue(query, 'min'), max = numberValue(query, 'max');
    if (!basis || !metric || !field || !sort || !missing || min === null || max === null
      || min !== undefined && max !== undefined && min > max) return null;
    return { basis, sector, metric, field, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), sort, order, missing, ...page, format };
  }
  const sort = enumValue(query, 'sort', 'next12m', ['next12m', 'cashToNext12m', 'interestCoverage', 'ticker']);
  const coverage = enumValue(query, 'coverage', 'reported', ['reported', 'complete']);
  const minDebt = numberValue(query, 'minDebt', true), maxCashCoverage = numberValue(query, 'maxCashCoverage', true);
  const minInterestCoverage = numberValue(query, 'minInterestCoverage');
  if (!sort || !coverage || [minDebt, maxCashCoverage, minInterestCoverage].includes(null)) return null;
  return { sector, ...(minDebt !== undefined ? { minDebt } : {}), ...(maxCashCoverage !== undefined ? { maxCashCoverage } : {}),
    ...(minInterestCoverage !== undefined ? { minInterestCoverage } : {}), coverage, sort, order, ...page, format };
}

/** Quote textual cells and neutralize spreadsheet formulas, retaining numeric negatives. */
export function paidCsvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return finite(value) ? String(value) : '';
  const input = typeof value === 'string' ? value : JSON.stringify(value);
  const safe = /^[\s\x00-\x1f]*[=+\-@]/.test(input) || /^[\t\r\n]/.test(input) ? `'${input}` : input;
  return `"${safe.replaceAll('"', '""')}"`;
}
function csv(columns, rows) {
  return `${columns.map(paidCsvCell).join(',')}\r\n${rows.map(row => columns.map(column => paidCsvCell(row[column])).join(',')).join('\r\n')}\r\n`;
}
function deliver(payload, selection, columns, csvRows, stale, filename) {
  let body;
  try { body = selection.format === 'csv' ? csv(columns, csvRows) : JSON.stringify(payload); }
  catch { return unavailable(); }
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) return x402DataError('PRODUCT_TOO_LARGE', 'This product exceeds the bounded delivery size. Choose fewer companies or a smaller page. This request is not charged.', 413);
  return new Response(body, { headers: { ...X402_DATA_HEADERS, 'X-Data-Stale': stale ? '1' : '0',
    'Access-Control-Expose-Headers': `${X402_DATA_HEADERS['Access-Control-Expose-Headers']}, X-Schema-Version, Content-Disposition`,
    'Content-Type': selection.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Schema-Version': payload.schemaVersion,
    ...(selection.format === 'csv' ? { 'Content-Disposition': `attachment; filename="${filename}.csv"` } : {}),
  } });
}
const criteria = selection => Object.fromEntries(Object.entries(selection).filter(([key]) => !['limit', 'offset', 'snapshot', 'format'].includes(key)));
function pageRows(sourceIdentity, rows, selection) {
  const snapshot = createHash('sha256').update(JSON.stringify({ source: sourceIdentity, criteria: criteria(selection) })).digest('hex');
  if (selection.snapshot && selection.snapshot !== snapshot) return x402DataError('SNAPSHOT_CHANGED', 'The source snapshot or screen criteria changed. Restart pagination without a snapshot token. This request is not charged.', 409);
  if (!rows.length) return x402DataError('NO_MATCHING_DATA', 'No prepared company rows match these filters. This request is not charged.', 404);
  if (selection.offset >= rows.length) return x402DataError('PAGE_OUT_OF_RANGE', 'The offset is beyond this screen. This request is not charged.', 416);
  const nextOffset = selection.offset + selection.limit < rows.length ? selection.offset + selection.limit : null;
  return { rows: rows.slice(selection.offset, selection.offset + selection.limit),
    pagination: { limit: selection.limit, offset: selection.offset, total: rows.length, nextOffset, snapshot } };
}
function sortRows(rows, selection, value) {
  return [...rows].sort((a, b) => {
    if (selection.sort === 'ticker') return (selection.order === 'asc' ? 1 : -1) * a.ticker.localeCompare(b.ticker, 'en');
    const left = value(a), right = value(b);
    // Missing observations always appear last, regardless of sort direction.
    if (!finite(left) || !finite(right)) return finite(left) ? -1 : finite(right) ? 1 : a.ticker.localeCompare(b.ticker, 'en');
    return (selection.order === 'asc' ? left - right : right - left) || a.ticker.localeCompare(b.ticker, 'en');
  });
}
function percentileMap(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b), result = new Map();
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end] === sorted[start]) end++;
    result.set(sorted[start], 100 * (start + (end - start) / 2) / sorted.length);
    start = end;
  }
  return { values: result, eligible: sorted.length };
}
const financialColumns = ['schemaVersion', 'ticker', 'cik', 'name', 'basis', 'fetchedAt', 'checkedAt', 'freshUntil', 'stale',
  'periodIndex', 'periodLabel', 'periodStart', 'periodEnd', 'periodFiled', 'metric', 'label', 'format', 'category', 'definition',
  'value', 'unit', 'reason', 'sourceReferences', 'calculationReferences', 'limitations'];
const screenColumns = ['schemaVersion', 'snapshot', 'snapshotAt', 'generatedAt', 'stale', 'criteria', 'totalMatches', 'offset', 'nextOffset',
  'ticker', 'cik', 'name', 'sector', 'financial', 'selectedMetric', 'selectedField', 'selectedValue', 'peerPercentile', 'peerEligible',
  ...metricKeys.flatMap(key => [`${key}.current`, `${key}.prior`, `${key}.change`, `${key}.unavailableReason`]),
  'filed', 'fiscalEnd', 'priorFiscalEnd', 'accession', 'sourceUrl', 'sourceAccessions', 'secCheckedAt', 'factsRetrievedAt', 'limitations'];
const debtKeys = ['next12m', 'year2', 'year3', 'year4', 'year5', 'after5'];
const creditMetrics = ['cash', 'operatingCashFlow', 'operatingIncome', 'interestExpense', 'interestCoverage', 'cashToNext12m'];
const creditColumns = ['schemaVersion', 'snapshot', 'snapshotAt', 'generatedAt', 'stale', 'criteria', 'totalMatches', 'offset', 'nextOffset',
  'ticker', 'cik', 'name', 'sector', 'checkedAt', 'factsRetrievedAt', 'asOf', 'filedAt', 'accession', 'sourceUrl', 'basis', 'currency',
  'reportedBuckets', 'complete', 'totalScheduled', 'reportedSubtotal', 'cashShortfallToNext12m',
  ...debtKeys.flatMap(key => [`${key}.value`, `${key}.startDate`, `${key}.endDate`, `${key}.dateBasis`, `${key}.tag`, `${key}.reason`]),
  ...creditMetrics.flatMap(key => [`${key}.value`, `${key}.tag`, `${key}.startDate`, `${key}.endDate`, `${key}.reason`, `${key}.formula`]), 'warnings', 'limitations'];
function publicCreditCompany(row) {
  const profile = row.profile;
  return { ...pick(row, ['ticker', 'cik', 'name', 'sic', 'sector', 'sectorId', 'checkedAt', 'factsRetrievedAt']),
    profile: { ...pick(profile, ['schemaVersion', 'cik', 'currency', 'status', 'reason', 'asOf', 'filedAt', 'accession', 'form', 'basis',
      'sourceUrl', 'totalScheduled', 'reportedSubtotal', 'warnings']),
    coverage: pick(profile.coverage, ['reportedBuckets', 'totalBuckets', 'complete', 'reason']),
    buckets: profile.buckets.map(bucket => pick(bucket, ['key', 'label', 'value', 'startDate', 'endDate', 'calendarYear', 'dateBasis', 'tag', 'reason'])),
    metrics: Object.fromEntries(creditMetrics.map(key => [key, pick(profile.metrics[key], ['value', 'tag', 'startDate', 'endDate', 'reason', 'formula'])])),
    } };
}

/** Paid delivery only reads validated prepared publications; no upstream or queue work. */
export function createPaidProductReaders({ financialRead = readPreparedAnalysis, universeRead = readUniverseSnapshot,
  refinancingRead = readCachedRefinancingWall, now = Date.now } = {}) {
  const financial = createPaidResearchReaders({ financialRead, now });
  return {
    async financialBatch(selection) {
      if (!Array.isArray(selection?.tickers) || !selection.tickers.length || selection.tickers.length > 10) return invalid();
      let companies;
      try {
        const responses = await Promise.all(selection.tickers.map(ticker => financial.financials({ ticker, basis: selection.basis })));
        if (responses.some(response => !response.ok)) return unavailable();
        companies = await Promise.all(responses.map(response => response.json()));
      } catch { return unavailable(); }
      for (const { model } of companies) for (const definition of model.definitions) {
        const points = model.metrics[definition.key];
        if (!Array.isArray(points) || points.length !== model.periods.length || points.some(point => !record(point)
          || !Array.isArray(point.sourceIds) || !Array.isArray(point.calculationIds)
          || point.sourceIds.some(id => !Number.isInteger(id) || id < 0 || id >= model.sourceCatalog.length)
          || point.calculationIds.some(id => !Number.isInteger(id) || id < 0 || id >= model.calculationCatalog.length))) return unavailable();
      }
      const stale = companies.some(company => company.stale);
      const limitations = ['Every requested company must have a validated prepared model; unavailable companies fail the entire purchase without settlement.',
        'Histories use the latest filed values, including revisions, and are not an as-filed point-in-time archive. Fiscal periods and source coverage differ across companies.',
        'Missing observations remain null; CSV missing values are empty. Preserve metric definitions, units, reporting periods and SEC evidence.'];
      const payload = { schemaVersion: 'edgar.paid-financial-batch.v1', status: 'ready', selection: { tickers: selection.tickers, basis: selection.basis },
        stale, companyCount: companies.length, companies, limitations };
      const rows = [];
      if (selection.format === 'csv') for (const company of companies) {
        const model = company.model;
        for (const definition of model.definitions) for (let index = 0; index < model.periods.length; index++) {
          const point = model.metrics[definition.key]?.[index], period = model.periods[index];
          if (!record(point) || !Array.isArray(point.sourceIds) || !Array.isArray(point.calculationIds)
            || point.sourceIds.some(id => !Number.isInteger(id) || id < 0 || id >= model.sourceCatalog.length)
            || point.calculationIds.some(id => !Number.isInteger(id) || id < 0 || id >= model.calculationCatalog.length)) return unavailable();
          rows.push({ schemaVersion: payload.schemaVersion, ticker: model.ticker, cik: model.cik, name: model.name, basis: model.basis,
            fetchedAt: company.fetchedAt, checkedAt: company.checkedAt, freshUntil: company.freshUntil, stale: company.stale,
            periodIndex: index, periodLabel: period.label, periodStart: period.start, periodEnd: period.end, periodFiled: period.filed,
            metric: definition.key, label: definition.label, format: definition.format, category: definition.category, definition,
            value: finite(point.value) ? point.value : null, unit: point.unit, reason: point.reason || point.note || null,
            sourceReferences: point.sourceIds.map(id => model.sourceCatalog[id]), calculationReferences: point.calculationIds.map(id => model.calculationCatalog[id]), limitations });
        }
      }
      return deliver(payload, selection, financialColumns, rows, stale, 'edgar-financial-batch');
    },
    async fundamentalScreen(selection) {
      let value;
      try { value = await universeRead(selection.basis); } catch { return unavailable(); }
      if (!isUniverseSnapshot(value, selection.basis) || value.cache_status === 'computed-from-prepared-sec') return unavailable();
      if ([value.generated_at, value.sec_snapshot_at].some(time => now() - Date.parse(time) < 0 || now() - Date.parse(time) >= 7 * 86400000)) return unavailable();
      if (selection.sector !== 'all' && !Object.hasOwn(value.scopes, selection.sector)) return x402DataError('UNKNOWN_SECTOR', 'Use a sector present in the prepared fundamental universe. This request is not charged.', 400);
      const population = value.rows.filter(row => selection.sector === 'all' || row.group === selection.sector);
      const measure = row => row.metrics[selection.metric][selection.field];
      const percentiles = percentileMap(population.map(measure));
      const filtered = population.filter(row => {
        const observed = measure(row);
        if (!finite(observed)) return selection.missing === 'include' && selection.min === undefined && selection.max === undefined;
        return (selection.min === undefined || observed >= selection.min) && (selection.max === undefined || observed <= selection.max);
      });
      const rows = sortRows(filtered, selection, measure).map(row => ({ ...row, selectedValue: measure(row),
        peerPercentile: finite(measure(row)) ? percentiles.values.get(measure(row)) : null }));
      const identity = pick(value, ['schema_version', 'methodology_version', 'diagnostics_version', 'generated_at', 'sec_snapshot_at', 'basis', 'universe', 'rows']);
      const page = pageRows(identity, rows, selection);
      if (page instanceof Response) return page;
      const stale = value.sec_stale || value.status === 'stale';
      const limitations = [...value.limitations, 'Screen bounds and metric values are percentage points. Missing selected values are excluded by default and are always excluded by numeric filters.',
        'Peer percentile is 100 × (values below + half of ties) / eligible values, within the selected sector before numeric filters. Higher percentile means a larger value, not a recommendation.',
        'The snapshot token pins both source data and screen criteria; page size and delivery format may change without changing that token.'];
      const payload = { schemaVersion: 'edgar.paid-fundamental-screen.v1', status: 'ready', stale, selection: criteria(selection),
        snapshot: pick(value, ['schema_version', 'methodology_version', 'diagnostics_version', 'generated_at', 'sec_snapshot_at', 'basis', 'universe', 'fundamental_definitions']),
        sectors: Object.values(value.scopes).map(scope => ({ id: scope.id, label: scope.label, companies: scope.companies })),
        population: { companies: population.length, metricEligible: percentiles.eligible, metricMissing: population.length - percentiles.eligible },
        ...page, limitations };
      const csvRows = selection.format === 'csv' ? page.rows.map(row => ({ schemaVersion: payload.schemaVersion,
        snapshot: page.pagination.snapshot, snapshotAt: value.sec_snapshot_at, generatedAt: value.generated_at, stale,
        criteria: criteria(selection), totalMatches: page.pagination.total, offset: page.pagination.offset, nextOffset: page.pagination.nextOffset,
        ticker: row.ticker, cik: row.cik, name: row.name, sector: row.group, financial: row.financial, selectedMetric: selection.metric, selectedField: selection.field,
        selectedValue: row.selectedValue, peerPercentile: row.peerPercentile, peerEligible: percentiles.eligible,
        ...Object.fromEntries(metricKeys.flatMap(key => [['current', 'prior', 'change'].map(field => [`${key}.${field}`, row.metrics[key][field]]),
          [[`${key}.unavailableReason`, row.metrics[key].unavailable_reason]]].flat())),
        filed: row.filed, fiscalEnd: row.fiscal_end, priorFiscalEnd: row.prior_fiscal_end, accession: row.accession, sourceUrl: row.source,
        sourceAccessions: row.source_accessions, secCheckedAt: row.sec_checked_at, factsRetrievedAt: row.facts_retrieved_at, limitations })) : [];
      return deliver(payload, selection, screenColumns, csvRows, stale, 'edgar-fundamental-screen');
    },
    async creditScreen(selection) {
      let value;
      try { value = retainedRefinancingWall(await refinancingRead(), now()); } catch { return unavailable(); }
      if (!value) return unavailable();
      if (selection.sector !== 'all' && !value.sectors.some(sector => sector.id === selection.sector)) return x402DataError('UNKNOWN_SECTOR', 'Use a sector present in the prepared credit snapshot. This request is not charged.', 400);
      const population = value.companies.filter(row => selection.sector === 'all' || row.sectorId === selection.sector);
      const nextDebt = row => row.profile?.buckets.find(bucket => bucket.key === 'next12m')?.value;
      const metric = (row, key) => row.profile?.metrics[key]?.value;
      const selected = population.filter(row => row.profile?.status === 'ready' && (selection.coverage !== 'complete' || row.profile.coverage.complete)
        && (selection.minDebt === undefined || finite(nextDebt(row)) && nextDebt(row) >= selection.minDebt)
        && (selection.maxCashCoverage === undefined || finite(metric(row, 'cashToNext12m')) && metric(row, 'cashToNext12m') <= selection.maxCashCoverage)
        && (selection.minInterestCoverage === undefined || finite(metric(row, 'interestCoverage')) && metric(row, 'interestCoverage') >= selection.minInterestCoverage));
      const rows = sortRows(selected, selection, row => selection.sort === 'next12m' ? nextDebt(row) : metric(row, selection.sort))
        .map(row => ({ ...publicCreditCompany(row), cashShortfallToNext12m: finite(nextDebt(row)) && finite(metric(row, 'cash')) ? Math.max(0, nextDebt(row) - metric(row, 'cash')) : null }));
      const identity = pick(value, ['version', 'extractionVersion', 'generatedAt', 'sourceSnapshotAt', 'membershipId', 'companies', 'coverage', 'sectors']);
      const page = pageRows(identity, rows, selection);
      if (page instanceof Response) return page;
      const stale = value.cache.status === 'stale';
      const limitations = ['Only issuers with reported debt-maturity buckets are delivered. coverage=complete requires all six buckets; pending and unavailable schedules are excluded.',
        'minDebt is USD principal in the next12m bucket. cashToNext12m and interestCoverage are ratios, not percentages. Missing inputs fail numeric filters and remain null elsewhere.',
        'Next12m can mean the next fiscal year or rolling twelve months; preserve each profile basis and bucket dates. Calendar-year estimates and incomplete schedules must not be silently combined.',
        'Cash shortfall is max(next12m principal − reported cash, 0) from the schedule filing. It is a descriptive calculation, not a forecast or credit rating.',
        'Source dates, maturity coverage and filing warnings remain attached. The snapshot token pins the source data and screen criteria.'];
      const payload = { schemaVersion: 'edgar.paid-credit-screen.v1', status: 'ready', stale, selection: criteria(selection),
        snapshot: pick(value, ['version', 'extractionVersion', 'generatedAt', 'sourceSnapshotAt', 'membershipId', 'coverage', 'sectors']),
        population: { companies: population.length, reportedSchedules: population.filter(row => row.profile?.status === 'ready').length,
          completeSchedules: population.filter(row => row.profile?.coverage.complete).length }, ...page, limitations };
      const csvRows = selection.format === 'csv' ? page.rows.map(row => {
        const profile = row.profile;
        return { schemaVersion: payload.schemaVersion, snapshot: page.pagination.snapshot, snapshotAt: value.sourceSnapshotAt, generatedAt: value.generatedAt, stale,
          criteria: criteria(selection), totalMatches: page.pagination.total, offset: page.pagination.offset, nextOffset: page.pagination.nextOffset,
          ...pick(row, ['ticker', 'cik', 'name', 'sector', 'checkedAt', 'factsRetrievedAt', 'cashShortfallToNext12m']),
          ...pick(profile, ['asOf', 'filedAt', 'accession', 'sourceUrl', 'basis', 'currency', 'totalScheduled', 'reportedSubtotal', 'warnings']),
          reportedBuckets: profile.coverage.reportedBuckets, complete: profile.coverage.complete,
          ...Object.fromEntries(profile.buckets.flatMap(bucket => ['value', 'startDate', 'endDate', 'dateBasis', 'tag', 'reason'].map(key => [`${bucket.key}.${key}`, bucket[key]]))),
          ...Object.fromEntries(creditMetrics.flatMap(metricKey => ['value', 'tag', 'startDate', 'endDate', 'reason', 'formula'].map(key => [`${metricKey}.${key}`, profile.metrics[metricKey][key]]))), limitations };
      }) : [];
      return deliver(payload, selection, creditColumns, csvRows, stale, 'edgar-credit-screen');
    },
  };
}
export const paidProductReaders = createPaidProductReaders();
