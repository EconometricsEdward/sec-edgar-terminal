import { loadFilingsCompany, loadFilingsArchive } from './filingsResearchServer.js';
import { validFilingDate } from './filingsResearch.js';
import { isBrokerDealerAnnualForm } from './brokerDealerForms.js';
import { loadBrokerDealerDocument } from './brokerDealerDocuments.js';
import { analyzeBrokerDealerReport } from './brokerDealerAnalytics.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export async function readBrokerDealerFiling(company, filing, options = {}) {
  const document = await loadBrokerDealerDocument(company.cik, filing, options);
  const resolvedFiling = { ...filing, reportDate: document.cover.reportDate || filing.reportDate || '' };
  const analysis = analyzeBrokerDealerReport({ pages: document.pages, ...resolvedFiling, name: company.name, cik: company.cik, documentUrl: document.selectedDocument.url, extraction: document.extraction });
  analysis.limitations = [...new Set([...(analysis.limitations || []), ...(document.extraction.limitations || [])])];
  return { ...document, filing: resolvedFiling, analysis, observedAt: document.extractedAt };
}
export function createBrokerDealerResearchLoader({ loadCompany = loadFilingsCompany, loadArchive = loadFilingsArchive, readFiling = readBrokerDealerFiling } = {}) {
  return async function load(identifier, options = {}) {
    const { signal, accession = '', archive = '', filed = '', metadataOnly = false, refresh = false } = options;
    if (accession && !/^\d{10}-\d{2}-\d{6}$/.test(accession)) throw fail('Select a valid SEC accession.');
    if (archive && !/^CIK\d{10}-submissions-\d+\.json$/.test(archive)) throw fail('Select a valid SEC history archive.');
    if (filed && !validFilingDate(filed)) throw fail('Select a valid filing date.');
    const company = await loadCompany(identifier, { signal, refresh });
    const coverage = { archivesChecked: 0, totalArchives: company.archives?.length || 0, complete: false, failedArchives: [], omittedRecords: company.coverage?.omittedRecords || 0 };
    if (company.kind === 'fund') return { status: 'not-applicable', company, filing: null, filings: [], coverage };
    if (archive && !company.archives.some(item => item.name === archive)) throw fail('This SEC archive does not belong to the requested filer.');
    const rows = [...company.filings];
    let filing = accession ? rows.find(row => row.accession === accession) : null;
    const annual = () => rows.filter(row => isBrokerDealerAnnualForm(row.form)).sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession));
    // Resolve saved selections exactly; for latest discovery read only history
    // that might contain a newer report than the current candidate.
    const candidates = company.archives.filter(item => accession ? !filing && (archive ? item.name === archive : filed ? item.filingFrom <= filed && item.filingTo >= filed : true)
      : !annual().length || item.filingTo >= annual()[0].filingDate);
    for (const candidate of candidates.slice(0, 8)) {
      if (accession && filing) break;
      signal?.throwIfAborted();
      try {
        const result = await loadArchive(company.ticker, candidate.name, { signal, refresh });
        if (String(result.cik).padStart(10, '0') !== company.cik || result.archive?.name !== candidate.name) throw fail('The SEC history archive identity did not match.', 502);
        rows.push(...result.filings.map(row => ({ ...row, archive: candidate.name })));
        if (accession) filing = rows.find(row => row.accession === accession);
      } catch (error) { if (signal?.aborted) throw error; coverage.failedArchives.push(candidate.name); }
      coverage.archivesChecked++;
    }
    coverage.complete = !coverage.failedArchives.length && candidates.length <= 8 && !coverage.omittedRecords;
    const filings = [...new Map(annual().map(row => [row.accession, row])).values()];
    if (accession && (!filing || filed && filing.filingDate !== filed)) throw fail('This accession and filing date were not found in the checked SEC records. Select it from the filing history or load its exact archive.', !coverage.complete ? 502 : 404);
    if (filing && !isBrokerDealerAnnualForm(filing.form)) throw fail('The selected accession is not an X-17A-5 annual report.', 422);
    filing ||= filings[0] || null;
    if (!filing && !coverage.complete) throw fail('Broker-dealer annual report coverage could not be established because part of the SEC history was unavailable or exceeds the archive search limit. Retry or select an exact filing from its history.', 502);
    const metadata = { status: filing ? 'available' : 'not-applicable', company, filing, filings, coverage, observedAt: company.observedAt };
    if (metadataOnly || !filing) return metadata;
    const result = await readFiling(company, filing, options);
    return { ...metadata, ...result };
  };
}
export const loadBrokerDealerResearch = createBrokerDealerResearchLoader();
