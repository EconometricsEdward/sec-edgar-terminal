import { loadFilingsCompany, loadFilingsArchive, normalizeFilingsIdentifier } from './filingsResearchServer.js';
import { validFilingDate } from './filingsResearch.js';
import { isBrokerDealerAnnualForm } from './brokerDealerForms.js';

export const BROKER_DEALER_DEFAULT_PERIODS = 5;
export const BROKER_DEALER_MAX_PERIODS = 10;
const MAX_ARCHIVES = 8;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const ARCHIVE = /^CIK\d{10}-submissions-\d+\.json$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const newestFiled = (a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession);
const periodOrder = (a, b) => (b.reportDate || b.filingDate).localeCompare(a.reportDate || a.filingDate) || newestFiled(a, b);

/** Metadata requests never open PDFs. The reader resolves one exact filing at a
 * time, allowing the first statement to render while older reports load. */
export function brokerDealerHistorySettings(params) {
  const allowed = new Set(['cik', 'ticker', 'limit', 'from', 'to', 'archive', 'accession']);
  for (const [key, value] of params) {
    if (!allowed.has(key)) throw fail('Unrecognized broker-dealer history query parameter.');
    if (key !== 'accession' && params.getAll(key).length > 1) throw fail('Supply each history filter only once.');
    if (!value.trim()) throw fail('History query parameters must not be blank.');
  }
  if (params.has('cik') && params.has('ticker')) throw fail('Identify the filer with either a SEC CIK or a ticker.');
  if (params.has('limit') && !/^(?:[1-9]|10)$/.test(params.get('limit'))) throw fail('Select between 1 and 10 reporting periods.');
  const identifier = normalizeFilingsIdentifier(params.get('cik') ?? params.get('ticker'));
  return { identifier, ...validateHistoryOptions({
    limit: params.get('limit') ?? BROKER_DEALER_DEFAULT_PERIODS,
    from: params.get('from') ?? '', to: params.get('to') ?? '', archive: params.get('archive') ?? '',
    accessions: params.getAll('accession').flatMap(value => value.split(',')),
  }, identifier) };
}

function validateHistoryOptions(options = {}, identifier) {
  if (!normalizeFilingsIdentifier(identifier)) throw fail('Provide a valid SEC CIK or exact company ticker.');
  const limit = Number(options.limit ?? BROKER_DEALER_DEFAULT_PERIODS);
  if (!Number.isInteger(limit) || limit < 1 || limit > BROKER_DEALER_MAX_PERIODS) throw fail('Select between 1 and 10 reporting periods.');
  const from = options.from || '', to = options.to || '', archive = options.archive || '';
  if ([from, to].some(date => date && !validFilingDate(date)) || from && to && from > to) throw fail('Select a valid reporting-period date range.');
  if (archive && !ARCHIVE.test(archive)) throw fail('Select a valid SEC history archive.');
  const supplied = options.accessions ?? (options.accession ? [options.accession] : []);
  if (!Array.isArray(supplied) || supplied.length > BROKER_DEALER_MAX_PERIODS || supplied.some(value => typeof value !== 'string' || !ACCESSION.test(value))) throw fail('Select up to 10 valid SEC accessions.');
  const accessions = [...new Set(supplied)];
  if (accessions.length && (from || to)) throw fail('Select exact filings or a reporting-period date range.');
  return { limit, from, to, archive, accessions };
}

function filingLinks(cik, filing) {
  const params = new URLSearchParams({ ticker: cik, accession: filing.accession, filed: filing.filingDate });
  if (filing.archive) params.set('archive', filing.archive);
  const analysisParams = new URLSearchParams(params);
  analysisParams.delete('ticker');
  return { ...filing,
    // A future or absent period is unknown, never a filing-date surrogate.
    reportDate: validFilingDate(filing.reportDate) && filing.reportDate <= filing.filingDate ? filing.reportDate : '',
    readerHref: `/api/filings-reader?${params}&view=analytics`,
    researchHref: `/api/broker-dealer/report?${new URLSearchParams({ cik, ...Object.fromEntries(analysisParams) })}`,
    analysisHref: `/analysis/${cik}?${analysisParams}`,
  };
}

/** Amendments replace the selected version of a known period; originals remain
 * available in versions and in the filing catalog for an exact-accession view. */
export function groupBrokerDealerPeriods(filings = []) {
  const groups = new Map();
  for (const filing of [...filings].sort(newestFiled)) {
    const periodKey = filing.reportDate || `accession:${filing.accession}`;
    if (!groups.has(periodKey)) groups.set(periodKey, []);
    groups.get(periodKey).push(filing);
  }
  return [...groups].map(([periodKey, versions]) => ({ ...versions[0], periodKey, versions,
    amendmentCount: versions.filter(filing => filing.form.endsWith('/A')).length,
  })).sort(periodOrder);
}

