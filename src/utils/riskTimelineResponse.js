// Keep the client contract independent of the SEC disclosure parser.
export const RISK_TIMELINE_RESPONSE_VERSION = 'risk-timeline-v1';

const MAX_RESPONSE_BYTES = 65_536;
const FORMS = ['10-K', '10-Q', '20-F', '40-F'];
const CATEGORY_LABELS = {
  'customer-concentration': 'Customer concentration',
  covenants: 'Covenants',
  collateral: 'Collateral',
};
const TOPIC_STATUSES = ['missing', 'unchanged', 'differed', 'uncompared', 'unavailable'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const keysWithin = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const text = (value, max = MAX_RESPONSE_BYTES) => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = value => Number.isSafeInteger(value) && value >= 0;

function metadata(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > 8) return false;
  if (Array.isArray(value)) return value.every(item => metadata(item, depth + 1));
  return record(value) && Object.values(value).every(item => metadata(item, depth + 1));
}

export const isRiskTimelineDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function checkedAt(value, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    || !isRiskTimelineDate(value.slice(0, 10)) || value.slice(0, 10) > today) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
}

function normalizedCik(value) {
  const digits = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof digits === 'string' && /^\d{1,10}$/.test(digits) && Number(digits) > 0
    ? digits.padStart(10, '0') : null;
}

