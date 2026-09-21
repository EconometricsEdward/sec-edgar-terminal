import { loadFilingsCompany, loadFilingsArchive } from './filingsResearchServer.js';
import { validFilingDate } from './filingsResearch.js';
import { isBrokerDealerForm } from './brokerDealerForms.js';
import { loadBrokerDealerDocument } from './brokerDealerDocuments.js';
import { analyzeBrokerDealerReport } from './brokerDealerAnalytics.js';
import { classifyBrokerDealerDocument } from './brokerDealerClassification.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function createBrokerDealerFilingReader({ loadDocument = loadBrokerDealerDocument, analyzeReport = analyzeBrokerDealerReport } = {}) {
  return async function read(company, filing, options = {}) {
    const document = await loadDocument(company.cik, filing, options);
    const classification = document.classification || classifyBrokerDealerDocument({ pages: document.pages, cover: document.cover, filing, selectedDocument: document.selectedDocument, documentUrl: document.selectedDocument?.url });
    const resolvedFiling = { ...filing,
      reportDate: classification.period.end || (classification.family === 'periodic-focus' ? '' : filing.reportDate || ''),
      periodBegin: classification.period.start || '',
      classification: document.filingClassification || classifyBrokerDealerDocument({ filing, cover: document.cover }),
    };
    const analysis = analyzeReport({ pages: document.pages, ...resolvedFiling, classification, name: company.name, cik: company.cik, documentUrl: document.selectedDocument?.url, extraction: document.extraction });
    analysis.limitations = [...new Set([...(analysis.limitations || []), ...(document.extraction?.limitations || []), ...classification.limitations])];
    return { ...document, classification, filing: resolvedFiling, analysis, observedAt: document.extractedAt };
  };
}
export const readBrokerDealerFiling = createBrokerDealerFilingReader();
export function createBrokerDealerResearchLoader({ loadCompany = loadFilingsCompany, loadArchive = loadFilingsArchive, readFiling = readBrokerDealerFiling } = {}) {
  return async function load(identifier, options = {}) {
    const { signal, accession = '', archive = '', filed = '', metadataOnly = false, refresh = false, family = '' } = options;
    if (family && !['annual-report', 'periodic-focus'].includes(family)) throw fail('Select a supported broker-dealer document family.');
    if (accession && !/^\d{10}-\d{2}-\d{6}$/.test(accession)) throw fail('Select a valid SEC accession.');
    if (archive && !/^CIK\d{10}-submissions-\d+\.json$/.test(archive)) throw fail('Select a valid SEC history archive.');
    if (filed && !validFilingDate(filed)) throw fail('Select a valid filing date.');
    const company = await loadCompany(identifier, { signal, refresh });
    const coverage = { archivesChecked: 0, totalArchives: company.archives?.length || 0, complete: false, failedArchives: [], omittedRecords: company.coverage?.omittedRecords || 0 };
    if (company.kind === 'fund') return { status: 'not-applicable', company, filing: null, filings: [], coverage };
    if (archive && !company.archives.some(item => item.name === archive)) throw fail('This SEC archive does not belong to the requested filer.');
    const rows = [...company.filings];
    let filing = accession ? rows.find(row => row.accession === accession) : null;
    const reports = () => rows.filter(row => isBrokerDealerForm(row.form)).sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession));
    // Resolve saved selections exactly; for latest discovery read only history
    // that might contain a newer report than the current candidate.
    const candidates = company.archives.filter(item => accession ? !filing && (archive ? item.name === archive : filed ? item.filingFrom <= filed && item.filingTo >= filed : true)
      : family || !reports().length || item.filingTo >= reports()[0].filingDate);
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
    const filings = [...new Map(reports().map(row => [row.accession, row])).values()];
    if (accession && (!filing || filed && filing.filingDate !== filed)) throw fail('This accession and filing date were not found in the checked SEC records. Select it from the filing history or load its exact archive.', !coverage.complete ? 502 : 404);
    if (filing && !isBrokerDealerForm(filing.form)) throw fail('The selected accession is not an X-17A-5 filing.', 422);
    filing ||= filings[0] || null;
    if (!filing && !coverage.complete) throw fail('Broker-dealer filing coverage could not be established because part of the SEC history was unavailable or exceeds the archive search limit. Retry or select an exact filing from its history.', 502);
    const classifiedFilings = filings.map(row => ({ ...row, classification: classifyBrokerDealerDocument({ filing: row }) }));
    const metadata = { status: filing ? 'available' : 'not-applicable', company,
      filing: filing ? classifiedFilings.find(row => row.accession === filing.accession) : null,
      filings: classifiedFilings, coverage, observedAt: company.observedAt };
    if (metadataOnly || !filing) return metadata;
    if (!family) return { ...metadata, ...await readFiling(company, filing, options) };
    // A family-specific consumer (for example annual company exports) must not
    // silently substitute a newer periodic schedule or an unclassified file.
    const familyCandidates = accession ? [filing] : classifiedFilings; // Filing metadata cannot exclude another-family attachment in a mixed accession.
    const inspected = [];
    for (const candidate of familyCandidates.slice(0, 5)) {
      signal?.throwIfAborted();
      let result = await readFiling(company, candidate, options);
      const record = value => {
        const actual = value.classification || value.analysis?.classification;
        inspected.push({ accession: candidate.accession, document: value.selectedDocument?.name || '', family: actual?.family || 'unknown' });
        return actual?.family === family;
      };
      if (record(result)) return { ...metadata, ...result, coverage: { ...coverage, classificationInspected: inspected } };
      // Mixed accessions can contain both report families. Inspect at most two
      // alternative public attachments before moving to an older filing.
      if (!options.document) {
        const alternatives = (result.documents || []).filter(doc => doc.name !== result.selectedDocument?.name
          && /^(pdf|htm|html|txt)$/.test(doc.format || '')
          && (doc.classification?.family === family || !doc.classification || doc.classification.family === 'unknown'))
          .sort((a, b) => Number(b.classification?.family === family) - Number(a.classification?.family === family));
        for (const document of alternatives.slice(0, 2)) {
          signal?.throwIfAborted();
          result = await readFiling(company, candidate, { ...options, document: document.name });
          if (record(result)) return { ...metadata, ...result, coverage: { ...coverage, classificationInspected: inspected } };
        }
      }
      if (accession) throw fail('The selected attachment is not established as the requested broker-dealer document family.', 422);
    }
    throw fail('A report in the requested document family was not established in the checked public attachments. Select an exact filing or inspect the SEC originals.', familyCandidates.length > 5 || !coverage.complete ? 502 : 422);
  };
}
export const loadBrokerDealerResearch = createBrokerDealerResearchLoader();
