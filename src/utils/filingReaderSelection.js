import { validFilingDate } from './filingsResearch.js';

const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
const archivePattern = /^CIK\d{10}-submissions-\d+\.json$/;
const selectionError = message => new Error(message);

/** Public deep links identify SEC metadata, never a caller-selected document URL. */
export function readFilingReaderSelection(search = '') {
  const params = new URLSearchParams(search);
  if (!params.has('accession')) return null;
  const one = key => {
    if (params.getAll(key).length > 1) throw selectionError('The filing link repeats a selection field. Open the filing from its company list.');
    return params.get(key) || '';
  };
  const accession = one('accession'), prior = one('prior');
  if (!accessionPattern.test(accession) || prior && !accessionPattern.test(prior)) throw selectionError('The filing link contains an invalid SEC accession.');
  const archive = one('archive'), priorArchive = one('priorArchive');
  if ([archive, priorArchive].some(value => value && !archivePattern.test(value))) throw selectionError('The filing link contains an invalid SEC archive.');
  const filed = one('filed'), priorFiled = one('priorFiled');
  if ([filed, priorFiled].some(value => value && !validFilingDate(value))) throw selectionError('The filing link contains an invalid filing date.');
  const view = one('view') || 'document', section = one('section') || 'all', query = one('query'), pageText = one('page') || '1';
  if (!['document', 'changes'].includes(view) || !/^(all|other|risk|mda|notes|8k:\d\.\d{2})$/.test(section)
    || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)
    || !/^\d{1,4}$/.test(pageText) || Number(pageText) < 1 || Number(pageText) > 1000)
    throw selectionError('The filing link contains unsupported reader filters.');
  return { accession, prior, archive, priorArchive, filed, priorFiled, view, section, query, page: Number(pageText) };
}

/** Resolve at most one explicit/date-matched archive per accession. The page's
 * existing company response and archive API have already checked SEC identity;
 * keep an independent CIK/manifest check before opening the document reader. */
export async function resolveFilingReaderSelection(selection, company, loadArchive) {
  if (!company || !/^\d{1,10}$/.test(String(company.cik)) || !Array.isArray(company.filings) || !Array.isArray(company.archives))
    throw selectionError('The company filing manifest is unavailable. Retry the company lookup.');
  const cik = String(company.cik).padStart(10, '0');
  const loaded = new Map();
  const locate = async (accession, archive, filed) => {
    if (!accessionPattern.test(accession)) throw selectionError('Select a valid SEC accession.');
    const owned = company.archives.filter(row => archivePattern.test(row.name || '') && row.name.startsWith(`CIK${cik}-`)
      && validFilingDate(row.filingFrom) && validFilingDate(row.filingTo));
    if (archive && !owned.some(row => row.name === archive)) throw selectionError('This archive does not belong to the selected company.');
    let filing = company.filings.find(row => row.accession === accession);
    if (!filing) {
      const candidates = archive ? owned.filter(row => row.name === archive)
        : filed ? owned.filter(row => row.filingFrom <= filed && row.filingTo >= filed) : [];
      if (candidates.length > 1) throw selectionError('Several SEC archives match this date. Load the correct archive in the filing list.');
      if (candidates.length === 1) {
        const name = candidates[0].name;
        if (!loaded.has(name)) {
          const result = await loadArchive(name);
          if (String(result?.cik || '').padStart(10, '0') !== cik || result?.archive?.name !== name || !Array.isArray(result?.filings))
            throw selectionError('The SEC archive did not match the selected company and archive.');
          loaded.set(name, result);
        }
        const record = loaded.get(name).filings.find(row => row.accession === accession);
        if (record) filing = { ...record, archive: name };
      }
    }
    if (!filing || !validFilingDate(filing.filingDate) || filed && filing.filingDate !== filed)
      throw selectionError('The selected filing was not found with matching dates in this company’s SEC manifest. Load its archive from the filing list.');
    return filing;
  };
  const filing = await locate(selection.accession, selection.archive, selection.filed);
  const prior = selection.prior ? await locate(selection.prior, selection.priorArchive, selection.priorFiled) : null;
  return { filing, prior, archives: Object.fromEntries(loaded), initialSelection: {
    view: selection.view, section: selection.section, query: selection.query, page: selection.page,
  } };
}
