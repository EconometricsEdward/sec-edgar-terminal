import { CFTC_FAMILIES, CFTC_HISTORY_WINDOWS, CFTC_LAUNCH_CATALOG, CFTC_REPORT_BASIS, cftcDate } from './cftc.js';
import { selectExposureEvidence } from '../app/risk/exposureSelection.js';

const validDate = value => typeof value === 'string' && cftcDate(value) === value;
const RATE_MARKETS = new Set(['sofr', 'treasury', 'treasury-2y', 'treasury-10y', 'interest-rates']);
const QUESTIONS = {
  revenue: 'How do realized selling prices, volumes, contract terms, and hedges connect this disclosure to revenue?',
  'input-costs': 'How do procurement prices, inventories, supplier terms, hedges, and customer pricing affect margins?',
  borrowing: 'Which debt or funding balances reprice, on what dates, and how do their benchmarks and hedges compare?',
  investments: 'Which earning assets or holdings are affected, and how do duration, valuation, and hedges change the effect?',
  currencies: 'Which currency pair affects revenue, costs, debt, or translation, and what portion is hedged?',
};

/** Use the same annual/quarterly proof as the exposure map. A generic disclosure
 * remains visible without being assigned an unrelated futures contract. */
export function companyCftcEvidence(body, { ticker, asOf = '', basis = 'ttm', companyType = 'corporate', cik = '' }) {
  const fail = () => { throw new Error('The SEC market evidence does not match the selected company, filing cutoff, or source filings.'); };
  if (body?.schemaVersion !== 'edgar.company-exposure-map.v1' || body.ticker !== ticker || (body.asOf || '') !== asOf
    || !['ready', 'partial', 'no_matches', 'no_filing'].includes(body.status)
    || !/^\d{10}$/.test(body.cik || '') || (cik && String(cik).padStart(10, '0') !== body.cik)
    || !Array.isArray(body.rows) || !Array.isArray(body.sources)) fail();
  for (const row of body.rows) {
    if (typeof row.id !== 'string' || typeof row.marketLabel !== 'string' || !QUESTIONS[row.category] || !Array.isArray(row.evidence)) fail();
    for (const evidence of row.evidence) {
      if (typeof evidence.id !== 'string' || typeof evidence.text !== 'string' || !evidence.text.trim()
        || !validDate(evidence.filed) || !validDate(evidence.reportDate) || evidence.reportDate > evidence.filed
        || (asOf && evidence.filed > asOf)
        || (evidence.sourceCik != null && !/^\d{10}$/.test(evidence.sourceCik))
        || !body.sources.some(source => source.status === 'ready' && ['accession', 'url', 'form', 'filed', 'reportDate', 'role', 'sourceCik'].every(key => source[key] === evidence[key]))) fail();
    }
  }
  const institution = ['bank', 'banking', 'broker', 'financial', 'insurance'].includes(companyType);
  const priority = institution ? ['borrowing', 'investments', 'currencies', 'revenue', 'input-costs'] : ['revenue', 'input-costs', 'borrowing', 'currencies', 'investments'];
  const financialPriority = row => !institution ? 0 : RATE_MARKETS.has(row.marketId) ? row.category === 'borrowing' ? 0 : 1 : row.category === 'currencies' ? 2 : 3;
  const rows = selectExposureEvidence(body.rows, basis === 'annual' ? 'annual' : 'all').map(row => {
    const benchmark = row.benchmark;
    const catalog = benchmark && CFTC_LAUNCH_CATALOG.find(item => item.family === benchmark.family && item.code === benchmark.contract);
    const supported = !!catalog && ['named-reference', 'proxy'].includes(benchmark.fit)
      && CFTC_FAMILIES[benchmark.family]?.groups.some(group => group.id === benchmark.group);
    return {
      ...row,
      label: row.marketLabel,
      benchmark: supported ? benchmark : null,
      family: supported ? benchmark.family : '', contract: supported ? benchmark.contract : '', group: supported ? benchmark.group : '',
      fit: supported ? benchmark.fit : 'unmapped',
      reason: `${row.channelExplanation || ''} ${supported ? benchmark.basisLimit || '' : row.benchmarkUnavailableReason || 'The selected passages do not establish a supported CFTC benchmark.'}`.trim(),
      reviewQuestion: QUESTIONS[row.category],
    };
  }).sort((a, b) => financialPriority(a) - financialPriority(b)
    || Number(!!b.benchmark) - Number(!!a.benchmark)
    || Number(b.fit === 'named-reference') - Number(a.fit === 'named-reference')
    || priority.indexOf(a.category) - priority.indexOf(b.category)
    || a.label.localeCompare(b.label));
  const sources = body.sources.filter(source => basis !== 'annual' || source.role === 'annual');
  return { rows, sources, evidenceBasis: basis === 'annual' ? 'Latest eligible annual filing' : 'Latest eligible annual filing and newer quarterly update' };
}

/** Bind every displayed observation to the requested contract, group, basis,
 * report date and comparison horizon before creating notes or scenario links. */
export function matchesCompanyCftcHistory(value, { family, contract, group, window }) {
  const required = CFTC_HISTORY_WINDOWS[window];
  return !!required && !!value?.selected && value.selection?.contract === contract && value.selected.code === contract
    && value.selection?.group === group && value.selected.selectedGroup?.id === group
    && value.report_family === family && value.report_basis === CFTC_REPORT_BASIS
    && value.selection?.history_window === window && value.selection?.required_prior_reports === required
    && value.percentile?.required === required && validDate(value.selected.reportDate)
    && value.selection?.report_date === value.selected.reportDate && Array.isArray(value.history)
    && value.history.every(point => validDate(point.reportDate) && point.reportDate <= value.selected.reportDate)
    && value.history.some(point => point.reportDate === value.selected.reportDate);
}
