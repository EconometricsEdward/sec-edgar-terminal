import { createPaidResearchReaders, X402_DATA_HEADERS, x402DataError } from './x402Research.js';
import { unpackAnalysisCompany, analysisBaseline, analysisChange } from './analysisResearch.js';
import { paidCsvCell } from './x402Products.js';
import { X402_FINANCIAL_CHANGE_METRICS, X402_FINANCIAL_CHANGES_VERSION } from './x402FinancialChangesSchema.js';

export { X402_FINANCIAL_CHANGES_SCHEMA } from './x402FinancialChangesSchema.js';
const MAX_BYTES = 4 * 1024 * 1024;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const record = value => value != null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const optionalDate = value => value == null || validDate(value);
const text = (value, max = 2000) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid evidence text');
  return value;
};
const invalid = () => x402DataError('INVALID_SELECTION', 'Use one to ten unique tickers and the documented financial-change selectors. This request is not charged.', 400);
const unavailable = () => x402DataError('DATA_NOT_PREPARED', 'Validated prepared financial-change evidence is unavailable. No source downloads are started and this request is not charged.', 503);
const noPairs = () => x402DataError('NO_COMPARABLE_DATA', 'Every requested issuer needs at least one compatible current/prior observation pair. This request is not charged.', 404);
const defaults = X402_FINANCIAL_CHANGE_METRICS.filter(key => key !== 'totalDebt');
const modelKey = key => key === 'equity' ? 'stockholdersEquity' : key;

function validSelection(selection) {
  return record(selection) && Object.keys(selection).every(key => ['tickers', 'basis', 'comparison', 'metrics', 'format'].includes(key))
    && Array.isArray(selection.tickers) && selection.tickers.length > 0 && selection.tickers.length <= 10
    && selection.tickers.every(ticker => typeof ticker === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker))
    && new Set(selection.tickers).size === selection.tickers.length && ['annual', 'quarter', 'ytd', 'ttm'].includes(selection.basis)
    && ['year', 'previous'].includes(selection.comparison) && !(selection.comparison === 'previous' && ['ytd', 'ttm'].includes(selection.basis))
    && Array.isArray(selection.metrics) && selection.metrics.length > 0 && selection.metrics.length <= 12
    && selection.metrics.every(key => X402_FINANCIAL_CHANGE_METRICS.includes(key)) && new Set(selection.metrics).size === selection.metrics.length
    && ['json', 'csv'].includes(selection.format);
}

/** Reject ambiguous selectors before source reads or payment verification. */
export function paidFinancialChangesSelection(request) {
  const query = new URL(request.url).searchParams, allowed = ['tickers', 'basis', 'comparison', 'metrics', 'format'];
  if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1 || !query.get(key))) return null;
  const selection = { tickers: (query.get('tickers') || '').split(',').map(value => value.trim().toUpperCase()),
    basis: query.get('basis') ?? 'annual', comparison: query.get('comparison') ?? 'year',
    metrics: query.has('metrics') ? query.get('metrics').split(',').map(value => value.trim()) : [...defaults],
    format: query.get('format') ?? 'json' };
  return validSelection(selection) ? selection : null;
}

