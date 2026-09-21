import { validFilingDate } from './filingsResearch.js';
import { validBrokerDealerDocumentName } from './brokerDealerDocuments.js';

const invalid = () => Object.assign(new Error('Choose one SEC CIK and a valid annual-report accession, archive, filing date or document.'), { status: 400 });

/** Keep chart requests small: document text belongs to the filing reader. */
export function brokerDealerResearchPayload(research) {
  if (!research) return null;
  const { company, filing, analysis, selectedDocument, documents, extraction, observedAt, coverage, status } = research;
  return { status, company: company ? { cik: company.cik, name: company.name, ticker: company.ticker } : null,
    filing, analysis, selectedDocument, documents, extraction, observedAt, coverage };
}

export function brokerDealerReportSelection(query) {
  const allowed = ['cik', 'accession', 'archive', 'filed', 'document'];
  if ([...query.keys()].some(key => !allowed.includes(key)) || allowed.some(key => query.getAll(key).length > 1 || query.has(key) && !query.get(key))) throw invalid();
  const cik = query.get('cik') || '';
  if (!/^(?!0+$)\d{1,10}$/.test(cik)) throw invalid();
  const accession = query.get('accession') || '', archive = query.get('archive') || '', filed = query.get('filed') || '', document = query.get('document') || '';
  if (accession && !/^\d{10}-\d{2}-\d{6}$/.test(accession) || archive && !/^CIK\d{10}-submissions-\d+\.json$/.test(archive)
    || filed && !validFilingDate(filed) || document && !validBrokerDealerDocumentName(document)
    || !accession && (archive || filed || document)) throw invalid();
  return { cik: cik.padStart(10, '0'), accession, archive, filed, document };
}
