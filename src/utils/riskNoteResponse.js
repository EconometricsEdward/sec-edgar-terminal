// Keep this small client contract separate from the SEC document parser.
export const RISK_NOTE_RESPONSE_VERSION = 'risk-note-facts-v3';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const fact = value => record(value) && Number.isFinite(value.value) && date(value.end)
  && (value.start == null || date(value.start) && value.start <= value.end)
  && typeof value.contextId === 'string' && typeof value.sourceUrl === 'string' && typeof value.tag === 'string';

/** Bind note evidence to the company, reporting basis and cutoff being shown.
 * Empty source coverage is valid; a payload for another selection is not.
 */
export function matchesRiskNoteResponse(body, ticker, basis = 'ttm', asOf = '') {
  if (!record(body) || body.schemaVersion !== RISK_NOTE_RESPONSE_VERSION
    || body.ticker !== ticker || body.basis !== basis || (body.asOf ?? '') !== (asOf ?? '')
    || typeof body.checkedAt !== 'string' || !date(body.checkedAt.slice(0, 10))
    || !['ready', 'no_matches', 'no_filing'].includes(body.status) || !Array.isArray(body.rows)
    || !record(body.coverage) || !Array.isArray(body.limitations) || !body.limitations.every(item => typeof item === 'string')) return false;
  if (body.status === 'no_filing') return body.filing === null && body.rows.length === 0;
  const filing = body.filing;
  if (!record(filing) || !date(filing.reportDate) || !date(filing.filed)
    || typeof filing.url !== 'string' || typeof filing.accession !== 'string'
    || !['10-K', '10-Q', '20-F', '40-F'].includes(filing.form)
    || basis === 'annual' && filing.form === '10-Q'
    || asOf && filing.filed > asOf
    || (body.status === 'ready') !== (body.rows.length > 0)) return false;
  return body.rows.every(row => record(row) && typeof row.id === 'string' && typeof row.kind === 'string'
    && typeof row.category === 'string' && typeof row.label === 'string' && typeof row.unit === 'string'
    && Array.isArray(row.dimensions) && row.dimensions.every(dimension => record(dimension)
      && typeof dimension.axis === 'string' && typeof dimension.member === 'string' && typeof dimension.label === 'string')
    && fact(row.current) && row.current.end === filing.reportDate
    && (row.prior === null || fact(row.prior) && row.prior.end < row.current.end));
}