export function createBrokerDealerHistoryLoader({ loadCompany = loadFilingsCompany, loadArchive = loadFilingsArchive } = {}) {
  return async function load(identifier, options = {}) {
    const settings = validateHistoryOptions(options, identifier);
    const { signal, refresh = false } = options;
    const { accessions, archive, from, to, limit } = settings;
    const company = await loadCompany(identifier, { signal, refresh });
    const archives = [...(company.archives || [])].sort((a, b) => b.filingTo.localeCompare(a.filingTo) || a.name.localeCompare(b.name));
    if (archive && !archives.some(item => item.name === archive)) throw fail('This SEC archive does not belong to the requested filer.');
    const rows = [...(company.filings || [])];
    const checked = new Set(), failedArchives = [];
    let omittedRecords = company.coverage?.omittedRecords || 0;
    const omittedArchives = company.coverage?.omittedArchives || 0;
    const catalog = () => [...new Map(rows.filter(row => isBrokerDealerAnnualForm(row.form)).sort(newestFiled)
      .map(row => [row.accession, filingLinks(company.cik, row)])).values()];
    const matchingPeriods = () => groupBrokerDealerPeriods(catalog()).filter(row => !from && !to || row.reportDate && (!from || row.reportDate >= from) && (!to || row.reportDate <= to));
    const needed = candidate => {
      if (archive) return candidate.name === archive;
      if (accessions.length) return accessions.some(accession => !rows.some(row => row.accession === accession));
      // A filing cannot report a period ending after it was filed. The filing
      // range therefore safely rules out archives older than the fifth period.
      if (from && candidate.filingTo < from) return false;
      const selected = matchingPeriods().slice(0, limit);
      return selected.length < limit || candidate.filingTo >= (selected.at(-1).reportDate || selected.at(-1).filingDate);
    };
    for (const candidate of archives) {
      if (!needed(candidate)) continue;
      if (checked.size >= MAX_ARCHIVES) break;
      signal?.throwIfAborted();
      checked.add(candidate.name);
      try {
        const result = await loadArchive(company.ticker, candidate.name, { signal, refresh });
        if (String(result.cik).padStart(10, '0') !== company.cik || result.archive?.name !== candidate.name) throw fail('The SEC history archive identity did not match.', 502);
        rows.push(...result.filings.map(row => ({ ...row, archive: candidate.name })));
        omittedRecords += result.coverage?.omittedRecords || result.omittedRecords || 0;
      } catch (error) {
        if (signal?.aborted) throw error;
        failedArchives.push(candidate.name);
      }
    }
    const filings = catalog(), periods = groupBrokerDealerPeriods(filings);
    const remaining = archives.filter(item => !checked.has(item.name));
    const unknownPeriods = filings.filter(row => !row.reportDate).length;
    const selectionComplete = !failedArchives.length && !omittedRecords && !omittedArchives
      && !remaining.some(needed) && (!(from || to) || !unknownPeriods);
    const coverage = { complete: selectionComplete, selectionComplete,
      allHistoryLoaded: !remaining.length && !failedArchives.length && !omittedRecords && !omittedArchives,
      archivesChecked: checked.size, totalArchives: archives.length, remainingArchives: remaining.length,
      failedArchives, omittedRecords, omittedArchives, unknownPeriods,
    };
    let selectedFilings;
    if (accessions.length) {
      const unrelated = accessions.find(accession => rows.some(row => row.accession === accession && !isBrokerDealerAnnualForm(row.form)));
      if (unrelated) throw fail('The selected accession is not an X-17A-5 annual report.', 422);
      selectedFilings = accessions.map(accession => filings.find(row => row.accession === accession));
      if (selectedFilings.some(row => !row)) throw fail('An exact accession was not found in the checked SEC records. Select its history archive or retry incomplete history.', selectionComplete ? 404 : 502);
      selectedFilings.sort(periodOrder);
    } else selectedFilings = matchingPeriods().slice(0, limit);
    if (!filings.length && !selectionComplete) throw fail('SEC filing history is incomplete. Retry to discover broker-dealer reports.', 502);
    return {
      status: filings.length ? 'available' : 'not-applicable',
      company: { cik: company.cik, ticker: company.ticker, name: company.name, kind: company.kind, sic: company.sic || '', sicDescription: company.sicDescription || '', submissionsUrl: company.submissionsUrl },
      filings, periods, selectedFilings, selection: settings, coverage,
      archives: archives.map(item => ({ ...item, loaded: checked.has(item.name) && !failedArchives.includes(item.name),
        historyHref: `/api/broker-dealer/history?${new URLSearchParams({ cik: company.cik, archive: item.name, limit: String(limit) })}` })),
      observedAt: company.observedAt,
    };
  };
}

export const loadBrokerDealerHistory = createBrokerDealerHistoryLoader();
