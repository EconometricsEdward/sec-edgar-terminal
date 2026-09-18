import { CFTC_FAMILIES, CFTC_LAUNCH_CATALOG, CFTC_REPORT_BASIS } from '../../utils/cftc.js';
import { matchesExposureRequest, selectExposureEvidence } from './exposureSelection.js';

const CHANNELS = {
  borrowing: { label: 'Funding & refinancing', effect: 'Interest expense and refinancing', connection: 'Borrowing terms determine how a market-rate change reaches interest costs and cash available for obligations.' },
  investments: { label: 'Investment assets', effect: 'Investment income and asset values', connection: 'Market changes can affect investment income, asset values and the resources available to meet obligations.' },
  currencies: { label: 'Currency exposure', effect: 'Cash flows and currency translation', connection: 'Currency moves can affect receipts, payments and translated earnings. The currency pair and hedges determine the financial effect.' },
  revenue: { label: 'Revenue exposure', effect: 'Revenue and cash generation', connection: 'Realized selling prices affect the cash generated to meet fixed obligations. Production, pricing terms and hedges change the transmission.' },
  'input-costs': { label: 'Input costs', effect: 'Margins and cash generation', connection: 'Purchase costs affect operating margins and cash available for obligations. Pass-through pricing, inventories and hedges can offset part of that effect.' },
};
const RATE_MARKETS = new Set(['sofr', 'treasury', 'treasury-2y', 'treasury-10y', 'interest-rates']);

/** Keep the benchmark attached to proof in the selected filing basis. */
export function riskProfileExposureRows(body, { ticker, asOf = '', basis = 'ttm', companyType = 'corporate' }) {
  if (body?.schemaVersion !== 'edgar.company-exposure-map.v1' || !matchesExposureRequest(body, ticker, asOf)
    || !Array.isArray(body.rows) || !Array.isArray(body.sources)
    || !body.rows.every(row => typeof row.id === 'string' && typeof row.marketLabel === 'string' && Array.isArray(row.evidence)
      && row.evidence.every(item => typeof item.text === 'string' && typeof item.url === 'string'))) {
    throw new Error('The SEC market evidence does not match the selected company and filing cutoff.');
  }
  const institution = ['bank', 'broker', 'financial', 'insurance'].includes(companyType);
  const priority = institution
    ? ['borrowing', 'investments', 'currencies', 'revenue', 'input-costs']
    : ['borrowing', 'currencies', 'input-costs', 'revenue', 'investments'];
  // A commodity passage in a bank's broad trading business must not displace
  // its funding and asset-repricing channels just because it has a proxy.
  const financialPriority = row => !institution ? 0 : RATE_MARKETS.has(row.marketId)
    ? row.category === 'borrowing' ? 0 : 1 : row.category === 'currencies' ? 2 : 3;
  return selectExposureEvidence(body.rows, basis === 'annual' ? 'annual' : 'all')
    .filter(row => CHANNELS[row.category])
    .map(row => {
      const benchmark = row.benchmark;
      const supported = benchmark && CFTC_LAUNCH_CATALOG.some(item => item.family === benchmark.family && item.code === benchmark.contract)
        && CFTC_FAMILIES[benchmark.family]?.groups.some(group => group.id === benchmark.group);
      return { ...row, benchmark: supported ? benchmark : null };
    })
    .sort((a, b) => financialPriority(a) - financialPriority(b)
      || Number(!!b.benchmark) - Number(!!a.benchmark)
      || Number(b.benchmark?.fit === 'named-reference') - Number(a.benchmark?.fit === 'named-reference')
      || priority.indexOf(a.category) - priority.indexOf(b.category));
}

/** Choices are research references only; generic disclosures never select one. */
export function riskProfileReferenceMarkets(row) {
  if (!row) return CFTC_LAUNCH_CATALOG;
  if (row.category === 'currencies') return CFTC_LAUNCH_CATALOG.filter(item => item.category === 'currencies');
  if (RATE_MARKETS.has(row.marketId)) return CFTC_LAUNCH_CATALOG.filter(item => item.category === 'rates');
  if (['bitcoin', 'ether'].includes(row.marketId)) return CFTC_LAUNCH_CATALOG.filter(item => item.code === (row.marketId === 'bitcoin' ? '133741' : '146021'));
  return CFTC_LAUNCH_CATALOG.filter(item => item.family === 'disaggregated');
}

export function riskProfileMarketChannel(row, companyType = 'corporate') {
  const channel = CHANNELS[row?.category] || { label: 'Independent reference', effect: 'Company connection unconfirmed', connection: 'Choose a market to inspect aggregate futures positioning. The reviewed filings have not established a company-specific connection.' };
  if (companyType === 'bank' && row?.category === 'borrowing') return { ...channel, effect: 'Funding costs and net interest income', connection: 'Deposit pricing and borrowing resets interact with asset repricing to shape net interest income. The filing’s repricing and funding disclosures establish the bank’s sensitivity.' };
  if (companyType === 'bank' && row?.category === 'investments') return { ...channel, effect: 'Asset values and liquidity resources', connection: 'Market changes can affect securities values and interest income. Asset duration, accounting classification and funding needs determine the effect on capital and liquidity.' };
  if (companyType === 'broker' && row?.category === 'borrowing') return { ...channel, effect: 'Secured funding and liquidity', connection: 'Funding terms, collateral requirements and margin calls affect liquidity. Aggregate market positioning does not reveal this dealer’s funding access or margin obligations.' };
  if (companyType === 'broker' && row?.category === 'investments') return { ...channel, effect: 'Inventory values and collateral', connection: 'Market moves can change trading inventory values and collateral requirements. Hedging, asset quality and financing terms determine the liquidity effect.' };
  return channel;
}

export function matchesRiskProfileHistory(data, { family, contract, group }) {
  return !!data?.selected && data.selection?.contract === contract && data.selected.code === contract
    && data.selection?.group === group && data.selected.selectedGroup?.id === group
    && data.report_family === family && data.report_basis === CFTC_REPORT_BASIS
    && data.selection?.history_window === '1y' && data.percentile?.required === 52 && Array.isArray(data.history);
}
