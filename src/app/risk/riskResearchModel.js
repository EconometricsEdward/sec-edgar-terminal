import { buildRiskFundingPresentation } from './riskFundingPresentation.js';
import { formatRiskValue } from '../../utils/riskWorkspace.js';

// A research framework over already-loaded SEC evidence. The model does not
// fetch, store, assign ratings, infer unreported balances, or apply peer bands.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const LENSES = {
  bank: ['Banks', 'Loan quality, loss absorption and funding stability require bank-specific evidence.'],
  broker: ['Broker-dealers', 'Connect financial assets and customer obligations with firm liquidity and secured funding.'],
  life: ['Life & health insurance', 'Policy obligations, investment assets and subsidiary capital need a distinct insurance lens.'],
  property: ['Property & casualty insurance', 'Read claims experience alongside earnings, reserves and the capital supporting obligations.'],
  insurance: ['Insurance', 'Reported claims and book capital describe part of the insurance business; product mix determines their interpretation.'],
  reit: ['REITs', 'Connect recurring cash generation, distributions and property investment with debt service and refinancing.'],
  real_estate: ['Real estate', 'Property investment and cash generation shape financing needs; contractual borrowing dates remain important.'],
  utilities: ['Utilities', 'Investment programs connect internal cash generation with capital-market funding and debt service.'],
  energy: ['Energy', 'Cash generation and reinvestment interact with commodity cycles and borrowing obligations.'],
  retail: ['Retail & consumer', 'Working capital, cash conversion and fixed obligations determine near-term funding needs.'],
  technology: ['Technology', 'Cash conversion, investment and liquidity connect reported growth with financial resilience.'],
  health: ['Healthcare & life sciences', 'Earnings, cash use and investment needs determine the financial resources available to this business.'],
  industrial: ['Industrials', 'Working capital and investment needs connect operating earnings with debt service.'],
  financial: ['Financial services', 'Start with asset and liability structure; the business model determines the appropriate funding and capital measures.'],
  corporate: ['Company financial risk', 'Connect cash generation, liquid resources and borrowing obligations on the same reporting basis.'],
};

export function riskResearchLens(profile = {}, company = {}) {
  const sic = Number.parseInt(company.sic, 10);
  const industry = profile.industry || {};
  let id;
  if (Number.isFinite(sic) && sic > 0) {
    if ((sic >= 6000 && sic <= 6089) || sic === 6712) id = 'bank';
    else if (sic === 6211 || sic === 6221) id = 'broker';
    else if ([6311, 6321, 6324].includes(sic)) id = 'life';
    else if ([6331, 6351, 6361].includes(sic)) id = 'property';
    else if (sic >= 6300 && sic <= 6399) id = 'insurance';
    else if ((sic >= 6090 && sic <= 6299) || (sic >= 6400 && sic <= 6499) || (sic >= 6720 && sic <= 6739) || sic === 6799) id = 'financial';
    else if (sic === 6798) id = 'reit';
    else if (sic >= 6500 && sic <= 6599) id = 'real_estate';
    else if (sic >= 4900 && sic <= 4939) id = 'utilities';
    else if ([1311, 1381, 1382, 1389, 2911].includes(sic)) id = 'energy';
    else if (sic >= 5200 && sic <= 5999) id = 'retail';
    else if ((sic >= 7370 && sic <= 7379) || (sic >= 3570 && sic <= 3579) || (sic >= 3660 && sic <= 3679)) id = 'technology';
    else if ((sic >= 2830 && sic <= 2839) || (sic >= 8000 && sic <= 8099)) id = 'health';
    else if (sic >= 2000 && sic <= 3999) id = 'industrial';
    else id = 'corporate';
  } else {
    const groups = { reit: 'reit', utilities: 'utilities', oil_gas: 'energy', retail: 'retail', tech: 'technology', pharma: 'health', manufacturing: 'industrial', insurance: 'insurance', financial_services: 'financial' };
    id = industry.isBank ? 'bank' : industry.isBrokerDealer ? 'broker' : industry.isInsurer ? 'insurance' : industry.isFinancial ? 'financial' : groups[industry.group] || 'corporate';
  }
  return { id, label: LENSES[id][0], description: LENSES[id][1] };
}