function secSource(value, cik, accession, allowFragment = false) {
  if (!text(value, 2_048) || value.trim() !== value || /[\s\\]/.test(value)) return null;
  // Check the original string before URL parsing can normalize dot segments.
  const rawPath = value.split(/[?#]/, 1)[0];
  if (rawPath.includes('..') || /%2e|%2f|%5c/i.test(rawPath)) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || !['www.sec.gov', 'sec.gov'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.port || parsed.search
    || value.split('#', 1)[0].includes('?')
    || !allowFragment && value.includes('#') || value.includes('#') && !parsed.hash) return null;
  if (parsed.hash && (!/^#[A-Za-z0-9_.:~!$&'()*+,;=@/?%-]+$/.test(parsed.hash)
    || /%(?![0-9a-f]{2})/i.test(parsed.hash) || parsed.hash.length > 256)) return null;
  const prefix = `/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  const filename = parsed.pathname.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:htm|html|txt)$/i.test(filename) || filename.includes('..')) return null;
  return parsed.pathname;
}

function topic(value) {
  if (!record(value) || !keysWithin(value, ['status', 'matches', 'sectionCoverage', 'comparedTo',
    'comparisonError', 'unpairedMatches', 'limited', 'omittedMatches'])
    || !TOPIC_STATUSES.includes(value.status) || !count(value.matches)) return false;
  if (own(value, 'sectionCoverage') && (!Array.isArray(value.sectionCoverage) || value.sectionCoverage.length > 32
    || !value.sectionCoverage.every(item => text(item, 100)))) return false;
  if (own(value, 'unpairedMatches') && !count(value.unpairedMatches)
    || own(value, 'omittedMatches') && !count(value.omittedMatches)
    || own(value, 'limited') && typeof value.limited !== 'boolean'
    || own(value, 'comparisonError') && !text(value.comparisonError, 500)) return false;
  if (own(value, 'comparedTo')) {
    const prior = value.comparedTo;
    if (!record(prior) || !keysWithin(prior, ['accession', 'reportDate', 'filed', 'form', 'gapDays'])
      || typeof prior.accession !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(prior.accession) || !FORMS.includes(prior.form)
      || !isRiskTimelineDate(prior.reportDate) || !isRiskTimelineDate(prior.filed)
      || prior.reportDate > prior.filed || !count(prior.gapDays)) return false;
  }
  return true;
}

function filing(value, cik, basis, cutoff) {
  if (!record(value) || !keysWithin(value, ['accession', 'form', 'filed', 'reportDate', 'url', 'status', 'topics', 'error'])
    || typeof value.accession !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(value.accession) || !FORMS.includes(value.form)
    || basis === 'annual' && value.form === '10-Q'
    || !isRiskTimelineDate(value.reportDate) || !isRiskTimelineDate(value.filed)
    || value.reportDate > value.filed || value.filed > cutoff
    || !secSource(value.url, cik, value.accession) || !['reviewed', 'fetch-failed'].includes(value.status)
    || !record(value.topics) || Object.keys(value.topics).length !== 3
    || !Object.keys(CATEGORY_LABELS).every(category => own(value.topics, category) && topic(value.topics[category]))
    || own(value, 'error') && !text(value.error, 500)) return false;
  return value.status !== 'fetch-failed' || Object.values(value.topics)
    .every(item => item.status === 'unavailable' && item.matches === 0);
}

function comparisonsBound(filings) {
  return filings.every(current => Object.values(current.topics).every(item => {
    if (!own(item, 'comparedTo')) return true;
    const prior = filings.find(candidate => candidate.accession === item.comparedTo.accession);
    return current.status === 'reviewed' && prior?.status === 'reviewed'
      && prior.form === current.form && item.comparedTo.form === prior.form
      && item.comparedTo.reportDate === prior.reportDate && item.comparedTo.filed === prior.filed
      && prior.reportDate < current.reportDate && prior.filed <= current.filed
      && item.comparedTo.gapDays === (Date.parse(current.reportDate) - Date.parse(prior.reportDate)) / 86_400_000;
  }));
}

function side(value, filings, cik) {
  if (!record(value) || !keysWithin(value, ['end', 'filed', 'form', 'evidence', 'sourceUrls'])
    || !isRiskTimelineDate(value.end) || !isRiskTimelineDate(value.filed) || value.end > value.filed
    || !FORMS.includes(value.form) || !Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 2
    || !Array.isArray(value.sourceUrls) || value.sourceUrls.length < 1 || value.sourceUrls.length > 2) return null;
  const candidates = filings.filter(item => item.status === 'reviewed' && item.reportDate === value.end
    && item.filed === value.filed && item.form === value.form);
  const boundFiling = candidates.find(item => {
    const boundPath = secSource(item.url, cik, item.accession);
    return value.sourceUrls.every(url => secSource(url, cik, item.accession, true) === boundPath)
      && value.evidence.every(itemEvidence => record(itemEvidence)
        && keysWithin(itemEvidence, ['text', 'url', 'section', 'paragraphIndex', 'truncated'])
        && text(itemEvidence.text, 600) && text(itemEvidence.section, 100)
        && count(itemEvidence.paragraphIndex) && typeof itemEvidence.truncated === 'boolean'
        && secSource(itemEvidence.url, cik, item.accession, true) === boundPath);
  });
  return boundFiling || null;
}

/** Bind every narrative excerpt to the original SEC reports selected by the client. */
export function matchesRiskTimelineResponse(body, ticker, basis = 'ttm', asOf = '', cik) {
  try {
    const serialized = JSON.stringify(body);
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) return false;
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = asOf || today;
    if (!['ttm', 'annual'].includes(basis) || !text(ticker, 32)
      || asOf != null && asOf !== '' && (!isRiskTimelineDate(asOf) || asOf > today)
      || !record(body) || !keysWithin(body, ['schemaVersion', 'ticker', 'basis', 'asOf', 'cik', 'companyName',
        'checkedAt', 'status', 'events', 'filings', 'coverage', 'limitations', 'message'])
      || body.schemaVersion !== RISK_TIMELINE_RESPONSE_VERSION || body.ticker !== ticker || body.basis !== basis
      || !own(body, 'asOf') || body.asOf !== null && !isRiskTimelineDate(body.asOf)
      || (body.asOf ?? '') !== (asOf ?? '') || typeof body.cik !== 'string' || !/^\d{10}$/.test(body.cik) || Number(body.cik) === 0
      || cik != null && normalizedCik(cik) !== body.cik
      || !text(body.companyName, 300) || !checkedAt(body.checkedAt, today)
      || !['ready', 'partial', 'no_filing', 'no_changes'].includes(body.status)
      || !Array.isArray(body.events) || body.events.length > 12
      || !Array.isArray(body.filings) || body.filings.length > 4
      || !record(body.coverage) || !metadata(body.coverage) || !Array.isArray(body.limitations)
      || !body.limitations.every(item => typeof item === 'string')
      || own(body, 'message') && !text(body.message, 1_000)) return false;
    if (!body.filings.every(item => filing(item, body.cik, basis, cutoff))
      || new Set(body.filings.map(item => item.accession)).size !== body.filings.length
      || new Set(body.filings.map(item => item.reportDate)).size !== body.filings.length
      || !comparisonsBound(body.filings)) return false;
    if (body.status === 'no_filing') return body.filings.length === 0 && body.events.length === 0;
    if (body.filings.length === 0
      || body.status === 'no_changes' && (body.events.length !== 0 || !body.filings.some(item => item.status === 'reviewed'))
      || body.status === 'ready' && (body.events.length === 0 || body.filings.some(item => item.status === 'fetch-failed'))) return false;
    let evidenceCount = 0;
    const eventIds = new Set();
    return body.events.every(event => {
      if (!record(event) || !keysWithin(event, ['id', 'kind', 'date', 'dateBasis', 'category', 'categoryLabel',
        'direction', 'title', 'scope', 'criterion', 'before', 'after'])
        || !text(event.id, 256) || eventIds.has(event.id) || event.kind !== 'disclosure'
        || event.dateBasis !== 'period-end' || event.direction !== 'review'
        || !own(CATEGORY_LABELS, event.category) || event.categoryLabel !== CATEGORY_LABELS[event.category]
        || !text(event.title, 600) || !text(event.scope, 1_000)
        || own(event, 'criterion') && !text(event.criterion, 1_000)
        || !isRiskTimelineDate(event.date)) return false;
      const beforeFiling = side(event.before, body.filings, body.cik);
      const afterFiling = side(event.after, body.filings, body.cik);
      if (!beforeFiling || !afterFiling || event.before.form !== event.after.form
        || event.before.end >= event.after.end || event.before.filed > event.after.filed || event.date !== event.after.end
        || afterFiling.topics[event.category].status !== 'differed') return false;
      evidenceCount += event.before.evidence.length + event.after.evidence.length;
      eventIds.add(event.id);
      return evidenceCount <= 24;
    });
  } catch {
    return false;
  }
}