function reportingPeriod(value, basis) {
  if (!record(value) || value.kind !== basis || !validDate(value.end) || !optionalDate(value.start)
    || value.start && value.start > value.end || !optionalDate(value.filed)) throw new Error('Invalid reporting period');
  return { kind: value.kind, start: value.start ?? null, end: value.end,
    fiscalYear: Number.isSafeInteger(value.fy) ? value.fy : null, fiscalPeriod: text(value.fp, 8),
    filed: value.filed ?? null, form: text(value.form, 16), accession: text(value.accession, 20) };
}
function sourceReference(value) {
  if (!record(value) || !finite(value.value) || !validDate(value.end) || !validDate(value.filed)
    || !optionalDate(value.start) || value.start && value.start > value.end
    || !/^\d{10}-\d{2}-\d{6}$/.test(value.accession || '')) throw new Error('Invalid source provenance');
  const url = new URL(value.documentUrl);
  if (url.protocol !== 'https:' || !['sec.gov', 'www.sec.gov'].includes(url.hostname)
    || url.username || url.password || url.port || !url.pathname.startsWith('/Archives/')) throw new Error('Invalid SEC source URL');
  const taxonomy = text(value.taxonomy, 80), tag = text(value.tag, 240), unit = text(value.unit, 80), form = text(value.form, 16);
  if (!taxonomy || !tag || !unit || !form || value.sourceCik != null && (typeof value.sourceCik !== 'string' || !/^(?!0+$)\d{10}$/.test(value.sourceCik))
    || value.revised != null && typeof value.revised !== 'boolean') throw new Error('Incomplete source provenance');
  return { taxonomy, tag, unit, start: value.start ?? null, end: value.end, value: value.value,
    accession: value.accession, filed: value.filed, form, documentUrl: url.href, sourceCik: value.sourceCik ?? null,
    revised: value.revised === true, scopeNote: text(value.scopeNote), revisionNote: text(value.revisionNote), label: text(value.label) };
}
function calculationReference(value) {
  if (!record(value) || !text(value.formula) || value.value != null && !finite(value.value)
    || !optionalDate(value.start) || !optionalDate(value.end) || value.start && value.end && value.start > value.end)
    throw new Error('Invalid calculation provenance');
  return { formula: value.formula, label: text(value.label), value: value.value ?? null,
    start: value.start ?? null, end: value.end ?? null, unit: text(value.unit, 80) };
}
function missingObservation(reason, point) {
  return { value: null, unit: null, unitBasis: 'not-specified', classification: 'unavailable', observationPeriod: null,
    formula: text(point?.formula), reason, note: text(point?.note), sourceIds: [], calculationIds: [] };
}
function intern(value, rows, indices) {
  const identity = JSON.stringify(value);
  if (!indices.has(identity)) {
    if (rows.length >= 512) throw new Error('Unbounded selected evidence');
    indices.set(identity, rows.length); rows.push(value);
  }
  return indices.get(identity);
}
function observation(point, definition, period, catalogs) {
  if (!point) return missingObservation('The requested metric is absent from this prepared model.');
  if (point.value == null) return missingObservation(text(point.reason || point.note) || 'A required reported input is unavailable.', point);
  if (!finite(point.value) || !['reported', 'calculated'].includes(point.classification)
    || !Array.isArray(point.sources) || !point.sources.length || point.sources.length > 128
    || !Array.isArray(point.calculations) || point.calculations.length > 128) throw new Error('Invalid metric evidence');
  const sources = point.sources.map(sourceReference), calculations = point.calculations.map(calculationReference);
  const formula = text(point.formula || definition?.formula);
  if (point.classification === 'calculated' && !formula && !calculations.length) throw new Error('Calculated metric lacks explanation');
  let window, dateBasis;
  if (point.observationPeriod) {
    window = point.observationPeriod; dateBasis = 'metric-observation';
    if (!['instant', 'duration'].includes(window.kind) || !validDate(window.end) || !optionalDate(window.start)
      || window.kind === 'instant' && window.start != null || window.kind === 'duration' && (!window.start || window.start > window.end))
      throw new Error('Invalid observation window');
  } else {
    const flows = sources.filter(source => source.start != null);
    const sameWindow = flows.length && flows.every(source => source.start === flows[0].start && source.end === flows[0].end);
    const instant = !flows.length && sources.every(source => source.end === period.end);
    window = sameWindow ? { kind: 'duration', start: flows[0].start, end: flows[0].end }
      : instant ? { kind: 'instant', start: null, end: period.end } : { kind: 'duration', start: period.start, end: period.end };
    dateBasis = sameWindow || instant ? 'reported-source' : 'reporting-period-calculation';
    if (window.kind === 'duration' && !validDate(window.start)) throw new Error('Unspecified calculation window');
  }
  if (window.end !== period.end || Math.max(...sources.map(source => Date.parse(source.end))) !== Date.parse(period.end))
    throw new Error('Observation evidence is not aligned with its reporting end');
  const units = [...new Set(sources.map(source => source.unit))];
  const explicitUnit = text(point.unit, 80);
  if (explicitUnit && (definition.format === 'percent' ? explicitUnit !== '%' : units.length === 1 && explicitUnit !== units[0]))
    throw new Error('Observation unit contradicts its definition or reported evidence');
  const unit = explicitUnit || (definition.format === 'percent' ? '%' : units.length === 1 ? units[0] : null);
  const unitBasis = explicitUnit ? 'metric-observation' : definition.format === 'percent' ? 'metric-definition-format' : unit ? 'reported-source' : 'not-specified';
  return { value: point.value, unit, unitBasis, classification: point.classification,
    observationPeriod: { kind: window.kind, start: window.start ?? null, end: window.end, dateBasis }, formula,
    reason: text(point.reason), note: text(point.note),
    sourceIds: [...new Set(sources.map(value => intern(value, catalogs.sources, catalogs.sourceIndices)))],
    calculationIds: [...new Set(calculations.map(value => intern(value, catalogs.calculations, catalogs.calculationIndices)))] };
}