const D = (id, label, question, meaning, metrics, gap, destination = 'filing') => ({ id, label, question, meaning, metrics, gap, destination });
const corporateDrivers = [
  D('cash', 'Cash behind earnings', 'Do reported profits convert into operating cash?', 'Read income and operating cash together; working-capital timing and one-time items explain differences.', ['flow:netIncome', 'flow:operatingCashFlow', 'accruals_ratio'], 'Receivable quality and nonrecurring earnings require the filing notes.'),
  D('liquidity', 'Near-term resources', 'What supports borrowing classified as current?', 'Ending cash and separately reported investments can be compared with current debt without assuming unrestricted availability.', ['cash_current_debt', 'liquid_current_debt', 'current_debt_share'], 'Cash restrictions, committed facilities and payment timing require the liquidity note.', 'maturity'),
  D('debt', 'Debt service', 'What earnings and cash support the borrowing burden?', 'Coverage uses reported annual or TTM earnings and ending debt; it is historical capacity rather than a forecast or covenant test.', ['interest_coverage', 'ocf_to_debt', 'fcf_to_debt'], 'Interest terms, covenants and untagged lease obligations require additional review.', 'maturity'),
  D('investment', 'Investment & distributions', 'What cash remains after reported capital investment?', 'Cash after PP&E purchases is before acquisitions and financing. Distributions are capital-allocation decisions.', ['cash_investment_cover', 'cash_after_capex', 'flow:dividendsPaid'], 'Maintenance and growth capex, acquisitions and future investment commitments are not distinguished.'),
];
const funding = corporateDrivers[1], debt = corporateDrivers[2];
const DEFINITIONS = {
  corporate: corporateDrivers,
  technology: [corporateDrivers[0], funding, D('investment', 'Investment capacity', 'What cash remains after capital spending?', 'Compare historical cash generation and investment; expensed research, stock compensation and acquisitions need separate interpretation.', ['cash_after_capex', 'cash_investment_cover', 'flow:operatingIncome'], 'ARR, retention, product concentration and cash requirements for acquisitions are outside these facts.', 'exposure'), debt],
  industrial: [D('working', 'Working capital', 'Are near-term assets and collections supporting obligations?', 'Inventory and receivable timing can absorb operating cash even when income remains positive.', ['current_ratio', 'quick_ratio', 'receivables_gap'], 'Customer concentration, inventory quality and order backlog require disclosure review.', 'exposure'), corporateDrivers[0], corporateDrivers[3], debt],
  retail: [D('working', 'Working capital', 'What supports short-term operating obligations?', 'Current assets differ in liquidity; inventory-excluded coverage still includes other current assets and is not a conventional quick ratio.', ['current_ratio', 'quick_ratio', 'cash_current_debt'], 'Inventory markdowns, seasonality and lease commitments require filing review.'), corporateDrivers[0], debt, D('investment', 'Cash & fixed commitments', 'What cash remains after reported store and other PP&E investment?', 'Cash after capex does not deduct lease payments again when they already appear in operating cash flow.', ['cash_after_capex', 'cash_investment_cover', 'flow:dividendsPaid'], 'Comparable sales, lease maturities and purchase commitments are not calculated here.', 'exposure')],
  utilities: [D('investment', 'Investment funding', 'How much reported investment is supported by operating cash?', 'Capital programs can exceed annual internal cash generation. Read a funding gap with investment plans and borrowing access.', ['cash_investment_cover', 'cash_after_capex', 'flow:capitalExpenditure'], 'Allowed returns, rate base and regulatory recovery require utility and regulator disclosures.'), debt, funding, D('earnings', 'Earnings capacity', 'How are operating earnings and cash generation changing?', 'Regulatory timing and investment recovery can cause earnings and cash to move differently.', ['flow:operatingIncome', 'flow:operatingCashFlow', 'net_margin'], 'Weather, regulatory decisions and unrecovered costs require the operating discussion.', 'exposure')],
  energy: [D('cash', 'Cycle & cash generation', 'What cash is generated through the observed commodity cycle?', 'Reported cash and operating income capture financial outcomes; market references do not establish realized selling prices.', ['flow:operatingCashFlow', 'flow:operatingIncome', 'net_margin'], 'Production, realized prices and commodity hedges require supported company disclosures.', 'exposure'), corporateDrivers[3], debt, funding],
  health: [D('resources', 'Cash resources', 'What supports continuing operations and investment?', 'Cash is shown alongside historical cash use. Months of cash are available only when operating cash flow is negative; this is not forecast runway.', ['balance:cash', 'flow:operatingCashFlow', 'historical_burn_months'], 'Future financing, trial milestones and reimbursement conditions are not inferred.'), D('earnings', 'Earnings & collections', 'What reported earnings and cash support the business?', 'Research businesses and healthcare providers have different revenue and cash-use models.', ['flow:netIncome', 'net_margin', 'receivables_gap'], 'Pipeline outcomes, payer concentration and receivable collectability require business-specific review.', 'exposure'), corporateDrivers[3], debt],
  bank: [D('capital', 'Capital & earnings', 'What capital and recurring earnings support loss absorption?', 'Consolidated book capital and earnings are separate from regulatory capital at a selected legal bank.', ['bank_equity_assets', 'bank_earnings_assets', 'bank_preprovision_credit_cost'], 'CET1, regulatory leverage and distribution restrictions require legal-bank evidence.', 'bank'), D('assets', 'Loan credit quality', 'What do problem loans, reserves and credit costs show?', 'Nonaccruals, allowances and provision measure different parts of credit risk and should be read together.', ['npl_ratio', 'bank_allowance_nonaccrual', 'provision_rate'], 'Charge-offs, delinquency, collateral and loan concentrations require the regulatory and filing tables.', 'bank'), D('funding', 'Deposit funding', 'What supports deposit obligations and how is the mix changing?', 'Cash is one liquidity source. Deposit composition and borrowing access are separate from the loan/deposit ratio.', ['loans_deposits', 'bank_cash_deposits', 'nib_deposit_share'], 'Uninsured deposits, concentrations and contingent liquidity are not inferred.', 'bank'), D('rates', 'Rate sensitivity', 'How do securities values compare with the capital supporting them?', 'The HTM valuation gap is an accounting sensitivity. It does not establish realized loss or an immediate funding need.', ['bank_htm_gap_equity', 'htm_unrealized', 'htm_adj_equity'], 'Asset and deposit repricing, duration and hedges require the interest-rate-risk note.', 'exposure')],
  broker: [D('assets', 'Assets & counterparties', 'Which financial assets create funding and counterparty needs?', 'Customer, clearing and trading balances show distinct exposures; balances are not assumed net or fully collateralized.', ['broker_receivables_assets', 'broker_clearing_assets', 'broker_financial_instruments_assets'], 'Collateral quality, haircut and enforceable netting details require the notes.', 'exposure'), D('funding', 'Securities financing', 'How much of the balance sheet uses repo and securities borrowing?', 'Gross repo and reverse-repo amounts are displayed separately without treating a matched book as risk-free.', ['broker_repos_assets', 'balance:reverseRepos', 'broker_securities_borrowed_assets'], 'Tenor, counterparty concentration, collateral reuse and margin requirements require review.', 'exposure'), D('liquidity', 'Firm liquidity', 'What liquidity belongs to the firm versus its customers?', 'Separately segregated balances are not added to firm cash and cannot be assumed available to general creditors.', ['broker_cash_liabilities', 'balance:cash', 'balance:segregatedAssets'], 'Customer-reserve compliance and freely available committed liquidity are separate questions.', 'fcm'), D('capital', 'Loss absorption', 'What accounting capital and earnings support the consolidated business?', 'Consolidated or parent book equity is not regulatory net capital. Legal-entity capital must be checked independently.', ['broker_equity_assets', 'flow:netIncome', 'net_margin'], 'FOCUS net capital, haircuts and legal-entity liquidity cannot be derived from consolidated book equity.', 'fcm')],
  financial: [D('structure', 'Asset & liability structure', 'How is the balance sheet financed?', 'Accounting balances organize the review without applying industrial leverage thresholds to a financial business.', ['balance:totalAssets', 'liab_to_assets', 'balance:equity'], 'Business-specific credit and valuation exposures require the asset notes.', 'exposure'), D('liquidity', 'Liquidity resources', 'What cash and obligations are actually reported?', 'Cash, investments and borrowing have different restrictions and purposes; their legal and maturity scopes matter.', ['balance:cash', 'balance:currentDebt', 'balance:totalDebt'], 'Client assets, collateral, facilities and debt seniority require review.'), D('earnings', 'Earnings capacity', 'Are earnings consistent and what revenue basis is used?', 'Net revenue after interest expense cannot be compared directly with industrial gross sales.', ['flow:netIncome', 'net_margin', 'loss_years'], 'Fee mix, credit costs and nonrecurring items require the income statement.'), D('exposures', 'Market transmission', 'Which asset and funding channels transmit market changes?', 'Consolidated assets and liabilities provide scale; funding terms and investment exposures determine the economic effect.', ['balance:totalAssets', 'balance:totalLiabilities', 'balance:cash'], 'Issuer-specific duration, credit concentrations and hedges must be established from disclosures.', 'exposure')],
};
const insuranceDrivers = type => [
  type === 'property' ? D('claims', 'Claims experience', 'How much earned premium is consumed by reported claims?', 'Claims/premiums is a partial underwriting measure. It excludes underwriting expenses and reserve development.', ['loss_ratio', 'flow:netIncome', 'net_margin'], 'A complete combined ratio and reserve-development analysis require the insurance tables.')
    : D('obligations', 'Policy obligations & earnings', 'What reported earnings support policyholder obligations?', 'Life, health and mixed insurance products have distinct claims and investment structures; a universal P&C loss-ratio screen is not used.', ['flow:netIncome', 'net_margin', 'loss_years'], 'Policy liabilities, surrender behavior, reserve adequacy and product mix require the insurance notes.'),
  D('capital', 'Capital support', 'What book capital supports consolidated obligations?', 'Book equity is an accounting measure; insurance subsidiaries have separate statutory capital requirements.', ['ins_equity_assets', 'balance:equity', 'liab_to_assets'], 'Statutory surplus, risk-based capital and subsidiary restrictions require regulatory disclosures.'),
  D('liquidity', 'Cash & funding', 'What liquidity and borrowing are actually reported?', 'Cash availability and policyholder payment timing depend on investment liquidity, restrictions and funding terms.', ['balance:cash', 'balance:totalDebt', 'balance:currentDebt'], 'Asset-liability duration, surrender liquidity and available parent funding require separate review.'),
  D('investments', 'Investment sensitivity', 'What assets and earnings are exposed to investment conditions?', 'Asset scale and reported income are starting points; neither establishes duration, credit quality or matching of policy liabilities.', ['balance:totalAssets', 'flow:netIncome', 'balance:equity'], 'Portfolio credit quality, unrealized losses and reinvestment sensitivity require the investment note.', 'exposure'),
];
DEFINITIONS.life = insuranceDrivers('life');
DEFINITIONS.property = insuranceDrivers('property');
DEFINITIONS.insurance = insuranceDrivers('insurance');
DEFINITIONS.reit = DEFINITIONS.real_estate = [debt, funding, D('investment', 'Property investment & distributions', 'What cash remains after reported PP&E investment and distributions?', 'Reported PP&E purchases are not a complete measure of property investment. Cash dividends are distributions, not debt service.', ['cash_after_capex', 'flow:dividendsPaid', 'flow:operatingCashFlow'], 'FFO, AFFO, maintenance capex, property acquisitions and distribution requirements need the supplemental disclosures.'), D('earnings', 'Earnings & asset context', 'What operating earnings and cash support the property business?', 'Depreciation can make GAAP income differ from property cash economics. Rental revenue may use a narrower reported basis.', ['flow:operatingIncome', 'flow:operatingCashFlow', 'liab_to_assets'], 'Occupancy, tenant concentration, lease rollovers and property valuations require company disclosures.', 'exposure')];

