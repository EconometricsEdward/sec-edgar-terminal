import { COMPARE_METRICS, COMPARE_VERSION, COMPARE_MAPPING_VERSION } from './compareResearch.js';
import { SEC_EVIDENCE_CONTINUITY } from './secEvidenceContinuity.js';

const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const references = (ids, catalog) => Array.isArray(ids)
  && ids.every(id => Number.isInteger(id) && id >= 0 && id < catalog.length);

/** Validate the selected issuer and every packed reference before decoding.
 * Shared by server cache reads and the browser so malformed evidence cannot
 * turn into apparently valid numbers with undefined sources.
 */
export function matchingCompareResult(value, { ticker, basis = 'annual', asOf = '' }) {
  if (!record(value) || value.packed !== true || value.version !== COMPARE_VERSION
    || value.mappingVersion !== COMPARE_MAPPING_VERSION
    || value.ticker !== String(ticker).toUpperCase() || value.basis !== basis || (value.asOf || '') !== asOf
    || !/^\d{10}$/.test(value.cik || '') || Number(value.cik) === 0
    || !['annual', 'quarter', 'ttm'].includes(basis)
    || !Array.isArray(value.periods) || value.periods.length > (basis === 'annual' ? 11 : 41)
    || !record(value.metrics) || !Array.isArray(value.sourceCatalog) || !Array.isArray(value.calculationCatalog)
    || !Number.isFinite(Date.parse(value.observedAt))) return false;
  if (!value.periods.every(period => record(period) && period.kind === basis && date(period.end)
    && (!period.start || (date(period.start) && period.start <= period.end))
    && (!period.filed || (date(period.filed) && (!asOf || period.filed <= asOf))))) return false;
  const transition = SEC_EVIDENCE_CONTINUITY[value.cik];
  const sourceCiks = new Set([value.cik, ...(transition && transition.source.filed <= (asOf || new Date().toISOString().slice(0, 10))
    ? transition.predecessorCiks : [])]);
  if (!value.sourceCatalog.every(source => record(source)
    && typeof source.value === 'number' && Number.isFinite(source.value)
    && (!source.filed || (date(source.filed) && (!asOf || source.filed <= asOf)))
    && (!source.sourceCik || sourceCiks.has(String(source.sourceCik).padStart(10, '0')))
    && (!source.documentUrl || validSourceUrl(source, value.cik)))) return false;
  if (!value.calculationCatalog.every(record)) return false;
  return COMPARE_METRICS.every(metric => Array.isArray(value.metrics[metric.key])
    && value.metrics[metric.key].length === value.periods.length)
    && Object.values(value.metrics).every(points => Array.isArray(points) && points.length === value.periods.length
      && points.every(point => record(point) && (point.value === null || (typeof point.value === 'number' && Number.isFinite(point.value)))
        && references(point.sourceIds, value.sourceCatalog) && references(point.calculationIds, value.calculationCatalog)));
}

function validSourceUrl(source, companyCik) {
  if (typeof source.documentUrl !== 'string') return false;
  try {
    const url = new URL(source.documentUrl);
    const match = /^\/Archives\/edgar\/data\/([1-9]\d{0,9})\/(\d{18})(?:\/|$)/.exec(url.pathname);
    return url.protocol === 'https:' && ['sec.gov', 'www.sec.gov'].includes(url.hostname)
      && !url.username && !url.password && !url.port && Boolean(match)
      && [companyCik, String(source.sourceCik || companyCik).padStart(10, '0')].includes(match[1].padStart(10, '0'))
      && /^\d{10}-\d{2}-\d{6}$/.test(source.accession || '')
      && match[2] === source.accession.replaceAll('-', '');
  } catch { return false; }
}
