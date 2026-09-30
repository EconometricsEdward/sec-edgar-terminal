import { ANALYSIS_VERSION, ANALYSIS_MAPPING_VERSION } from './analysisVersion.js';
import { validFinancialPeriodDates } from './financialPeriodDates.js';
import { ANALYSIS_DEBT_LABEL, ANALYSIS_INSURANCE_LENS_NOTE, analysisCashLabel, analysisCashScopeNote, analysisDebtScopeNote } from './analysisMappingPresentation.js';

const FROM_VERSION = 'analysis-mappings-v2';
const SCHEMA_VERSION = 'analysis-v1.4:context-v3';
const TO_VERSION = 'analysis-mappings-v3';
const CASH_TAGS = new Set(['CashAndDueFromBanks', 'Cash', 'CashAndCashEquivalentsAtCarryingValue']);
const REPORT = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
const ANNUAL = /^(10-K|20-F|40-F)(\/A)?$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const own = (object, key) => Object.hasOwn(object, key);
const record = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const duration = (start, end) => (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
const day = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const keysWithin = (value, keys) => record(value) && Object.keys(value).every(key => keys.has(key));
const knownKeys = (keys) => new Set(keys.split(' '));
const TOP_KEYS = knownKeys('version mappingVersion ticker name cik sic lens businessModel lensNote basis asOf observedAt periods metrics sourceCoverage note definitions revenueKey highlights filings packed sourceCatalog calculationCatalog');
const PERIOD_KEYS = knownKeys('accession asOf end filed fiscalStart form fp fy kind start ttmStart');
const POINT_KEYS = knownKeys('calculationIds category classification definitionFormula format formula label note observationPeriod observationRole reason sourceIds unit value');
const SOURCE_KEYS = knownKeys('accession classification documentUrl durationDays end factId filed form label revised revisionNote revisions scopeNote sourceCik sourceType start tag taxonomy unit value contextWarnings balanceClassification classificationEvidence');
const CALCULATION_KEYS = knownKeys('end formula key label start unit value');
const DEFINITION_KEYS = knownKeys('category format formula inputs key label order');

// Weak keys never extend the lifetime of evicted warm-cache payloads. Only
// deeply immutable input is memoized, so a mutable durable response cannot hide
// changed values, catalog references or a changed compatibility decision.
const immutableContent = new WeakMap();
function deeplyFrozen(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}
function freezeJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function fiscalWindow(period) {
  const bounds = period.fp === 'FY' || period.fp === 'Q4' ? [300, 400]
    : ({ Q1: [60, 120], Q2: [150, 220], Q3: [240, 320] })[period.fp];
  const days = duration(period.fiscalStart, period.end);
  return Boolean(bounds && day(period.fiscalStart) && days >= bounds[0] && days <= bounds[1]);
}
function safePeriod(period, basis, index, periods) {
  if (!keysWithin(period, PERIOD_KEYS) || !validFinancialPeriodDates(period)
    || !day(period.filed) || !REPORT.test(period.form) || !ACCESSION.test(period.accession)
    || !Number.isInteger(period.fy) || period.kind !== basis || period.asOf
    || period.ttmStart != null && (!day(period.ttmStart) || period.ttmStart > period.end)
    || !fiscalWindow(period) || index > 0 && periods[index - 1].end <= period.end) return false;
  if (ANNUAL.test(period.form) ? period.fp !== (basis === 'annual' ? 'FY' : 'Q4')
    : basis === 'annual' || !/^Q[123]$/.test(period.fp)) return false;
  if (basis === 'annual' || basis === 'ytd') return period.start === period.fiscalStart;
  if (basis === 'ttm' && period.start !== period.ttmStart) return false;
  if (period.start == null) return true;
  const days = duration(period.start, period.end);
  return basis === 'quarter' ? days >= 60 && days <= 120 : days >= 300 && days <= 400;
}
function validSource(source) {
  return keysWithin(source, SOURCE_KEYS) && validFinancialPeriodDates(source)
    && day(source.filed) && ACCESSION.test(source.accession) && REPORT.test(source.form)
    && Number.isFinite(source.value) && source.classification === 'reported'
    && ['us-gaap', 'ifrs-full'].includes(source.taxonomy)
    && typeof source.tag === 'string' && source.tag.length > 0 && typeof source.unit === 'string'
    && (source.start == null ? source.durationDays == null : source.durationDays === duration(source.start, source.end))
    && (source.revisions == null || Array.isArray(source.revisions) && source.revisions.every(revision => record(revision)
      && Number.isFinite(revision.value) && day(revision.filed) && ACCESSION.test(revision.accession) && REPORT.test(revision.form)));
}
function idsWithin(ids, catalog) {
  return Array.isArray(ids) && ids.every(id => Number.isSafeInteger(id) && id >= 0 && id < catalog.length);
}
function validPoint(point, period, data) {
  if (!keysWithin(point, POINT_KEYS) || !(point.value === null || Number.isFinite(point.value))
    || !['reported', 'calculated', 'unavailable', 'not_applicable'].includes(point.classification)
    || !idsWithin(point.sourceIds, data.sourceCatalog) || !idsWithin(point.calculationIds, data.calculationCatalog)
    || Number.isFinite(point.value) && (!point.sourceIds.length || !['reported', 'calculated'].includes(point.classification))
    || point.value === null && ['reported', 'calculated'].includes(point.classification)) return false;
  if (point.observationPeriod && (!validFinancialPeriodDates(point.observationPeriod)
    || !['instant', 'duration'].includes(point.observationPeriod.kind) || point.observationPeriod.end > period.end)) return false;
  if (point.sourceIds.some(id => data.sourceCatalog[id].end > period.end)) return false;
  if (point.classification !== 'reported') return true;
  if (point.sourceIds.length !== 1) return false;
  const source = data.sourceCatalog[point.sourceIds[0]];
  // Reported rows are a source value, including genuine zero, never an inferred
  // replacement. Derived points retain their original inputs and arithmetic.
  if (source.value !== point.value) return false;
  if (source.start == null) return true;
  if (source.end !== period.end) return false;
  // v3 additionally tightens direct YTD selection. This checks every retained
  // row, not just current highlights; other basis selectors did not change.
  return data.basis !== 'ytd' || source.start === period.fiscalStart && fiscalWindow({ ...period, fiscalStart: source.start });
}

/** The old selector chose the earliest anchor start with duration <=400. If
 * that earliest start passes the new season band, filtering cannot replace it
 * with another start. Fiscal-label reconciliation is also limited to old
 * out-of-band starts, so cannot alter an accepted period. Require this proof
 * for EVERY retained period. A null or
 * out-of-band start (including AMZN interim and GE's mislabeled 2020 quarter)
 * cannot be repaired from a prepared result: fail closed and await preparation.
 * No sources are fetched and no numeric financial values are recomputed. */
function compatibleV2(data) {
  if (ANALYSIS_VERSION !== SCHEMA_VERSION || ANALYSIS_MAPPING_VERSION !== TO_VERSION
    || !keysWithin(data, TOP_KEYS) || data.version !== SCHEMA_VERSION || data.mappingVersion !== FROM_VERSION
    || data.packed !== true || data.asOf !== '' || !/^\d{10}$/.test(data.cik || '')
    || typeof data.ticker !== 'string' || !['corporate', 'banking', 'insurance'].includes(data.lens)
    || !['annual', 'quarter', 'ytd', 'ttm'].includes(data.basis)
    || !Array.isArray(data.periods) || !data.periods.length || data.periods.length > (data.basis === 'annual' ? 11 : 41)
    || !data.periods.every((period, index) => safePeriod(period, data.basis, index, data.periods))
    || !record(data.metrics) || !Array.isArray(data.definitions) || data.definitions.length > 256
    || !Array.isArray(data.sourceCatalog) || data.sourceCatalog.length > 100000 || !data.sourceCatalog.every(validSource)
    || !Array.isArray(data.calculationCatalog) || data.calculationCatalog.length > 100000
    || !data.calculationCatalog.every(step => keysWithin(step, CALCULATION_KEYS) && Number.isFinite(step.value)
      && typeof step.formula === 'string' && validFinancialPeriodDates(step))
    || !Array.isArray(data.highlights) || !Array.isArray(data.filings)
    || typeof data.observedAt !== 'string' || !Number.isFinite(Date.parse(data.observedAt))) return false;
  const defined = new Set();
  for (const definition of data.definitions) {
    if (!keysWithin(definition, DEFINITION_KEYS) || typeof definition.key !== 'string' || defined.has(definition.key)
      || typeof definition.label !== 'string' || typeof definition.format !== 'string' || typeof definition.category !== 'string') return false;
    defined.add(definition.key);
  }
  if (!defined.has('cash') || !defined.has('totalDebt') || Object.keys(data.metrics).length !== defined.size
    || data.highlights.some(key => !defined.has(key)) || data.revenueKey != null && !defined.has(data.revenueKey)) return false;
  for (const [key, points] of Object.entries(data.metrics)) {
    if (!defined.has(key) || !Array.isArray(points) || points.length !== data.periods.length
      || !points.every((point, index) => validPoint(point, data.periods[index], data))) return false;
  }
  return data.metrics.cash.every(point => point.sourceIds.every(id => CASH_TAGS.has(data.sourceCatalog[id].tag)));
}

function adaptV2(data) {
  const result = structuredClone(data);
  const sourceVariants = new Map();
  const sourceWithNote = (id, scopeNote) => {
    const key = `${id}:${scopeNote}`;
    if (!sourceVariants.has(key)) {
      sourceVariants.set(key, result.sourceCatalog.length);
      result.sourceCatalog.push({ ...result.sourceCatalog[id], scopeNote });
    }
    return sourceVariants.get(key);
  };
  for (const [key, points] of Object.entries(result.metrics)) {
    if (result.lens === 'insurance' && key === 'operatingIncome') { delete result.metrics[key]; continue; }
    points.forEach((point, index) => {
      const debt = data.metrics.totalDebt[index];
      const mappedDebt = key === 'totalDebt' || ['debtAssets', 'reportedDebtEquity', 'netReportedDebt'].includes(key)
        && !own(point, 'definitionFormula');
      const debtNote = analysisDebtScopeNote(debt.note || '');
      point.sourceIds = point.sourceIds.map(id => CASH_TAGS.has(data.sourceCatalog[id].tag)
        ? sourceWithNote(id, analysisCashScopeNote(data.sourceCatalog[id].tag))
        : mappedDebt && debt.sourceIds.includes(id) ? sourceWithNote(id, debtNote) : id);
      if (key === 'cash' && !(data.basis === 'ttm' && !data.periods[index].start))
        point.note = analysisCashScopeNote(data.sourceCatalog[data.metrics.cash[index].sourceIds[0]]?.tag);
      if (key === 'totalDebt' && Number.isFinite(point.value)) point.note = debtNote;
    });
  }
  const cashTags = data.metrics.cash.filter(point => Number.isFinite(point.value))
    .flatMap(point => point.sourceIds.map(id => data.sourceCatalog[id].tag));
  result.definitions = result.definitions.filter(definition => result.lens !== 'insurance' || definition.key !== 'operatingIncome')
    .map(definition => definition.key === 'cash' ? { ...definition, label: analysisCashLabel(cashTags) }
      : definition.key === 'totalDebt' ? { ...definition, label: ANALYSIS_DEBT_LABEL } : definition);
  if (result.lens === 'insurance') {
    result.lensNote = ANALYSIS_INSURANCE_LENS_NOTE;
    result.highlights = result.highlights.filter(key => key !== 'operatingIncome');
  }
  result.mappingVersion = TO_VERSION;
  result.mappingCompatibility = { adapter: 'analysis-v2-presentation-v1', fromMappingVersion: FROM_VERSION,
    toMappingVersion: TO_VERSION, financialValuesRecomputed: false };
  return freezeJson(result);
}

/** Serving-only adapter. Preserve original storage, metadata and source clocks;
 * the preparation writer still sees v2 and performs a real v3 rebuild. */
export function adaptPreparedAnalysisEnvelope(envelope) {
  const data = envelope?.payload;
  if (data?.mappingVersion === ANALYSIS_MAPPING_VERSION) return envelope;
  if (!record(data) || data.mappingVersion !== FROM_VERSION) return null;
  let content = immutableContent.get(data);
  if (content === undefined) {
    content = compatibleV2(data) ? (() => {
      const payload = adaptV2(data);
      return Object.freeze({ payload, serializedPayload: JSON.stringify(payload) });
    })() : null;
    if (deeplyFrozen(data)) immutableContent.set(data, content);
  }
  return content ? { ...envelope, ...content } : null;
}