function changesCompany(envelope, selection) {
  const packed = envelope.model;
  if (typeof packed.cik !== 'string') throw new Error('Invalid issuer identity');
  if (packed.periods.length > 500 || packed.periods.some((period, index) => {
    reportingPeriod(period, selection.basis);
    return index > 0 && packed.periods[index - 1].end <= period.end;
  })) throw new Error('Prepared periods are not newest first');
  const selectedKeys = selection.metrics.map(modelKey), selected = {};
  for (const key of selectedKeys) {
    if (!Object.hasOwn(packed.metrics, key)) continue;
    const points = packed.metrics[key];
    if (!Array.isArray(points) || points.length !== packed.periods.length || points.some(point => !record(point)
      || !Array.isArray(point.sourceIds) || !Array.isArray(point.calculationIds)
      || point.sourceIds.length > 128 || point.calculationIds.length > 128
      || point.sourceIds.some(id => !Number.isSafeInteger(id) || id < 0 || id >= packed.sourceCatalog.length)
      || point.calculationIds.some(id => !Number.isSafeInteger(id) || id < 0 || id >= packed.calculationCatalog.length))) throw new Error('Invalid packed evidence references');
    selected[key] = points;
  }
  const model = unpackAnalysisCompany({ ...packed, metrics: selected });
  const beforeIndex = analysisBaseline(model.periods, 0, selection.comparison);
  const period = reportingPeriod(model.periods[0], selection.basis);
  const comparisonPeriod = beforeIndex < 0 ? null : reportingPeriod(model.periods[beforeIndex], selection.basis);
  const catalogs = { sources: [], calculations: [], sourceIndices: new Map(), calculationIndices: new Map() };
  const metrics = selection.metrics.map(key => {
    const underlyingKey = modelKey(key), definitions = model.definitions.filter(definition => definition.key === underlyingKey);
    if (definitions.length > 1) throw new Error('Ambiguous metric definition');
    const definition = definitions[0];
    if (definition && (!['currency', 'percent'].includes(definition.format) || !text(definition.label, 240))) throw new Error('Invalid metric definition');
    const format = ['operatingMargin', 'netMargin'].includes(key) ? 'percent' : 'currency';
    if (definition && definition.format !== format || model.metrics[underlyingKey] && !definition) throw new Error('Incompatible metric definition');
    const currentPoint = model.metrics[underlyingKey]?.[0], priorPoint = beforeIndex < 0 ? null : model.metrics[underlyingKey]?.[beforeIndex];
    const current = observation(currentPoint, definition, period, catalogs);
    const prior = comparisonPeriod ? observation(priorPoint, definition, comparisonPeriod, catalogs)
      : missingObservation('No compatible prior reporting period is available for the selected comparison.');
    let change = analysisChange(currentPoint, priorPoint, format);
    if (change.delta !== null && (!current.unit || current.unit !== prior.unit))
      change = { delta: null, percent: null, reason: 'The observation units are unspecified or differ between periods.' };
    if (change.delta !== null && (!finite(change.delta) || change.percent != null && !finite(change.percent))) throw new Error('Nonfinite computed change');
    return { key, modelKey: underlyingKey, label: definition?.label || key, format,
      definition: { category: text(definition?.category, 80), formula: text(definition?.formula) }, current, prior,
      change: { absoluteDelta: change.delta, growthPercent: change.percent,
        percentagePointDelta: format === 'percent' ? change.delta : null,
        deltaUnit: change.delta === null ? null : format === 'percent' ? 'percentage-points' : current.unit,
        comparable: change.delta !== null, reason: change.reason } };
  });
  return { ticker: model.ticker, cik: model.cik, name: text(model.name, 500) || model.ticker, basis: model.basis,
    lens: text(model.lens, 80), businessModel: text(model.businessModel, 80), fetchedAt: envelope.fetchedAt,
    checkedAt: envelope.checkedAt, freshUntil: envelope.freshUntil, stale: envelope.stale,
    period, comparisonPeriod, metrics, sourceCatalog: catalogs.sources, calculationCatalog: catalogs.calculations,
    coverage: { requestedMetrics: metrics.length, comparableMetrics: metrics.filter(metric => metric.change.comparable).length, preparedHistoryPeriods: model.periods.length },
    notes: model.lensNote ? [text(model.lensNote)] : [] };
}

const columns = ['schemaVersion', 'ticker', 'cik', 'name', 'basis', 'comparison', 'fetchedAt', 'checkedAt', 'freshUntil', 'stale',
  'period', 'comparisonPeriod', 'metric', 'modelKey', 'label', 'format', 'definition',
  ...['current', 'prior'].flatMap(prefix => ['Value', 'Unit', 'UnitBasis', 'Classification', 'ObservationPeriod', 'Formula', 'Reason', 'Note', 'SourceReferences', 'CalculationReferences'].map(field => `${prefix}${field}`)),
  'absoluteDelta', 'growthPercent', 'percentagePointDelta', 'deltaUnit', 'comparable', 'changeReason', 'notes', 'limitations'];