const LABELS = { cash: 'Cash & equivalents', currentDebt: 'Current debt', totalDebt: 'Total debt', equity: 'Book equity', totalAssets: 'Total assets', totalLiabilities: 'Total liabilities', reverseRepos: 'Reverse repurchase agreements', segregatedAssets: 'Segregated customer cash & securities', netIncome: 'Net income', operatingCashFlow: 'Operating cash flow', operatingIncome: 'Operating income', capitalExpenditure: 'Cash capital expenditure', dividendsPaid: 'Cash dividends' };
const human = id => id.replaceAll('_', ' ').replace(/^./, first => first.toUpperCase());
const uniqueSources = points => [...new Map(points.flatMap(point => point?.sources || []).map(source => [[source.taxonomy, source.tag, source.accession, source.start, source.end, source.value].join(':'), source])).values()];
const signature = point => [...new Set((point?.sources || []).map(source => [source.taxonomy || 'us-gaap', source.tag, source.scopeNote || ''].join(':')))].sort().join('|');
const adjacent = (prior, current, basis) => {
  const days = (Date.parse(current?.end) - Date.parse(prior?.end)) / 86400000;
  return basis === 'ttm' ? days >= 60 && days <= 120 : days >= 300 && days <= 400;
};

export function buildRiskResearchModel(profile = {}, company = {}) {
  const lens = riskResearchLens(profile, company);
  const latestEnd = profile.periods?.[0]?.end || null;
  const periods = [...(profile.periods || [])].sort((a, b) => String(a.end).localeCompare(String(b.end)));
  const fundingView = buildRiskFundingPresentation(profile, company);
  const existingMap = new Map((profile.metrics || []).map(metric => [metric.id, metric]));
  const fundingMap = new Map([...fundingView.liquidity.ratios, ...fundingView.obligations.ratios, ...(fundingView.bank?.ratios || []), ...(fundingView.broker?.ratios || [])].map(metric => [metric.id, metric]));
  const rows = { ...(profile.reportedBalances || {}), ...(profile.reportedFlows || {}) };
  const flows = new Set(Object.keys(profile.reportedFlows || {}));
  const at = (key, end) => rows[key]?.find(point => point.end === end);
  const compatible = (keys, end) => {
    const points = keys.map(key => at(key, end));
    if (points.some(point => !finite(point?.value) || point.end !== end || !point.sources?.length)) return null;
    const flowPoints = points.filter((_, index) => flows.has(keys[index]));
    if (flowPoints.some(point => !point.start || point.start !== flowPoints[0].start || (() => {
      const days = (Date.parse(point.end) - Date.parse(point.start)) / 86400000 + 1;
      return days < 300 || days > 400;
    })())) return null;
    return points;
  };
  const normalize = (metric, metricId) => {
    // Loss-window history is a 0/1 flag per observation, while the metric is
    // the aggregate count across the displayed window. It cannot share the
    // ordinary latest-series-value normalization or an ambiguous count chart.
    if (metric.id === 'loss_years') {
      const current = metric.end === latestEnd && finite(metric.value);
      return { id: metric.id, label: metric.label || human(metric.id), value: current ? metric.value : null, prior: null, format: 'count',
        formula: metric.formula || 'Count of reported net-income observations below zero', sources: current ? metric.sources || [] : [], series: [],
        ...(metricId && existingMap.has(metricId) ? { metricId } : {}), ...(metric.note || metric.why ? { note: metric.note || metric.why } : {}) };
    }
    const series = (metric.series || []).filter(point => point?.end).map(point => ({ ...point, value: finite(point.value) ? point.value : null })).sort((a, b) => a.end.localeCompare(b.end));
    const index = series.findIndex(point => point.end === latestEnd);
    const current = index >= 0 ? series[index] : null;
    const candidate = index > 0 ? series[index - 1] : null;
    // API metrics have a current period end; missing latest evidence must not
    // be replaced by a previous period. Comparison also requires source scope.
    const value = current ? current.value : metric.end === latestEnd && finite(metric.value) ? metric.value : null;
    const sources = current?.sources || (metric.end === latestEnd ? metric.sources || [] : []);
    const prior = value != null && candidate && finite(candidate.value) && adjacent(candidate, current, profile.basis)
      && signature(candidate) && signature(candidate) === signature({ sources }) ? candidate.value : null;
    return { id: metric.id, label: metric.label || human(metric.id), value, prior, format: metric.id === 'receivables_gap' ? 'pp' : metric.format || 'usd', formula: current?.formula || metric.formula || 'Reported SEC fact', sources,
      series, ...(metricId && existingMap.has(metricId) ? { metricId } : {}), ...(metric.note || metric.why ? { note: metric.note || metric.why } : {}) };
  };
  const raw = (key, flow = false) => normalize({ id: `reported_${key}`, label: LABELS[key] || human(key), format: 'usd', formula: flow ? 'Reported annual or TTM SEC flow' : 'Reported SEC balance', series: periods.map(period => {
    const point = compatible([key], period.end)?.[0];
    return { end: period.end, value: point?.value ?? null, start: point?.start || null, sources: point?.sources || [], formula: point?.formula || 'Reported SEC fact' };
  }) });
  const calculate = (id, label, keys, operation, format, formula, note) => normalize({ id, label, format, formula, note, series: periods.map(period => {
    const points = compatible(keys, period.end);
    const computed = points ? operation(...points.map(point => point.value)) : null;
    return { end: period.end, start: points?.find((_, index) => flows.has(keys[index]))?.start || null, value: finite(computed) ? computed : null, sources: points ? uniqueSources(points) : [], formula };
  }) });
  const derived = {
    cash_investment_cover: () => calculate('cash_investment_cover', 'Operating cash / cash capex', ['operatingCashFlow', 'capitalExpenditure'], (cash, capex) => capex > 0 ? cash / capex : null, 'pct', 'Operating cash flow / cash PP&E purchases', 'Negative cash generation is preserved. No ratio is assigned when capex is missing or zero.'),
    cash_after_capex: () => calculate('cash_after_capex', 'Cash after capital expenditure', ['operatingCashFlow', 'capitalExpenditure'], (cash, capex) => capex >= 0 ? cash - capex : null, 'usd', 'Operating cash flow − cash PP&E purchases', 'Historical cash remaining before acquisitions, distributions and financing; not FFO or AFFO.'),
    historical_burn_months: () => calculate('historical_burn_months', 'Cash / historical cash use · months', ['cash', 'operatingCashFlow'], (cash, ocf) => cash >= 0 && ocf < 0 ? Math.round(cash / -ocf * 120) / 10 : null, 'count', '12 × ending cash / absolute annual or TTM operating cash outflow', 'Available only for negative operating cash flow. Historical cash-use comparison, not forecast runway; future financing and restrictions are excluded.'),
  };
  const resolve = id => {
    if (id.startsWith('balance:')) return raw(id.slice(8));
    if (id.startsWith('flow:')) return raw(id.slice(5), true);
    if (derived[id]) return derived[id]();
    if (existingMap.has(id)) return normalize(existingMap.get(id), id);
    if (fundingMap.has(id)) return normalize(fundingMap.get(id), fundingMap.get(id).metricId);
    return { id, label: human(id), value: null, prior: null, format: 'pct', formula: 'Compatible reported inputs required', sources: [], series: [] };
  };
  const ticker = encodeURIComponent(String(company.ticker || '').trim().toUpperCase());
  const filingHref = ticker ? `/filings/${ticker}` : '/filings';
  const exposureHref = ticker ? `/risk?ticker=${ticker}&view=exposures` : '/risk?view=exposures';
  const destinations = {
    filing: { label: 'Read company filings', href: filingHref, scope: 'SEC issuer' },
    exposure: { label: 'Inspect business exposures', href: exposureHref, scope: 'SEC issuer disclosures' },
    maturity: { label: 'Inspect debt maturities', href: '#risk-maturities', scope: 'Disclosed annual schedule' },
    bank: { label: 'Open legal-bank evidence', href: '/analysis/banks', scope: 'Separately selected legal bank' },
    fcm: { label: 'Review futures-broker capital', href: '/risk?view=fcm', scope: 'Separately selected CFTC legal entity; FCM/RFED coverage only' },
  };
  const drivers = DEFINITIONS[lens.id].map(definition => {
    const metrics = definition.metrics.map(resolve);
    const missing = metrics.filter(metric => !finite(metric.value)).map(metric => metric.label);
    return { id: definition.id, label: definition.label, question: definition.question, meaning: definition.meaning, metrics,
      gap: [missing.length ? `Compatible evidence unavailable: ${missing.join('; ')}.` : null, definition.gap].filter(Boolean).join(' ') || null,
      links: [destinations[definition.destination]] };
  });
  const metricMap = new Map(drivers.flatMap(driver => driver.metrics).map(metric => [metric.id, metric]));
  // Keep the business-question order, rather than ranking percentages, dollars
  // and multiples against each other. Loss-window counts are not flow changes.
  const changes = [...metricMap.values()].filter(metric => metric.id !== 'loss_years' && finite(metric.value) && finite(metric.prior)).slice(0, 6).map(metric => ({ id: metric.id, label: metric.label, value: metric.value, prior: metric.prior, delta: metric.value - metric.prior, format: metric.format, metricId: metric.metricId || null, sources: metric.sources }));
  const gaps = drivers.map(driver => ({ id: driver.id, label: driver.label, detail: driver.gap, href: driver.links[0].href })).filter(gap => gap.detail);
  const marketChannels = [{ id: 'funding', label: 'Funding conditions', mechanism: 'For borrowing that reprices or is refinanced, market rates can affect future interest cost. Contract terms and company-specific funding access determine the effect.', href: '/market/funding' }];
  if (['bank', 'broker', 'life', 'property', 'insurance', 'financial', 'reit', 'real_estate', 'utilities'].includes(lens.id)) marketChannels.push({ id: 'rates', label: 'Rates & investment values', mechanism: 'Where disclosed, asset duration and liability repricing connect rate moves with earnings, collateral or capital. Aggregate swaps activity does not establish this company’s exposure.', href: '/market/derivatives?asset=rates' });
  if (['energy', 'retail', 'industrial', 'utilities'].includes(lens.id)) marketChannels.push({ id: 'inputs', label: 'Commodity & input channels', mechanism: 'Selling prices, input costs and pass-through terms can transmit commodity changes to cash generation. Establish the company connection from its filing before choosing a CFTC reference.', href: exposureHref });
  if (['technology', 'industrial', 'health', 'energy', 'retail'].includes(lens.id)) marketChannels.push({ id: 'currency', label: 'Currency channels', mechanism: 'Where the company reports foreign-currency activity, receipts, payments and translation can move differently. Currency pair and hedging evidence determine the connection.', href: exposureHref });
  if (lens.id === 'broker') marketChannels.push({ id: 'settlement', label: 'Collateral & settlement', mechanism: 'Collateral requirements and settlement frictions can change a dealer’s liquidity needs. Market-wide fails and funding rates do not identify this firm’s shortfall or funding access.', href: '/market/funding' });
  const limitations = [
    'This is a source-linked research framework, not a credit rating, default probability, peer ranking or forecast. Industry selection follows reported SIC when available.',
    'Missing inputs remain unavailable. Balances use the selected period end; derived flow comparisons require compatible full-year or TTM intervals.',
    profile.basis === 'ttm' ? 'TTM windows overlap. Changes compare adjacent quarter-end observations, rather than independent annual periods.' : 'Annual changes require adjacent fiscal-year observations and compatible source scope.',
    'CFTC and New York Fed measures describe market conditions. They do not establish the issuer’s positions, hedge coverage, credit spread or realized losses.',
    ...(['bank', 'broker', 'life', 'property', 'insurance', 'financial'].includes(lens.id) ? ['Consolidated SEC figures and separately selected regulated legal entities retain distinct scopes. Industrial free-cash-flow debt screens are not used for financial institutions.'] : []),
  ];
  return { lens, drivers, coverage: { available: [...metricMap.values()].filter(metric => finite(metric.value)).length, total: metricMap.size }, changes, gaps, marketChannels, limitations };
}

