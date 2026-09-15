/** Fixed public SEC passage-index boundary; shared by Node and the OIDC gateway. */
export const DISCLOSURE_INDEX_LIMITS = Object.freeze({
  documents: 600, corpusBytes: 104857600, documentBytes: 280000,
  characters: 180000, passages: 180, passageCharacters: 6000,
  retentionDays: 730, parserVersion: 1, candidateLimit: 120,
});
const encoder = new TextEncoder();
const cikPattern = /^(?!0000000000)\d{10}$/;
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
const docPattern = /^[\w][\w./-]*\.(?:htm|html|txt)$/i;
const forms = new Set(['10-K', '10-Q', '8-K', '20-F', '40-F', '6-K', 'S-1', 'S-3', 'S-4', 'DEF 14A', 'DEFM14A', 'N-CSR', 'NPORT-P']);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const known = (value, keys) => plainObject(value) && Object.keys(value).every(key => keys.includes(key));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
export function disclosureIndexDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function disclosureIndexIdentity({ cik, accession, primaryDoc }) {
  return cikPattern.test(cik || '') && accessionPattern.test(accession || '')
    && typeof primaryDoc === 'string' && primaryDoc.length <= 250 && docPattern.test(primaryDoc)
    && !primaryDoc.includes('..') && !primaryDoc.includes('//');
}
export function validDisclosureIndexDocument(document, passages, nowMs = Date.now()) {
  const L = DISCLOSURE_INDEX_LIMITS;
  if (!known(document, ['cik', 'accession', 'primaryDoc', 'ticker', 'companyName', 'form', 'filingDate', 'reportDate', 'textHash', 'parserVersion', 'sourceRetrievedAt', 'totalPassages', 'complete', 'preparedText'])
    || !disclosureIndexIdentity(document) || !forms.has(document.form?.replace(/\/A$/, ''))
    || !disclosureIndexDate(document.filingDate) || document.filingDate > new Date(nowMs).toISOString().slice(0, 10)
    || Date.parse(document.filingDate) < nowMs - (L.retentionDays + 1) * 86400000
    || !(document.reportDate === '' || disclosureIndexDate(document.reportDate))
    || typeof document.ticker !== 'string' || !/^[A-Z0-9.-]{0,15}$/.test(document.ticker)
    || typeof document.companyName !== 'string' || document.companyName.length < 1 || document.companyName.length > 250
    || !/^[a-f0-9]{64}$/.test(document.textHash || '') || document.parserVersion !== L.parserVersion
    || typeof document.sourceRetrievedAt !== 'string' || document.sourceRetrievedAt.length > 40
    || !Number.isFinite(Date.parse(document.sourceRetrievedAt)) || Date.parse(document.sourceRetrievedAt) > nowMs + 60000
    || !integer(document.totalPassages, 1, 200000) || typeof document.complete !== 'boolean'
    || !(document.preparedText === null || typeof document.preparedText === 'string' && document.preparedText.length <= L.characters)
    || !Array.isArray(passages) || !integer(passages.length, 1, L.passages)
    || passages.length > document.totalPassages) return false;
  const indices = new Set(); let characters = 0;
  for (const passage of passages) {
    if (!known(passage, ['index', 'sectionId', 'section', 'text']) || !integer(passage.index, 0, 199999) || indices.has(passage.index)
      || typeof passage.sectionId !== 'string' || !/^(?:other|risk|mda|notes|8k:\d\.\d{2})$/.test(passage.sectionId)
      || typeof passage.section !== 'string' || passage.section.length < 1 || passage.section.length > 100
      || typeof passage.text !== 'string' || passage.text.length < 1 || passage.text.length > L.passageCharacters
      || /[\u0000]/.test(passage.text)) return false;
    indices.add(passage.index); characters += passage.text.length;
  }
  if (document.complete && (passages.length !== document.totalPassages || !document.preparedText)) return false;
  // PostgreSQL's jsonb text representation adds separator spaces. Reserve a
  // conservative margin so any admitted compact payload fits its hard SQL cap.
  return characters <= L.characters && encoder.encode(JSON.stringify({ document, passages })).length <= L.documentBytes - 4096;
}
export function validDisclosureIndexSearch(value) {
  return known(value, ['terms', 'start', 'end', 'forms', 'ciks', 'tickers', 'section', 'offset', 'limit', 'parserVersion'])
    && Array.isArray(value.terms) && value.terms.length >= 1 && value.terms.length <= 16
    && value.terms.every(term => typeof term === 'string' && term.length >= 2 && term.length <= 120)
    && disclosureIndexDate(value.start) && disclosureIndexDate(value.end) && value.start <= value.end
    && Array.isArray(value.forms) && value.forms.length <= 26 && value.forms.every(form => forms.has(form?.replace(/\/A$/, '')))
    && Array.isArray(value.ciks) && value.ciks.length <= 100 && value.ciks.every(cik => cikPattern.test(cik))
    && Array.isArray(value.tickers) && value.tickers.length <= 100 && value.tickers.every(ticker => /^[A-Z0-9.-]{1,15}$/.test(ticker))
    && /^(?:all|other|risk|mda|notes|8k:\d\.\d{2})$/.test(value.section)
    && integer(value.offset, 0, 100000) && integer(value.limit, 1, DISCLOSURE_INDEX_LIMITS.candidateLimit)
    && value.parserVersion === DISCLOSURE_INDEX_LIMITS.parserVersion;
}
