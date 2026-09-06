import { getItemsInfo } from './formItems.js';

export const FILINGS_SETTINGS = {
  query: '', family: 'all', form: 'all', start: '', end: '', item: '',
  amendments: 'include', sort: 'newest', status: 'all', view: 'list',
};
export const FILING_FAMILIES = [
  { id: 'annual', label: 'Annual reports' },
  { id: 'quarterly', label: 'Quarterly reports' },
  { id: 'current', label: 'Current reports' },
  { id: 'insider', label: 'Insider ownership' },
  { id: 'ownership', label: 'Institutional & beneficial ownership' },
  { id: 'proxy', label: 'Proxy & voting' },
  { id: 'registration', label: 'Offerings & registration' },
  { id: 'other', label: 'Other filings' },
];
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
const periodicPattern = /^(10-K|10-Q|10-KT|10-QT|20-F|40-F)$/;
export function validFilingDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function filingFamily(form = '') {
  const base = String(form).toUpperCase().replace(/\/A$/, '');
  if (/^(10-K|10-KT|20-F|40-F)$/.test(base)) return 'annual';
  if (/^(10-Q|10-QT)$/.test(base)) return 'quarterly';
  // A 6-K is a foreign issuer current report; it is not necessarily quarterly.
  if (/^(8-K|6-K)$/.test(base)) return 'current';
  if (/^[345]$/.test(base)) return 'insider';
  if (/^(SC 13[DG]|SCHEDULE 13[DG]|13[DFGH]|13F-|13H|N-PX)/.test(base)) return 'ownership';
  if (/^(DEF|DEFA|DEFC|DEFM|DEFN|DEFR|PRE|PREC|PREM|PRER|PX14A|DEFA14A|DFAN14A)/.test(base)) return 'proxy';
  if (/^(S-\d|F-\d|SF-\d|424|425|FWP|EFFECT|POS|RW$|AW$|D$|1-A|1-U|1-K|1-SA|8-A|10-12)/.test(base)) return 'registration';
  return 'other';
}
export function normalizeFilingsSettings(input = {}) {
  const result = { ...FILINGS_SETTINGS };
  const choices = {
    family: ['all', ...FILING_FAMILIES.map((f) => f.id)],
    amendments: ['include', 'exclude', 'only'], sort: ['newest', 'oldest', 'form', 'report'],
    status: ['all', 'queued', 'unreviewed', 'reviewed'], view: ['list', 'timeline', 'notebook'],
  };
  for (const [key, values] of Object.entries(choices)) if (values.includes(input[key])) result[key] = input[key];
  result.query = String(input.query || '').slice(0, 180);
  const form = String(input.form || 'all').trim().toUpperCase();
  result.form = form === 'ALL' ? 'all' : /^[A-Z0-9][A-Z0-9 .\/-]{0,29}$/.test(form) ? form : 'all';
  for (const key of ['start', 'end']) result[key] = validFilingDate(input[key]) ? input[key] : '';
  result.item = /^\d\.\d{2}$/.test(String(input.item || '')) ? String(input.item) : '';
  return result;
}
export function readFilingsSettings(search = '') {
  return normalizeFilingsSettings(Object.fromEntries(new URLSearchParams(search)));
}
export function filingPath(ticker, settings = {}) {
  const normalized = normalizeFilingsSettings(settings);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(normalized)) if (value !== FILINGS_SETTINGS[key]) params.set(key, value);
  return `/filings/${encodeURIComponent(String(ticker || '').trim().toUpperCase())}${params.size ? `?${params}` : ''}`;
}
export function validFilingDocument(value) {
  return typeof value === 'string' && value.length <= 240 && /^[\w][\w./-]*$/.test(value)
    && !value.includes('..') && !value.includes('//');
}
/** Normalize SEC's parallel arrays without restricting form types or inventing missing metadata. */
export function normalizeFilingRows(recent, cik) {
  if (!/^\d{1,10}$/.test(String(cik)) || Number(cik) <= 0 || !Array.isArray(recent?.accessionNumber)) return [];
  const rows = [];
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const accession = recent.accessionNumber[i];
    const form = recent.form?.[i];
    const filingDate = recent.filingDate?.[i];
    if (!accessionPattern.test(accession || '') || typeof form !== 'string' || !form.trim() || form.length > 40 || !validFilingDate(filingDate)) continue;
    const primaryDoc = validFilingDocument(recent.primaryDocument?.[i]) ? recent.primaryDocument[i] : '';
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}`;
    const normalizedForm = form.trim().toUpperCase();
    const size = recent.size?.[i];
    rows.push({
      accession, form: normalizedForm, filingDate,
      reportDate: validFilingDate(recent.reportDate?.[i]) ? recent.reportDate[i] : '',
      primaryDoc, primaryDescription: typeof recent.primaryDocDescription?.[i] === 'string' ? recent.primaryDocDescription[i].slice(0, 1000) : '',
      items: typeof recent.items?.[i] === 'string' ? recent.items[i].slice(0, 500) : '',
      documentUrl: primaryDoc ? `${base}/${primaryDoc}` : '',
      indexUrl: `${base}/${accession}-index.html`,
      isAmendment: normalizedForm.endsWith('/A'), family: filingFamily(normalizedForm),
      ...(typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { size } : {}),
    });
  }
  return mergeFilings(rows);
}
export function mergeFilings(...groups) {
  const byAccession = new Map();
  for (const filing of groups.flat()) {
    if (!filing || !accessionPattern.test(filing.accession || '')) continue;
    // Earlier groups are more recent SEC feeds and retain any richer metadata.
    const prior = byAccession.get(filing.accession);
    if (!prior) byAccession.set(filing.accession, filing);
    else if (!prior.primaryDoc && filing.primaryDoc) byAccession.set(filing.accession, { ...filing, ...prior, primaryDoc: filing.primaryDoc, documentUrl: filing.documentUrl });
  }
  return [...byAccession.values()].sort((a, b) => String(b.filingDate).localeCompare(String(a.filingDate)) || b.accession.localeCompare(a.accession));
}
export function filingReviewStatus(record = {}) {
  const reviewed = !!(record.reviewedAt || record.reviewed || record.status === 'reviewed');
  const queued = !!(record.queued || record.status === 'queued');
  return { reviewed, queued };
}
export function filterFilings(filings, settings = {}, records = {}) {
  const s = normalizeFilingsSettings(settings);
  const terms = s.query.toLowerCase().match(/"[^"]+"|\S+/g)?.map((term) => term.replace(/^"|"$/g, '')) || [];
  const filtered = filings.filter((filing) => {
    const amendment = filing.isAmendment ?? filing.form.endsWith('/A');
    if (s.family !== 'all' && (filing.family || filingFamily(filing.form)) !== s.family) return false;
    if (s.form !== 'all' && filing.form !== s.form) return false;
    if (s.start && filing.filingDate < s.start || s.end && filing.filingDate > s.end) return false;
    if (s.amendments === 'exclude' && amendment || s.amendments === 'only' && !amendment) return false;
    const itemInfo = /^8-K(?:\/A)?$/.test(filing.form) ? getItemsInfo(filing.items || '') : [];
    if (s.item && !itemInfo.some((item) => item.code === s.item)) return false;
    const status = filingReviewStatus(records[filing.accession]);
    if (s.status === 'queued' && !status.queued || s.status === 'reviewed' && !status.reviewed || s.status === 'unreviewed' && status.reviewed) return false;
    if (terms.length) {
      const text = [filing.form, filing.accession, filing.primaryDoc, filing.primaryDescription, filing.filingDate, filing.reportDate, ...itemInfo.flatMap((item) => [item.code, item.label])].join(' ').toLowerCase();
      if (!terms.every((term) => text.includes(term))) return false;
    }
    return true;
  });
  return filtered.sort((a, b) => {
    const date = b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession);
    return s.sort === 'oldest' ? -date : s.sort === 'form' ? a.form.localeCompare(b.form, undefined, { numeric: true }) || date
      : s.sort === 'report' ? String(b.reportDate || '').localeCompare(String(a.reportDate || '')) || date : date;
  });
}
export function summarizeFilingMonths(filings) {
  const months = new Map();
  for (const filing of filings) {
    if (!validFilingDate(filing.filingDate)) continue;
    const month = filing.filingDate.slice(0, 7);
    const entry = months.get(month) || { month, count: 0, amendments: 0, families: {} };
    const family = filing.family || filingFamily(filing.form);
    entry.count++;
    entry.amendments += Number(filing.isAmendment ?? filing.form.endsWith('/A'));
    entry.families[family] = (entry.families[family] || 0) + 1;
    months.set(month, entry);
  }
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
}
export function summarizeFilingFamilies(filings) {
  return FILING_FAMILIES.map((family) => ({ ...family, count: filings.filter((f) => (f.family || filingFamily(f.form)) === family.id).length }));
}
export function selectFilingBaseline(current, filings, { comparison = 'previous' } = {}) {
  if (!current) return { prior: null, kind: 'unavailable', reason: 'Select a filing to compare.' };
  const baseForm = current.form.replace(/\/A$/, '');
  const older = mergeFilings(filings).filter((f) => f.accession !== current.accession && f.primaryDoc
    && f.form.replace(/\/A$/, '') === baseForm
    && (f.filingDate < current.filingDate || f.filingDate === current.filingDate && f.accession < current.accession));
  if (current.isAmendment ?? current.form.endsWith('/A')) {
    const prior = validFilingDate(current.reportDate) ? older.find((f) => f.reportDate === current.reportDate) : null;
    return { prior: prior || null, kind: 'amendment', reason: prior
      ? 'Amendment compared with the earlier filing for the same reporting period. Partial amendments can omit unchanged material.'
      : 'No earlier filing for the same reporting period is loaded. Load the relevant archive or open the SEC filing index.' };
  }
  if (!periodicPattern.test(baseForm)) return { prior: null, kind: 'event', reason: 'Event, ownership, proxy and offering filings are not automatically compared with unrelated events.' };
  const candidates = older.filter((f) => !f.form.endsWith('/A') && validFilingDate(f.reportDate) && f.reportDate < current.reportDate);
  const prior = comparison === 'year'
    ? candidates.find((f) => Math.abs((Date.parse(current.reportDate) - Date.parse(f.reportDate)) / 86400000 - 365.25) <= 40)
    : [...candidates].sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.filingDate.localeCompare(a.filingDate))[0];
  return { prior: prior || null, kind: comparison === 'year' ? 'annual-season' : 'previous-period', reason: prior
    ? comparison === 'year' ? 'Original report of the same form and reporting season one year earlier.' : 'Previous original report of the same form by reporting-period end; quarterly periods may differ.'
    : 'No comparable original report is loaded. Load earlier history to check for a matching reporting period.' };
}