function csvRows(payload) {
  return payload.companies.flatMap(company => company.metrics.map(metric => {
    const row = { schemaVersion: payload.schemaVersion, ticker: company.ticker, cik: company.cik, name: company.name,
      basis: company.basis, comparison: payload.selection.comparison, fetchedAt: company.fetchedAt, checkedAt: company.checkedAt,
      freshUntil: company.freshUntil, stale: company.stale, period: company.period, comparisonPeriod: company.comparisonPeriod,
      metric: metric.key, modelKey: metric.modelKey, label: metric.label, format: metric.format, definition: metric.definition,
      ...metric.change, changeReason: metric.change.reason, notes: company.notes, limitations: payload.limitations };
    for (const prefix of ['current', 'prior']) {
      const point = metric[prefix];
      for (const key of ['value', 'unit', 'unitBasis', 'classification', 'observationPeriod', 'formula', 'reason', 'note'])
        row[`${prefix}${key[0].toUpperCase()}${key.slice(1)}`] = point[key];
      row[`${prefix}SourceReferences`] = point.sourceIds.map(id => company.sourceCatalog[id]);
      row[`${prefix}CalculationReferences`] = point.calculationIds.map(id => company.calculationCatalog[id]);
    }
    return row;
  }));
}

/** Cache-only compact evidence packet. Failure of any issuer aborts the purchase. */
export function createPaidFinancialChangesReader({ financialRead, now = Date.now } = {}) {
  const financial = createPaidResearchReaders({ financialRead, now });
  return async function financialChanges(selection) {
    if (!validSelection(selection)) return invalid();
    let companies;
    try {
      const responses = await Promise.all(selection.tickers.map(ticker => financial.financials({ ticker, basis: selection.basis })));
      if (responses.some(response => !response.ok)) return unavailable();
      const envelopes = await Promise.all(responses.map(response => response.json()));
      if (new Set(envelopes.map(envelope => envelope.model.cik)).size !== envelopes.length)
        return x402DataError('DUPLICATE_ISSUER', 'Multiple requested tickers resolve to the same issuer. Select one ticker per CIK. This request is not charged.', 400);
      companies = envelopes.map(envelope => changesCompany(envelope, selection));
    } catch { return unavailable(); }
    if (companies.some(company => company.coverage.comparableMetrics === 0)) return noPairs();
    const stale = companies.some(company => company.stale);
    const payload = { schemaVersion: X402_FINANCIAL_CHANGES_VERSION, status: 'ready',
      selection: { tickers: [...selection.tickers], basis: selection.basis, comparison: selection.comparison, metrics: [...selection.metrics] },
      stale, companyCount: companies.length, companies,
      limitations: ['Every requested issuer requires a validated prepared model and at least one compatible requested comparison; an unavailable issuer aborts the entire purchase.',
        'Latest filed values in the prepared model include comparative revisions; these packets are not as-filed historical vintages.',
        'Observations retain actual reporting windows and reported source units. Calculated windows are labeled separately; fiscal ends can differ across issuers.',
        'Missing observations remain null. Incompatible reporting durations, known accounting scopes or units withhold change; null is never zero.',
        'Percentage growth is withheld for nonpositive prior values. Changes in percent-valued metrics are percentage-point differences, not percentage growth.',
        'This packet presents selected evidence and arithmetic changes. It does not establish causes, economic conclusions, or investment recommendations.'] };
    let body;
    try {
      body = selection.format === 'csv' ? `${columns.map(paidCsvCell).join(',')}\r\n${csvRows(payload).map(row => columns.map(column => paidCsvCell(row[column])).join(',')).join('\r\n')}\r\n` : JSON.stringify(payload);
    } catch { return unavailable(); }
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return x402DataError('PRODUCT_TOO_LARGE', 'The requested financial-change evidence exceeds the bounded delivery size. Select fewer tickers or metrics. This request is not charged.', 413);
    return new Response(body, { headers: { ...X402_DATA_HEADERS, 'X-Data-Stale': stale ? '1' : '0',
      'Access-Control-Expose-Headers': `${X402_DATA_HEADERS['Access-Control-Expose-Headers']}, X-Schema-Version, Content-Disposition`,
      'X-Schema-Version': payload.schemaVersion, 'Content-Type': selection.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      ...(selection.format === 'csv' ? { 'Content-Disposition': 'attachment; filename="edgar-financial-changes.csv"' } : {}) } });
  };
}
export const paidFinancialChangesReader = createPaidFinancialChangesReader();