export function riskResearchBrief(data = {}, profile = {}) {
  const model = buildRiskResearchModel(profile, data);
  const lines = ['', '## Business-model research briefing', `${model.lens.label} · Reporting end ${profile.periods?.[0]?.end || 'unavailable'}`, model.lens.description];
  for (const driver of model.drivers) {
    lines.push('', `### ${driver.label}`, driver.question, driver.meaning);
    for (const metric of driver.metrics) {
      lines.push(`- ${metric.label}: ${finite(metric.value) ? formatRiskValue(metric.value, metric.format) : 'Unavailable'}`, `  Formula: ${metric.formula}`);
      if (finite(metric.prior)) lines.push(`  Prior compatible observation: ${formatRiskValue(metric.prior, metric.format)}`);
      if (metric.note) lines.push(`  Scope: ${metric.note}`);
    }
    for (const source of uniqueSources(driver.metrics)) {
      const url = source.documentUrl || source.url;
      lines.push(`- Source: ${source.label || source.tag}; ${source.start ? `${source.start} to ` : ''}${source.end || 'date unavailable'}${url ? `; ${url}` : ''}`);
    }
    if (driver.gap) lines.push(`- Evidence to review: ${driver.gap}`);
    for (const link of driver.links) lines.push(`- Review: ${link.label} (${link.scope}); ${link.href.startsWith('#') ? `https://secedgarterminal.com/risk?ticker=${encodeURIComponent(data.ticker || '')}${link.href}` : `https://secedgarterminal.com${link.href}`}`);
  }
  lines.push('', '### Market transmission channels');
  for (const channel of model.marketChannels) lines.push(`- ${channel.label}: ${channel.mechanism} https://secedgarterminal.com${channel.href}`);
  lines.push('', '### Research scope', ...model.limitations.map(limitation => `- ${limitation}`));
  return lines.join('\n');
}
