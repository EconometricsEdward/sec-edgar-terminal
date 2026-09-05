import { NextResponse } from 'next/server';
import {
  extractAnnualPeriods,
  extractQuarterlyPeriods,
  buildMetricRow,
} from '../../../utils/xbrlParser.js';

import { warmGet, warmSet } from '../../../utils/warmCache.js';
import { illustrativeGeography, marketSnapshot, appendSnapshot } from '../../../utils/marketEvidence.js';

export const revalidate = 21600;

const MAX_CONCURRENCY = 5;
const BATCH_PAUSE_MS = 300;

const MARKET_OVERVIEW_TTL_MS = 1000 * 60 * 60 * 6;
let marketOverviewCache = null;
const MAX_TEXT_FILERS = 72;

const MARKET_LENSES = [
  {
    id: 'credit-banks',
    assetClass: 'Credit',
    title: 'Credit & bank balance sheets',
    description: 'Large-bank and consumer-credit filings as a proxy for deposit pressure, credit creation, capital markets activity, and loan-loss provisioning.',
    tickers: ['JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'USB', 'PNC', 'TFC', 'COF', 'AXP', 'DFS', 'SCHW', 'BK'],
    kpis: ['revenueGrowth', 'netMargin', 'provisionToLoans', 'depositsToLoans', 'liabilitiesToAssets'],
    disclosureTerms: 'allowance for credit losses, nonperforming loans, deposits, liquidity, charge-offs, commercial real estate',
    pressureLanguage: 'deposit beta, credit losses, funding cost, commercial real estate exposure, loan growth',
  },
  {
    id: 'private-capital',
    assetClass: 'Private Capital',
    title: 'Private credit, asset management & market structure',
    description: 'Alternative-asset managers, exchanges, and asset managers as a lens on fundraising, private credit, market volatility, and fee-bearing asset growth.',
    tickers: ['BX', 'KKR', 'APO', 'ARES', 'BLK', 'TROW', 'ICE', 'CME', 'NDAQ', 'SCHW'],
    kpis: ['revenueGrowth', 'operatingMargin', 'netMargin', 'cashConversion', 'liabilitiesToAssets'],
    disclosureTerms: 'private credit, fee earning assets, assets under management, fundraising, market volatility, redemption',
    pressureLanguage: 'fundraising, AUM, redemption, private credit, realization activity, volatility',
  },
  {
    id: 'real-estate',
    assetClass: 'Real Assets',
    title: 'Listed real estate & digital property assets',
    description: 'REITs and listed property owners as a lens on occupancy, refinancing, rent growth, data-center demand, and rate sensitivity.',
    tickers: ['PLD', 'AMT', 'EQIX', 'DLR', 'SPG', 'O', 'PSA', 'WELL', 'VTR', 'BXP', 'ARE', 'AVB', 'EQR', 'CCI'],
    kpis: ['revenueGrowth', 'operatingMargin', 'liabilitiesToAssets', 'capexIntensity', 'assetGrowth'],
    disclosureTerms: 'occupancy, rent, tenant concentration, refinancing, interest rate risk, data center demand',
    pressureLanguage: 'lease rollover, debt maturity, occupancy, cap rate, refinancing, data center leasing',
  },
  {
    id: 'housing',
    assetClass: 'Housing',
    title: 'Housing, home improvement & building products',
    description: 'Homebuilders, home-improvement retailers, and building-products companies as a filing lens on affordability, mortgage-rate pressure, repair/remodel demand, and housing starts.',
    tickers: ['DHI', 'LEN', 'PHM', 'NVR', 'TOL', 'KBH', 'HD', 'LOW', 'BLDR', 'SHW', 'MAS', 'WHR'],
    kpis: ['revenueGrowth', 'operatingMargin', 'inventoryToSales', 'liabilitiesToAssets', 'cashConversion'],
    disclosureTerms: 'mortgage rates, housing affordability, backlog, cancellations, inventory, repair and remodel',
    pressureLanguage: 'orders, backlog, cancellation rate, affordability, mortgage rates, repair and remodel',
  },
  {
    id: 'energy-commodities',
    assetClass: 'Commodities',
    title: 'Energy, materials & commodity cash flows',
    description: 'Energy producers, services, refiners, metals and steel filings as a lens on commodity prices, capital discipline, inventory cycles, and industrial demand.',
    tickers: ['XOM', 'CVX', 'COP', 'EOG', 'OXY', 'SLB', 'HAL', 'LNG', 'PSX', 'MPC', 'FCX', 'NEM', 'NUE', 'STLD'],
    kpis: ['revenueGrowth', 'operatingMargin', 'cashConversion', 'capexIntensity', 'assetGrowth'],
    disclosureTerms: 'commodity prices, proved reserves, production, hedging, capital expenditures, steel demand, copper demand',
    pressureLanguage: 'realized prices, reserve replacement, depletion, capex discipline, refinery margins, copper demand',
  },
  {
    id: 'consumer-demand',
    assetClass: 'Consumer',
    title: 'Consumer demand, pricing & inventory',
    description: 'Retailers, restaurants, staples, and consumer brands as a filing lens on household demand, pricing power, traffic, inventory quality, and margin compression.',
    tickers: ['WMT', 'COST', 'TGT', 'HD', 'LOW', 'MCD', 'SBUX', 'NKE', 'EL', 'PG', 'KO', 'PEP', 'AMZN'],
    kpis: ['revenueGrowth', 'operatingMargin', 'netMargin', 'inventoryToSales', 'cashConversion'],
    disclosureTerms: 'inventory, markdowns, consumer demand, pricing, shrink, tariffs, traffic, average ticket',
    pressureLanguage: 'markdowns, traffic, ticket size, inventory aging, consumer pressure, shrink',
  },
  {
    id: 'ai-infrastructure',
    assetClass: 'Digital Infrastructure',
    title: 'AI infrastructure, semiconductors & hyperscale capex',
    description: 'Semiconductors, hyperscalers, cloud infrastructure, networking, and memory filings as a lens on AI infrastructure demand and capex intensity.',
    tickers: ['NVDA', 'AMD', 'AVGO', 'INTC', 'QCOM', 'MSFT', 'GOOGL', 'META', 'AMZN', 'ORCL', 'DELL', 'SMCI', 'ANET', 'MU'],
    kpis: ['revenueGrowth', 'operatingMargin', 'capexIntensity', 'rndIntensity', 'cashConversion'],
    disclosureTerms: 'artificial intelligence, data center, accelerated computing, supply constraints, capital expenditures, cloud infrastructure',
    pressureLanguage: 'data center demand, GPU supply, hyperscale capex, networking, memory demand, AI infrastructure',
  },
  {
    id: 'software-security',
    assetClass: 'Software',
    title: 'Software, cybersecurity & cloud applications',
    description: 'Enterprise software, cybersecurity, and cloud application filings as a lens on seat expansion, retention, AI monetization, and software spending.',
    tickers: ['CRM', 'NOW', 'ADBE', 'INTU', 'ADSK', 'PANW', 'CRWD', 'DDOG', 'NET', 'SNOW', 'MDB', 'TEAM', 'ZS'],
    kpis: ['revenueGrowth', 'operatingMargin', 'netMargin', 'rndIntensity', 'cashConversion'],
    disclosureTerms: 'subscription revenue, net retention, cybersecurity, artificial intelligence, customer expansion, cloud spending',
    pressureLanguage: 'renewals, customer expansion, seat growth, consumption, cloud optimization, cybersecurity demand',
  },
  {
    id: 'transport-cyclicals',
    assetClass: 'Cyclicals',
    title: 'Transport, freight & cyclical demand',
    description: 'Railroads, parcel carriers, freight brokers, and airlines as a filing lens on freight demand, fuel cost, labor pressure, travel demand, and industrial cyclicality.',
    tickers: ['UNP', 'CSX', 'NSC', 'UPS', 'FDX', 'DAL', 'UAL', 'AAL', 'LUV', 'JBHT', 'ODFL', 'CHRW'],
    kpis: ['revenueGrowth', 'operatingMargin', 'liabilitiesToAssets', 'interestBurden', 'cashConversion'],
    disclosureTerms: 'fuel prices, capacity, labor costs, freight demand, macroeconomic conditions, volume, yield',
    pressureLanguage: 'load factor, freight volume, fuel cost, wage inflation, capacity, yield',
  },
  {
    id: 'insurance',
    assetClass: 'Insurance',
    title: 'Insurance, claims & long-duration portfolios',
    description: 'Life, P&C, brokers, and insurers as a filing lens on claims severity, reserve adequacy, investment income, rate sensitivity, and catastrophe exposure.',
    tickers: ['MET', 'PRU', 'AIG', 'TRV', 'ALL', 'CB', 'PGR', 'HIG', 'AFL', 'MMC', 'AON', 'AJG'],
    kpis: ['revenueGrowth', 'netMargin', 'liabilitiesToAssets', 'interestBurden', 'cashAndInvestmentsToAssets'],
    disclosureTerms: 'investment income, unrealized losses, claims, reserves, catastrophe losses, interest rate risk',
    pressureLanguage: 'reserve development, portfolio marks, reinvestment yield, claims severity, catastrophe loss',
  },
  {
    id: 'healthcare',
    assetClass: 'Healthcare',
    title: 'Healthcare demand, managed care & therapeutics',
    description: 'Managed care, pharmaceuticals, medtech, and life-science tools as a lens on utilization, pricing, patent cycles, clinical pipelines, and healthcare demand.',
    tickers: ['UNH', 'ELV', 'HUM', 'CI', 'CVS', 'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'TMO', 'DHR', 'ISRG', 'BSX'],
    kpis: ['revenueGrowth', 'operatingMargin', 'netMargin', 'rndIntensity', 'cashConversion'],
    disclosureTerms: 'medical cost trend, utilization, pricing pressure, patent expiration, clinical trial, FDA approval',
    pressureLanguage: 'utilization, medical cost ratio, reimbursement, patent cliff, clinical pipeline, pricing',
  },
  {
    id: 'industrial-capex',
    assetClass: 'Industrials',
    title: 'Industrial capex, automation & equipment cycles',
    description: 'Machinery, electrical equipment, automation, engines, and rental-equipment filings as a lens on capex cycles, backlog, reshoring, and manufacturing demand.',
    tickers: ['CAT', 'DE', 'HON', 'GE', 'ETN', 'EMR', 'ITW', 'PH', 'CMI', 'MMM', 'ROK', 'URI', 'PCAR'],
    kpis: ['revenueGrowth', 'operatingMargin', 'inventoryToSales', 'capexIntensity', 'cashConversion'],
    disclosureTerms: 'backlog, orders, supply chain, automation, capital expenditures, reshoring, manufacturing demand',
    pressureLanguage: 'backlog, orders, dealer inventory, automation demand, reshoring, replacement cycle',
  },
  {
    id: 'utilities-rates',
    assetClass: 'Rates & Power',
    title: 'Utilities, power demand & rate sensitivity',
    description: 'Utilities and power infrastructure filings as a lens on regulated returns, financing cost, grid capex, electricity demand, and data-center load growth.',
    tickers: ['NEE', 'DUK', 'SO', 'AEP', 'EXC', 'SRE', 'D', 'PEG', 'ED', 'XEL', 'WEC', 'EIX'],
    kpis: ['revenueGrowth', 'operatingMargin', 'liabilitiesToAssets', 'capexIntensity', 'interestBurden'],
    disclosureTerms: 'rate case, regulatory recovery, grid modernization, transmission, power demand, data centers',
    pressureLanguage: 'rate base, regulatory recovery, grid capex, transmission, data center load, financing cost',
  },
];

const METRIC_KEYS = [
  'revenue',
  'netIncome',
  'operatingIncome',
  'totalAssets',
  'totalLiabilities',
  'operatingCashFlow',
  'capex',
  'inventory',
  'interestExpense',
  'loans',
  'deposits',
  'provisionForLoanLoss',
  'cash',
  'shortTermInvestments',
  'shortTermDebt',
  'longTermDebt',
  'rnd',
];

const MARKET_RISK_TERMS = {
  rates: [
    'interest rate risk',
    'interest rate swap',
    'interest rate swaps',
    'fixed rate',
    'floating rate',
    'variable rate',
    'yield curve',
    'basis point',
    'rate sensitivity',
    'duration',
  ],
  fx: [
    'foreign currency',
    'foreign exchange',
    'currency forward',
    'currency forwards',
    'exchange rate',
    'fx risk',
    'translation adjustment',
  ],
  commodities: [
    'commodity price',
    'commodity prices',
    'fuel hedge',
    'fuel hedging',
    'crude oil',
    'natural gas',
    'power price',
    'metals',
    'diesel',
    'jet fuel',
  ],
  equity: [
    'equity price risk',
    'equity securities',
    'marketable equity',
    'equity method',
    'share price',
    'stock price',
  ],
  credit: [
    'credit risk',
    'credit losses',
    'credit spread',
    'allowance for credit losses',
    'nonperforming',
    'charge-offs',
    'counterparty credit',
  ],
  liquidity: [
    'liquidity risk',
    'collateral',
    'margin requirements',
    'margin call',
    'master netting',
    'netting arrangement',
    'cash collateral',
  ],
  derivatives: [
    'derivative',
    'derivatives',
    'swap',
    'swaps',
    'forward contract',
    'futures contract',
    'option contract',
    'hedging instrument',
    'value-at-risk',
    'value at risk',
    'var',
  ],
  tradingBook: [
    'trading portfolio',
    'trading book',
    'non-trading portfolio',
    'nontrading portfolio',
    'market risk',
    'item 7a',
    'quantitative and qualitative disclosures',
  ],
};

const DERIVATIVE_TAG_RE = /Derivative|Derivatives|Hedging|Hedge|Swap|Swaps|Option|Options|Forward|Forwards|Future|Futures|Notional|ValueAtRisk|MarketRisk/i;

function uniqueTickers(tickers) {
  const seen = new Set();
  const out = [];
  for (const raw of tickers || []) {
    const ticker = String(raw || '').trim().toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const resolved = await Promise.all(batch.map(mapper));
    results.push(...resolved);
    if (i + limit < items.length) await sleep(BATCH_PAUSE_MS);
  }
  return results;
}

function pct(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  return (numerator / denominator) * 100;
}

function ratio(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  return numerator / denominator;
}

function pctChange(latest, prior) {
  if (latest == null || prior == null || prior === 0) return null;
  if (!Number.isFinite(latest) || !Number.isFinite(prior)) return null;
  return ((latest - prior) / Math.abs(prior)) * 100;
}

function finiteValues(values) {
  return values.filter((value) => value != null && Number.isFinite(value));
}

function mean(values) {
  const clean = finiteValues(values);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function median(values) {
  const clean = finiteValues(values).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function min(values) {
  const clean = finiteValues(values);
  return clean.length ? Math.min(...clean) : null;
}

function max(values) {
  const clean = finiteValues(values);
  return clean.length ? Math.max(...clean) : null;
}

function clamp(value, low, high) {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(low, Math.min(high, value));
}

function latestDate(dates) {
  const clean = dates.filter(Boolean).sort();
  return clean.length ? clean[clean.length - 1] : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countTerm(text, term) {
  if (!text) return 0;
  const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
  return (text.match(re) || []).length;
}

function cleanHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractExcerpts(text, terms, maxExcerpts = 3) {
  const excerpts = [];
  const lower = text.toLowerCase();

  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx === -1) continue;

    const start = Math.max(0, idx - 170);
    const end = Math.min(text.length, idx + term.length + 220);
    let excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();

    if (start > 0) excerpt = `…${excerpt}`;
    if (end < text.length) excerpt = `${excerpt}…`;

    excerpts.push({
      term,
      excerpt,
    });

    if (excerpts.length >= maxExcerpts) break;
  }

  return excerpts;
}

function classifyConcept(tag, label = '') {
  const text = `${tag} ${label}`;

  let assetClass = 'Other';
  if (/Interest|Rate|Yield|Swap/i.test(text)) assetClass = 'Rates';
  else if (/Foreign|Currency|Exchange|Fx/i.test(text)) assetClass = 'FX';
  else if (/Commodity|Fuel|Oil|Gas|Power|Metal/i.test(text)) assetClass = 'Commodities';
  else if (/Equity|Stock|Share/i.test(text)) assetClass = 'Equity';
  else if (/Credit|Default|Counterparty/i.test(text)) assetClass = 'Credit';

  let instrument = 'Derivative contract';
  if (/Swap/i.test(text)) instrument = 'Swap';
  else if (/Option/i.test(text)) instrument = 'Option';
  else if (/Future/i.test(text)) instrument = 'Future';
  else if (/Forward/i.test(text)) instrument = 'Forward';
  else if (/CreditDefault|CDS/i.test(text)) instrument = 'Credit derivative';
  else if (/ValueAtRisk|VaR|MarketRisk/i.test(text)) instrument = 'VaR / market risk';

  let balanceSide = 'Other';
  if (/Asset/i.test(text) && !/Liabil/i.test(text)) balanceSide = 'Asset';
  else if (/Liabil/i.test(text)) balanceSide = 'Liability';
  else if (/Notional|Contractual/i.test(text)) balanceSide = 'Notional';
  else if (/Gain|Loss|Income/i.test(text)) balanceSide = 'P&L';

  return { assetClass, instrument, balanceSide };
}

function latestNumericEntry(concept) {
  const units = concept?.units || {};
  const rows = [];

  for (const [unit, entries] of Object.entries(units)) {
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (entry?.val == null || !Number.isFinite(entry.val)) continue;
      rows.push({ ...entry, unit });
    }
  }

  if (!rows.length) return null;

  rows.sort((a, b) => {
    const filedCompare = String(b.filed || '').localeCompare(String(a.filed || ''));
    if (filedCompare !== 0) return filedCompare;
    const endCompare = String(b.end || '').localeCompare(String(a.end || ''));
    if (endCompare !== 0) return endCompare;
    return 0;
  });

  return rows[0];
}

function scanDerivativeConcepts(facts) {
  const concepts = [];

  for (const [taxonomy, taxonomyFacts] of Object.entries(facts || {})) {
    for (const [tag, concept] of Object.entries(taxonomyFacts || {})) {
      const label = concept?.label || concept?.description || '';
      if (!DERIVATIVE_TAG_RE.test(`${tag} ${label}`)) continue;

      const latest = latestNumericEntry(concept);
      if (!latest) continue;

      const classification = classifyConcept(tag, label);

      concepts.push({
        taxonomy,
        tag,
        label,
        unit: latest.unit,
        value: latest.val,
        form: latest.form,
        filed: latest.filed,
        end: latest.end,
        accession: latest.accn,
        ...classification,
      });
    }
  }

  concepts.sort((a, b) => Math.abs(b.value || 0) - Math.abs(a.value || 0));
  return concepts.slice(0, 30);
}

function buildDerivativeSummary(concepts) {
  const assetValue = concepts
    .filter((item) => item.balanceSide === 'Asset' && item.unit === 'USD')
    .reduce((sum, item) => sum + Math.abs(item.value || 0), 0);

  const liabilityValue = concepts
    .filter((item) => item.balanceSide === 'Liability' && item.unit === 'USD')
    .reduce((sum, item) => sum + Math.abs(item.value || 0), 0);

  const notionalValue = concepts
    .filter((item) => item.balanceSide === 'Notional' && item.unit === 'USD')
    .reduce((sum, item) => sum + Math.abs(item.value || 0), 0);

  const byAssetClass = groupConcepts(concepts, 'assetClass');
  const byInstrument = groupConcepts(concepts, 'instrument');

  return {
    conceptCount: concepts.length,
    assetValue,
    liabilityValue,
    notionalValue,
    byAssetClass,
    byInstrument,
  };
}

function groupConcepts(concepts, key) {
  const map = new Map();

  for (const item of concepts || []) {
    const label = item[key] || 'Other';
    const prev = map.get(label) || {
      label,
      conceptCount: 0,
      usdValue: 0,
      filers: new Set(),
    };

    prev.conceptCount += 1;
    if (item.unit === 'USD') prev.usdValue += Math.abs(item.value || 0);
    if (item.ticker) prev.filers.add(item.ticker);
    map.set(label, prev);
  }

  return Array.from(map.values()).map((row) => ({
    ...row,
    filers: Array.from(row.filers || []),
  }));
}

function getMetricPoint(facts, key, periods, sic) {
  if (!periods.length) {
    return { latest: null, prior: null, source: null, coverage: 0 };
  }

  const row = buildMetricRow(facts, key, key, periods, key === 'sharesDiluted' ? 'shares' : 'currency', sic);
  const values = row.values || [];

  return {
    latest: values[0]?.value ?? null,
    prior: values[1]?.value ?? null,
    source: values[0]?.source || null,
    coverage: values.filter((value) => value?.value != null).length,
  };
}

function deriveMetrics(metrics, quarterlyMetrics) {
  const revenue = metrics.revenue?.latest ?? null;
  const priorRevenue = metrics.revenue?.prior ?? null;
  const qRevenue = quarterlyMetrics.revenue?.latest ?? null;
  const priorQRevenue = quarterlyMetrics.revenue?.prior ?? null;
  const netIncome = metrics.netIncome?.latest ?? null;
  const operatingIncome = metrics.operatingIncome?.latest ?? null;
  const totalAssets = metrics.totalAssets?.latest ?? null;
  const priorAssets = metrics.totalAssets?.prior ?? null;
  const totalLiabilities = metrics.totalLiabilities?.latest ?? null;
  const operatingCashFlow = metrics.operatingCashFlow?.latest ?? null;
  const capex = metrics.capex?.latest ?? null;
  const inventory = metrics.inventory?.latest ?? null;
  const interestExpense = metrics.interestExpense?.latest ?? null;
  const loans = metrics.loans?.latest ?? null;
  const priorLoans = metrics.loans?.prior ?? null;
  const deposits = metrics.deposits?.latest ?? null;
  const provision = metrics.provisionForLoanLoss?.latest ?? null;
  const cash = metrics.cash?.latest ?? null;
  const shortTermInvestments = metrics.shortTermInvestments?.latest ?? null;
  const shortTermDebt = metrics.shortTermDebt?.latest ?? null;
  const longTermDebt = metrics.longTermDebt?.latest ?? null;
  const rnd = metrics.rnd?.latest ?? null;

  const totalDebt =
    (shortTermDebt == null ? 0 : Math.abs(shortTermDebt)) +
    (longTermDebt == null ? 0 : Math.abs(longTermDebt));

  const cashAndInvestments =
    (cash == null ? 0 : cash) +
    (shortTermInvestments == null ? 0 : shortTermInvestments);

  return {
    revenueGrowth: pctChange(revenue, priorRevenue),
    quarterlyRevenuePulse: pctChange(qRevenue, priorQRevenue),
    netMargin: pct(netIncome, revenue),
    operatingMargin: pct(operatingIncome, revenue),
    liabilitiesToAssets: pct(totalLiabilities, totalAssets),
    debtToAssets: pct(totalDebt || null, totalAssets),
    capexIntensity: pct(capex == null ? null : Math.abs(capex), revenue),
    cashConversion: ratio(operatingCashFlow, netIncome),
    inventoryToSales: pct(inventory, revenue),
    interestBurden: pct(interestExpense == null ? null : Math.abs(interestExpense), revenue),
    provisionToLoans: pct(provision == null ? null : Math.abs(provision), loans),
    depositsToLoans: ratio(deposits, loans),
    loanGrowth: pctChange(loans, priorLoans),
    assetGrowth: pctChange(totalAssets, priorAssets),
    cashAndInvestmentsToAssets: pct(cashAndInvestments || null, totalAssets),
    rndIntensity: pct(rnd, revenue),
  };
}

function companyScore(derived) {
  const growth = clamp(derived.revenueGrowth, -30, 30) * 0.45;
  const pulse = clamp(derived.quarterlyRevenuePulse, -30, 30) * 0.25;
  const margin = clamp(derived.operatingMargin ?? derived.netMargin, -30, 35) * 0.16;
  const conversion = clamp((derived.cashConversion ?? 0) * 10, -20, 20) * 0.06;
  const leveragePenalty = Math.max(0, (derived.liabilitiesToAssets ?? 0) - 70) * 0.16;
  const debtPenalty = Math.max(0, (derived.debtToAssets ?? 0) - 35) * 0.10;
  const interestPenalty = Math.max(0, (derived.interestBurden ?? 0) - 5) * 0.9;
  const provisionPenalty = Math.max(0, (derived.provisionToLoans ?? 0) - 1) * 5;

  return growth + pulse + margin + conversion - leveragePenalty - debtPenalty - interestPenalty - provisionPenalty;
}

function buildMetricSummary(companies, key) {
  const values = companies.map((company) => company.derived[key]);
  return {
    average: mean(values),
    median: median(values),
    min: min(values),
    max: max(values),
    coverage: finiteValues(values).length,
  };
}

function breadthPct(companies, predicate) {
  const valid = companies.filter((company) => !company.error);
  if (!valid.length) return null;
  const matched = valid.filter(predicate).length;
  return (matched / valid.length) * 100;
}

function buildHeadline(definition, averages, breadth, tone) {
  const growth = averages.revenueGrowth;
  const pulse = averages.quarterlyRevenuePulse;
  const margin = averages.operatingMargin ?? averages.netMargin;
  const leverage = averages.liabilitiesToAssets;

  if (tone === 'expansion') {
    return `${definition.assetClass} filings lean expansionary: ${formatPercent(growth)} annual growth, ${formatPercent(pulse)} quarterly pulse, and ${formatPercent(breadth.positiveRevenuePct)} of companies with positive revenue growth.`;
  }

  if (tone === 'stress') {
    return `${definition.assetClass} filings show stress: weak growth, balance-sheet pressure, or margin deterioration across the cohort.`;
  }

  if (tone === 'caution') {
    return `${definition.assetClass} filings are mixed: ${formatPercent(growth)} growth, ${formatPercent(margin)} margin, and ${formatPercent(leverage)} liabilities/assets.`;
  }

  return `${definition.assetClass} filings look stable: the latest cohort does not show a dominant expansion or stress signal.`;
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function aggregateLens(definition, companies) {
  const usable = companies.filter((company) => !company.error);

  const averages = {
    revenueGrowth: mean(usable.map((company) => company.derived.revenueGrowth)),
    quarterlyRevenuePulse: mean(usable.map((company) => company.derived.quarterlyRevenuePulse)),
    netMargin: mean(usable.map((company) => company.derived.netMargin)),
    operatingMargin: mean(usable.map((company) => company.derived.operatingMargin)),
    liabilitiesToAssets: mean(usable.map((company) => company.derived.liabilitiesToAssets)),
    debtToAssets: mean(usable.map((company) => company.derived.debtToAssets)),
    capexIntensity: mean(usable.map((company) => company.derived.capexIntensity)),
    cashConversion: mean(usable.map((company) => company.derived.cashConversion)),
    inventoryToSales: mean(usable.map((company) => company.derived.inventoryToSales)),
    interestBurden: mean(usable.map((company) => company.derived.interestBurden)),
    provisionToLoans: mean(usable.map((company) => company.derived.provisionToLoans)),
    depositsToLoans: mean(usable.map((company) => company.derived.depositsToLoans)),
    loanGrowth: mean(usable.map((company) => company.derived.loanGrowth)),
    assetGrowth: mean(usable.map((company) => company.derived.assetGrowth)),
    cashAndInvestmentsToAssets: mean(usable.map((company) => company.derived.cashAndInvestmentsToAssets)),
    rndIntensity: mean(usable.map((company) => company.derived.rndIntensity)),
  };

  const metricSummary = Object.keys(averages).reduce((acc, key) => {
    acc[key] = buildMetricSummary(usable, key);
    return acc;
  }, {});

  const breadth = {
    positiveRevenuePct: breadthPct(usable, (company) => (company.derived.revenueGrowth ?? -Infinity) > 0),
    positiveQuarterlyPulsePct: breadthPct(usable, (company) => (company.derived.quarterlyRevenuePulse ?? -Infinity) > 0),
    positiveOperatingMarginPct: breadthPct(usable, (company) => (company.derived.operatingMargin ?? company.derived.netMargin ?? -Infinity) > 0),
    leverageWatchPct: breadthPct(usable, (company) => (company.derived.liabilitiesToAssets ?? 0) > 75),
    highCapexPct: breadthPct(usable, (company) => (company.derived.capexIntensity ?? 0) > 12),
  };

  const scoredCompanies = usable
    .map((company) => ({
      ticker: company.ticker,
      name: company.name,
      score: companyScore(company.derived),
      revenueGrowth: company.derived.revenueGrowth,
      operatingMargin: company.derived.operatingMargin ?? company.derived.netMargin,
      liabilitiesToAssets: company.derived.liabilitiesToAssets,
      latestFiled: latestDate(company.filedDates),
      annualPeriod: company.annualPeriod,
      quarterlyPeriod: company.quarterlyPeriod,
      derived: company.derived,
    }))
    .sort((a, b) => b.score - a.score);

  const score = mean(scoredCompanies.map((company) => company.score)) ?? 0;

  let tone = 'neutral';
  if (score > 8 && (breadth.positiveRevenuePct ?? 0) >= 55) tone = 'expansion';
  else if (score < -6 || (breadth.leverageWatchPct ?? 0) > 45) tone = 'stress';
  else if (score < 3 || (breadth.positiveRevenuePct ?? 0) < 45) tone = 'caution';

  const evidenceCount = usable.reduce((sum, company) => {
    return sum + Object.values(company.metrics).filter((metric) => metric?.source).length;
  }, 0);

  const coveragePct = definition.tickers.length
    ? (usable.length / definition.tickers.length) * 100
    : 0;

  return {
    id: definition.id,
    assetClass: definition.assetClass,
    title: definition.title,
    description: definition.description,
    tickers: definition.tickers,
    loadedTickers: usable.map((company) => company.ticker),
    failedTickers: companies.filter((company) => company.error).map((company) => ({ ticker: company.ticker, error: company.error })),
    kpis: definition.kpis,
    disclosureTerms: definition.disclosureTerms,
    pressureLanguage: definition.pressureLanguage,
    averages,
    metricSummary,
    breadth,
    tone,
    score,
    headline: buildHeadline(definition, averages, breadth, tone),
    evidenceCount,
    coveragePct,
    latestFiled: latestDate(usable.flatMap((company) => company.filedDates)),
    leaders: scoredCompanies.slice(0, 3),
    laggards: scoredCompanies.slice(-3).reverse(),
    companies: scoredCompanies,
  };
}

async function loadTickerMap(userAgent) {
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': userAgent },
    next: { revalidate: 86400 },
  });

  if (!res.ok) {
    throw new Error(`Could not load SEC ticker map (${res.status})`);
  }

  const data = await res.json();
  const map = new Map();

  for (const entry of Object.values(data)) {
    const ticker = String(entry?.ticker || '').toUpperCase();
    if (!ticker || !entry?.cik_str) continue;

    map.set(ticker, {
      ticker,
      cik: String(entry.cik_str).padStart(10, '0'),
      name: entry.title || ticker,
    });
  }

  return map;
}

async function fetchLatestFilingText(entry, userAgent) {
  try {
    const submissionsRes = await fetch(`https://data.sec.gov/submissions/CIK${entry.cik}.json`, {
      headers: { 'User-Agent': userAgent },
      cache: 'no-store',
    });

    if (!submissionsRes.ok) return null;

    const submissions = await submissionsRes.json();
    const recent = submissions?.filings?.recent;
    if (!recent?.form?.length) return null;

    let selected = null;
    for (let i = 0; i < recent.form.length; i += 1) {
      if (recent.form[i] === '10-K' || recent.form[i] === '10-Q') {
        selected = {
          form: recent.form[i],
          accession: recent.accessionNumber[i],
          filingDate: recent.filingDate[i],
          primaryDocument: recent.primaryDocument[i],
        };
        break;
      }
    }

    if (!selected?.accession || !selected?.primaryDocument) return null;

    const cikNoZeros = String(parseInt(entry.cik, 10));
    const accessionNoDashes = selected.accession.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accessionNoDashes}/${selected.primaryDocument}`;

    const filingRes = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      cache: 'no-store',
    });

    if (!filingRes.ok) return null;

    const raw = await filingRes.text();
    const text = cleanHtml(raw.slice(0, 3500000));

    return {
      ...selected,
      url,
      text,
    };
  } catch {
    return null;
  }
}

function buildMarketRiskProfile(filingText) {
  const text = filingText?.text || '';
  const termCounts = {};
  const excerpts = [];

  for (const [category, terms] of Object.entries(MARKET_RISK_TERMS)) {
    const count = terms.reduce((sum, term) => sum + countTerm(text, term), 0);
    termCounts[category] = count;

    if (count > 0 && excerpts.length < 7) {
      excerpts.push(
        ...extractExcerpts(text, terms, 2).map((item) => ({
          category,
          ...item,
        }))
      );
    }
  }

  let portfolioType = 'undetermined';
  if (countTerm(text, 'trading portfolio') + countTerm(text, 'trading book') > 0) portfolioType = 'trading';
  else if (countTerm(text, 'non-trading portfolio') + countTerm(text, 'nontrading portfolio') > 0) portfolioType = 'non-trading';
  else if (countTerm(text, 'hedging instrument') + countTerm(text, 'cash flow hedge') + countTerm(text, 'fair value hedge') > 0) portfolioType = 'hedging';
  else if (countTerm(text, 'investment portfolio') + countTerm(text, 'available-for-sale') + countTerm(text, 'held-to-maturity') > 0) portfolioType = 'investment';

  const totalTermCount = Object.values(termCounts).reduce((sum, value) => sum + value, 0);

  return {
    scanned: !!text,
    form: filingText?.form || null,
    filingDate: filingText?.filingDate || null,
    accession: filingText?.accession || null,
    url: filingText?.url || null,
    termCounts,
    totalTermCount,
    portfolioType,
    excerpts: excerpts.slice(0, 7),
  };
}

async function loadCompany(entry, userAgent, shouldScanText) {
  try {
    const [factsRes, filingText] = await Promise.all([
      fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${entry.cik}.json`, {
        headers: { 'User-Agent': userAgent },
        cache: 'no-store',
      }),
      shouldScanText ? fetchLatestFilingText(entry, userAgent) : Promise.resolve(null),
    ]);

    if (!factsRes.ok) {
      throw new Error(`SEC Company Facts unavailable (${factsRes.status})`);
    }

    const factsPayload = await factsRes.json();
    const facts = factsPayload.facts || {};
    const annualPeriods = extractAnnualPeriods(facts).slice(0, 5);
    const quarterlyPeriods = extractQuarterlyPeriods(facts).slice(0, 5);

    const metrics = {};
    const quarterlyMetrics = {};

    for (const key of METRIC_KEYS) {
      metrics[key] = getMetricPoint(facts, key, annualPeriods, null);
      quarterlyMetrics[key] = getMetricPoint(facts, key, quarterlyPeriods, null);
    }

    const derivativeConcepts = scanDerivativeConcepts(facts).map((item) => ({
      ...item,
      ticker: entry.ticker,
      name: entry.name,
    }));

    const derivativeSummary = buildDerivativeSummary(derivativeConcepts);

    const filedDates = Object.values(metrics)
      .concat(Object.values(quarterlyMetrics))
      .map((metric) => metric?.source?.filed)
      .filter(Boolean);

    const marketRiskProfile = buildMarketRiskProfile(filingText);

    return {
      ticker: entry.ticker,
      name: entry.name,
      cik: entry.cik,
      annualPeriod: annualPeriods[0] || null,
      quarterlyPeriod: quarterlyPeriods[0] || null,
      metrics,
      quarterlyMetrics,
      filedDates,
      derived: deriveMetrics(metrics, quarterlyMetrics),
      derivativeConcepts,
      derivativeSummary,
      marketRiskProfile,
      error: null,
    };
  } catch (error) {
    return {
      ticker: entry.ticker,
      name: entry.name,
      cik: entry.cik,
      annualPeriod: null,
      quarterlyPeriod: null,
      metrics: {},
      quarterlyMetrics: {},
      filedDates: [],
      derived: deriveMetrics({}, {}),
      derivativeConcepts: [],
      derivativeSummary: buildDerivativeSummary([]),
      marketRiskProfile: buildMarketRiskProfile(null),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function aggregateTradeBookAtlas(companies) {
  const usable = companies.filter((company) => !company.error);
  const categories = ['rates', 'fx', 'commodities', 'equity', 'credit', 'liquidity', 'derivatives', 'tradingBook'];

  const assetClasses = categories.map((category) => {
    const companyRows = usable
      .map((company) => {
        const textCount = company.marketRiskProfile?.termCounts?.[category] || 0;
        const conceptCount = category === 'derivatives'
          ? company.derivativeSummary.conceptCount
          : company.derivativeConcepts.filter((concept) => String(concept.assetClass || '').toLowerCase() === category).length;

        return {
          ticker: company.ticker,
          name: company.name,
          textCount,
          conceptCount,
          score: textCount + conceptCount * 2,
          portfolioType: company.marketRiskProfile?.portfolioType || 'undetermined',
          excerpts: company.marketRiskProfile?.excerpts?.filter((excerpt) => excerpt.category === category).slice(0, 2) || [],
          filingUrl: company.marketRiskProfile?.url || null,
        };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);

    return {
      id: category,
      label: {
        rates: 'Rates',
        fx: 'FX',
        commodities: 'Commodities',
        equity: 'Equity',
        credit: 'Credit',
        liquidity: 'Liquidity / Collateral',
        derivatives: 'Derivatives',
        tradingBook: 'Trading / Market Risk',
      }[category],
      companies: companyRows.slice(0, 12),
      companyCount: companyRows.length,
      textMentions: companyRows.reduce((sum, row) => sum + row.textCount, 0),
      conceptCount: companyRows.reduce((sum, row) => sum + row.conceptCount, 0),
    };
  });

  const portfolioTypes = ['trading', 'non-trading', 'hedging', 'investment', 'undetermined'].map((type) => {
    const members = usable
      .filter((company) => (company.marketRiskProfile?.portfolioType || 'undetermined') === type)
      .map((company) => company.ticker);

    return {
      type,
      companyCount: members.length,
      tickers: members.slice(0, 18),
    };
  });

  const exposureNetwork = [];
  for (const asset of assetClasses) {
    for (const company of asset.companies.slice(0, 8)) {
      exposureNetwork.push({
        source: company.ticker,
        target: asset.label,
        portfolioType: company.portfolioType,
        weight: company.score,
      });
    }
  }

  return {
    scannedFilers: usable.filter((company) => company.marketRiskProfile?.scanned).length,
    assetClasses,
    portfolioTypes,
    exposureNetwork: exposureNetwork.sort((a, b) => b.weight - a.weight).slice(0, 60),
  };
}

function scoreToTone(score, direction = 'risk') {
  if (direction === 'growth') {
    if (score >= 68) return 'expansion';
    if (score >= 45) return 'neutral';
    if (score >= 28) return 'caution';
    return 'stress';
  }

  if (score >= 72) return 'stress';
  if (score >= 48) return 'caution';
  if (score >= 25) return 'neutral';
  return 'expansion';
}

function normalizeScore(value, maxValue) {
  if (value == null || !Number.isFinite(value) || maxValue <= 0) return 0;
  return clamp((value / maxValue) * 100, 0, 100);
}

function findLens(lenses, id) {
  return lenses.find((lens) => lens.id === id);
}

function buildWeatherMap(lenses, companies, tradeBookAtlas) {
  const credit = findLens(lenses, 'credit-banks');
  const realEstate = findLens(lenses, 'real-estate');
  const energy = findLens(lenses, 'energy-commodities');
  const consumer = findLens(lenses, 'consumer-demand');
  const ai = findLens(lenses, 'ai-infrastructure');
  const utilities = findLens(lenses, 'utilities-rates');

  const riskCategory = (id) => tradeBookAtlas.assetClasses.find((item) => item.id === id) || { textMentions: 0, conceptCount: 0, companies: [] };

  const ratesActivity = riskCategory('rates');
  const fxActivity = riskCategory('fx');
  const commodityActivity = riskCategory('commodities');
  const liquidityActivity = riskCategory('liquidity');
  const derivativeActivity = riskCategory('derivatives');

  const rows = [
    {
      id: 'rates',
      label: 'Rates',
      description: 'Interest-rate risk, swap disclosures, interest burden, debt cost, and rate-sensitive balance sheets.',
      score: clamp((utilities?.averages.interestBurden || 0) * 9 + normalizeScore(ratesActivity.textMentions, 220) * 0.65 + (utilities?.averages.liabilitiesToAssets || 0) * 0.22, 0, 100),
      topCompanies: ratesActivity.companies.slice(0, 5),
    },
    {
      id: 'credit',
      label: 'Credit',
      description: 'Provisioning, loan growth, credit-loss language, counterparty risk, and financial-sector balance-sheet pressure.',
      score: clamp((credit?.averages.provisionToLoans || 0) * 18 + Math.max(0, 55 - (credit?.breadth.positiveRevenuePct || 0)) + normalizeScore(riskCategory('credit').textMentions, 250) * 0.45, 0, 100),
      topCompanies: riskCategory('credit').companies.slice(0, 5),
    },
    {
      id: 'cre',
      label: 'CRE / Real Assets',
      description: 'Occupancy, refinancing, debt maturity, rate pressure, and commercial real estate language.',
      score: clamp((realEstate?.averages.liabilitiesToAssets || 0) * 0.52 + Math.max(0, 45 - (realEstate?.breadth.positiveRevenuePct || 0)) + normalizeScore(riskCategory('liquidity').textMentions, 280) * 0.25, 0, 100),
      topCompanies: realEstate?.laggards || [],
    },
    {
      id: 'commodities',
      label: 'Commodities',
      description: 'Commodity-price sensitivity, energy cash flows, producer capex, fuel hedging, and materials-cycle pressure.',
      score: clamp(normalizeScore(commodityActivity.textMentions, 260) * 0.55 + Math.abs(energy?.averages.revenueGrowth || 0) * 0.8 + (energy?.averages.capexIntensity || 0) * 0.7, 0, 100),
      topCompanies: commodityActivity.companies.slice(0, 5),
    },
    {
      id: 'fx',
      label: 'FX',
      description: 'Foreign-currency risk language, forward contracts, translation adjustments, and multinational exposure.',
      score: clamp(normalizeScore(fxActivity.textMentions, 180) * 0.8 + normalizeScore(fxActivity.companyCount, 30) * 0.2, 0, 100),
      topCompanies: fxActivity.companies.slice(0, 5),
    },
    {
      id: 'liquidity',
      label: 'Liquidity / Collateral',
      description: 'Collateral, margin requirements, netting, liquidity risk, debt maturity, and cash constraints.',
      score: clamp(normalizeScore(liquidityActivity.textMentions, 260) * 0.6 + mean(companies.map((company) => company.derived.liabilitiesToAssets)) * 0.35, 0, 100),
      topCompanies: liquidityActivity.companies.slice(0, 5),
    },
    {
      id: 'ai',
      label: 'AI Infrastructure',
      description: 'AI, data-center, cloud infrastructure, semiconductors, capex intensity, and R&D intensity.',
      score: clamp((ai?.score || 0) + 50 + (ai?.averages.capexIntensity || 0) * 0.9 + (ai?.averages.rndIntensity || 0) * 0.5, 0, 100),
      direction: 'growth',
      topCompanies: ai?.leaders || [],
    },
    {
      id: 'consumer',
      label: 'Consumer',
      description: 'Consumer-demand filings, inventory, markdowns, traffic, pricing, shrink, and margin pressure.',
      score: clamp(Math.max(0, 50 - (consumer?.breadth.positiveRevenuePct || 0)) + (consumer?.averages.inventoryToSales || 0) * 0.9 + Math.max(0, -(consumer?.averages.revenueGrowth || 0)) * 2, 0, 100),
      topCompanies: consumer?.laggards || [],
    },
    {
      id: 'derivatives',
      label: 'Derivatives',
      description: 'Derivative XBRL concepts, swaps, forwards, options, futures, notional/fair-value language, and VaR disclosures.',
      score: clamp(normalizeScore(derivativeActivity.conceptCount, 360) * 0.55 + normalizeScore(derivativeActivity.textMentions, 420) * 0.45, 0, 100),
      topCompanies: derivativeActivity.companies.slice(0, 5),
    },
  ];

  return rows.map((row) => ({
    ...row,
    tone: scoreToTone(row.score, row.direction || 'risk'),
    evidenceCount: row.topCompanies?.reduce((sum, company) => sum + (company.score || 0), 0) || 0,
  }));
}

function buildExposureIndexes(lenses, companies, tradeBookAtlas) {
  const credit = findLens(lenses, 'credit-banks');
  const realEstate = findLens(lenses, 'real-estate');
  const housing = findLens(lenses, 'housing');
  const energy = findLens(lenses, 'energy-commodities');
  const consumer = findLens(lenses, 'consumer-demand');
  const ai = findLens(lenses, 'ai-infrastructure');
  const utilities = findLens(lenses, 'utilities-rates');

  const activity = (id) => tradeBookAtlas.assetClasses.find((item) => item.id === id) || { textMentions: 0, conceptCount: 0, companies: [] };

  const makeIndex = ({ id, label, description, direction = 'risk', score, components, leaders }) => ({
    id,
    label,
    description,
    direction,
    score: clamp(score, 0, 100),
    tone: scoreToTone(clamp(score, 0, 100), direction),
    components,
    leaders: (leaders || []).slice(0, 5),
  });

  return [
    makeIndex({
      id: 'credit-stress',
      label: 'SEC Credit Stress Index',
      description: 'Provisioning, loan growth, credit-risk language, deposit/loan coverage, and financial-sector balance-sheet pressure.',
      score: (credit?.averages.provisionToLoans || 0) * 20 + Math.max(0, 50 - (credit?.breadth.positiveRevenuePct || 0)) + normalizeScore(activity('credit').textMentions, 220) * 0.45,
      components: [
        { label: 'Provision / loans', value: credit?.averages.provisionToLoans },
        { label: 'Positive growth breadth', value: credit?.breadth.positiveRevenuePct },
        { label: 'Credit-risk mentions', value: activity('credit').textMentions },
      ],
      leaders: activity('credit').companies,
    }),
    makeIndex({
      id: 'rate-sensitivity',
      label: 'Rate Sensitivity Index',
      description: 'Interest burden, rate-risk language, swap references, utility financing pressure, and balance-sheet leverage.',
      score: (utilities?.averages.interestBurden || 0) * 9 + normalizeScore(activity('rates').textMentions, 220) * 0.68 + mean(companies.map((company) => company.derived.debtToAssets)) * 0.24,
      components: [
        { label: 'Interest burden', value: utilities?.averages.interestBurden },
        { label: 'Rate-risk mentions', value: activity('rates').textMentions },
        { label: 'Average debt/assets', value: mean(companies.map((company) => company.derived.debtToAssets)) },
      ],
      leaders: activity('rates').companies,
    }),
    makeIndex({
      id: 'cre-refinancing',
      label: 'CRE Refinancing Pressure Index',
      description: 'REIT leverage, occupancy/rent/refinancing language, real-estate growth breadth, and housing-related inventory signals.',
      score: (realEstate?.averages.liabilitiesToAssets || 0) * 0.52 + Math.max(0, 50 - (realEstate?.breadth.positiveRevenuePct || 0)) + (housing?.averages.inventoryToSales || 0) * 0.35,
      components: [
        { label: 'RE liabilities/assets', value: realEstate?.averages.liabilitiesToAssets },
        { label: 'RE growth breadth', value: realEstate?.breadth.positiveRevenuePct },
        { label: 'Housing inventory/sales', value: housing?.averages.inventoryToSales },
      ],
      leaders: realEstate?.laggards || [],
    }),
    makeIndex({
      id: 'ai-infra-demand',
      label: 'AI Infrastructure Demand Index',
      description: 'Semiconductor/hyperscale growth, capex intensity, R&D intensity, and data-center/AI disclosure language.',
      direction: 'growth',
      score: 48 + (ai?.averages.revenueGrowth || 0) * 0.65 + (ai?.averages.capexIntensity || 0) * 1.1 + (ai?.averages.rndIntensity || 0) * 0.75,
      components: [
        { label: 'Revenue growth', value: ai?.averages.revenueGrowth },
        { label: 'Capex intensity', value: ai?.averages.capexIntensity },
        { label: 'R&D intensity', value: ai?.averages.rndIntensity },
      ],
      leaders: ai?.leaders || [],
    }),
    makeIndex({
      id: 'commodity-hedge',
      label: 'Commodity Hedge Pressure Index',
      description: 'Commodity-risk language, energy cash-flow volatility, capex intensity, and fuel/commodity derivative disclosures.',
      score: normalizeScore(activity('commodities').textMentions, 260) * 0.55 + Math.abs(energy?.averages.revenueGrowth || 0) * 0.85 + (energy?.averages.capexIntensity || 0) * 0.8,
      components: [
        { label: 'Commodity mentions', value: activity('commodities').textMentions },
        { label: 'Energy growth', value: energy?.averages.revenueGrowth },
        { label: 'Energy capex intensity', value: energy?.averages.capexIntensity },
      ],
      leaders: activity('commodities').companies,
    }),
    makeIndex({
      id: 'consumer-strain',
      label: 'Consumer Strain Index',
      description: 'Inventory/sales, margin pressure, weak revenue breadth, markdown language, and consumer-demand disclosure pressure.',
      score: Math.max(0, 52 - (consumer?.breadth.positiveRevenuePct || 0)) + (consumer?.averages.inventoryToSales || 0) * 1.1 + Math.max(0, -(consumer?.averages.operatingMargin || 0)) * 1.2,
      components: [
        { label: 'Positive revenue breadth', value: consumer?.breadth.positiveRevenuePct },
        { label: 'Inventory/sales', value: consumer?.averages.inventoryToSales },
        { label: 'Operating margin', value: consumer?.averages.operatingMargin },
      ],
      leaders: consumer?.laggards || [],
    }),
    makeIndex({
      id: 'liquidity-collateral',
      label: 'Liquidity & Collateral Pressure Index',
      description: 'Liquidity, collateral, margin, netting, leverage, and derivative-liability signals.',
      score: normalizeScore(activity('liquidity').textMentions, 260) * 0.55 + mean(companies.map((company) => company.derived.liabilitiesToAssets)) * 0.32 + normalizeScore(activity('derivatives').companyCount, 50) * 0.18,
      components: [
        { label: 'Liquidity/collateral mentions', value: activity('liquidity').textMentions },
        { label: 'Average liabilities/assets', value: mean(companies.map((company) => company.derived.liabilitiesToAssets)) },
        { label: 'Derivative filers', value: activity('derivatives').companyCount },
      ],
      leaders: activity('liquidity').companies,
    }),
    makeIndex({
      id: 'derivative-book-activity',
      label: 'Derivative Book Activity Index',
      description: 'Derivative XBRL concept density, derivative language, swaps/forwards/options/futures references, and market-risk disclosures.',
      score: normalizeScore(activity('derivatives').conceptCount, 360) * 0.6 + normalizeScore(activity('derivatives').textMentions, 420) * 0.4,
      components: [
        { label: 'Derivative XBRL concepts', value: activity('derivatives').conceptCount },
        { label: 'Derivative text mentions', value: activity('derivatives').textMentions },
        { label: 'Derivative signal filers', value: activity('derivatives').companyCount },
      ],
      leaders: activity('derivatives').companies,
    }),
  ];
}

function aggregateDerivativesDashboard(companies, tradeBookAtlas) {
  const usable = companies.filter((company) => !company.error);
  const derivativeCompanies = usable
    .map((company) => {
      const textCount = company.marketRiskProfile?.termCounts?.derivatives || 0;
      const conceptCount = company.derivativeSummary?.conceptCount || 0;
      const score = textCount + conceptCount * 2;

      return {
        ticker: company.ticker,
        name: company.name,
        conceptCount,
        textCount,
        score,
        assetValue: company.derivativeSummary?.assetValue || 0,
        liabilityValue: company.derivativeSummary?.liabilityValue || 0,
        notionalValue: company.derivativeSummary?.notionalValue || 0,
        portfolioType: company.marketRiskProfile?.portfolioType || 'undetermined',
        latestFilingUrl: company.marketRiskProfile?.url || null,
        excerpts: company.marketRiskProfile?.excerpts?.filter((excerpt) => excerpt.category === 'derivatives').slice(0, 2) || [],
      };
    })
    .filter((company) => company.score > 0)
    .sort((a, b) => b.score - a.score);

  const allConcepts = usable.flatMap((company) => company.derivativeConcepts || []);
  const byAssetClass = groupConcepts(allConcepts, 'assetClass').sort((a, b) => b.conceptCount - a.conceptCount);
  const byInstrument = groupConcepts(allConcepts, 'instrument').sort((a, b) => b.conceptCount - a.conceptCount);

  return {
    summary: {
      companiesWithSignals: derivativeCompanies.length,
      conceptsExtracted: allConcepts.length,
      textFilersScanned: tradeBookAtlas.scannedFilers,
      aggregateDerivativeAssets: derivativeCompanies.reduce((sum, company) => sum + company.assetValue, 0),
      aggregateDerivativeLiabilities: derivativeCompanies.reduce((sum, company) => sum + company.liabilityValue, 0),
      aggregateDerivativeNotional: derivativeCompanies.reduce((sum, company) => sum + company.notionalValue, 0),
    },
    companies: derivativeCompanies.slice(0, 25),
    byAssetClass,
    byInstrument,
  };
}


function sumMetric(companies, key) {
  return companies.reduce((sum, company) => {
    const value = company?.metrics?.[key]?.latest;
    return sum + (value != null && Number.isFinite(value) ? value : 0);
  }, 0);
}

function sumAbsMetric(companies, key) {
  return companies.reduce((sum, company) => {
    const value = company?.metrics?.[key]?.latest;
    return sum + (value != null && Number.isFinite(value) ? Math.abs(value) : 0);
  }, 0);
}

function buildAggregateUniverse(companies, lenses, tradeBookAtlas, derivativesDashboard) {
  const usable = companies.filter((company) => !company.error);

  const totalAssets = sumMetric(usable, 'totalAssets');
  const totalLiabilities = sumMetric(usable, 'totalLiabilities');
  const totalRevenue = sumMetric(usable, 'revenue');
  const totalOperatingCashFlow = sumMetric(usable, 'operatingCashFlow');
  const totalCapex = sumAbsMetric(usable, 'capex');
  const totalInventory = sumMetric(usable, 'inventory');
  const totalCash = sumMetric(usable, 'cash');
  const totalShortTermInvestments = sumMetric(usable, 'shortTermInvestments');
  const totalDebt = sumAbsMetric(usable, 'shortTermDebt') + sumAbsMetric(usable, 'longTermDebt');

  const derivativeAssets = derivativesDashboard?.summary?.aggregateDerivativeAssets || 0;
  const derivativeLiabilities = derivativesDashboard?.summary?.aggregateDerivativeLiabilities || 0;
  const derivativeNotional = derivativesDashboard?.summary?.aggregateDerivativeNotional || 0;

  const xbrlFactsIdentified = usable.reduce((sum, company) => {
    return sum + Object.values(company.metrics || {}).filter((metric) => metric?.source).length;
  }, 0);

  const totalTextMentions = (tradeBookAtlas?.assetClasses || [])
    .reduce((sum, row) => sum + (row.textMentions || 0), 0);

  const totalDerivativeConcepts = derivativesDashboard?.summary?.conceptsExtracted || 0;

  const riskTotals = (tradeBookAtlas?.assetClasses || []).map((row) => ({
    id: row.id,
    label: row.label,
    companyCount: row.companyCount || 0,
    textMentions: row.textMentions || 0,
    conceptCount: row.conceptCount || 0,
    signalMass: (row.textMentions || 0) + (row.conceptCount || 0) * 3,
    topTickers: (row.companies || []).slice(0, 8).map((company) => company.ticker),
  })).sort((a, b) => b.signalMass - a.signalMass);

  const capitalStack = [
    {
      id: 'assets',
      label: 'Total assets identified',
      value: totalAssets,
      kind: 'currency',
      description: 'Aggregate latest total assets across covered SEC Company Facts filers.',
    },
    {
      id: 'liabilities',
      label: 'Total liabilities identified',
      value: totalLiabilities,
      kind: 'currency',
      description: 'Aggregate latest total liabilities across covered filers.',
    },
    {
      id: 'debt',
      label: 'Debt identified',
      value: totalDebt,
      kind: 'currency',
      description: 'Short-term plus long-term debt where identifiable in XBRL.',
    },
    {
      id: 'cash-investments',
      label: 'Cash + short-term investments',
      value: totalCash + totalShortTermInvestments,
      kind: 'currency',
      description: 'Cash and short-term investments where reported.',
    },
    {
      id: 'revenue',
      label: 'Revenue identified',
      value: totalRevenue,
      kind: 'currency',
      description: 'Aggregate latest annual revenue across covered filers.',
    },
    {
      id: 'operating-cash-flow',
      label: 'Operating cash flow',
      value: totalOperatingCashFlow,
      kind: 'currency',
      description: 'Aggregate operating cash flow across covered filers.',
    },
    {
      id: 'capex',
      label: 'Capex identified',
      value: totalCapex,
      kind: 'currency',
      description: 'Payments to acquire property, plant, and equipment where available.',
    },
    {
      id: 'inventory',
      label: 'Inventory identified',
      value: totalInventory,
      kind: 'currency',
      description: 'Aggregate inventory balance where reported.',
    },
    {
      id: 'derivative-assets',
      label: 'Derivative fair-value assets',
      value: derivativeAssets,
      kind: 'currency',
      description: 'Derivative-related XBRL concepts classified as assets.',
    },
    {
      id: 'derivative-liabilities',
      label: 'Derivative fair-value liabilities',
      value: derivativeLiabilities,
      kind: 'currency',
      description: 'Derivative-related XBRL concepts classified as liabilities.',
    },
    {
      id: 'derivative-notional',
      label: 'Derivative notional identified',
      value: derivativeNotional,
      kind: 'currency',
      description: 'Derivative notional values where identifiable from XBRL concepts.',
    },
    {
      id: 'xbrl-facts',
      label: 'XBRL facts used',
      value: xbrlFactsIdentified,
      kind: 'count',
      description: 'Metric facts used in the market map scoring layer.',
    },
  ];

  return {
    scope: 'Covered SEC filing universe',
    companyCount: usable.length,
    lensCount: lenses.length,
    latestFiled: latestDate(usable.flatMap((company) => company.filedDates)),
    totalAssets,
    totalLiabilities,
    totalDebt,
    totalCashAndShortTermInvestments: totalCash + totalShortTermInvestments,
    totalRevenue,
    totalOperatingCashFlow,
    totalCapex,
    totalInventory,
    derivativeAssets,
    derivativeLiabilities,
    derivativeNotional,
    xbrlFactsIdentified,
    totalTextMentions,
    totalDerivativeConcepts,
    capitalStack,
    riskTotals,
    lensMass: lenses.map((lens) => ({
      id: lens.id,
      assetClass: lens.assetClass,
      title: lens.title,
      loadedTickers: lens.loadedTickers,
      evidenceCount: lens.evidenceCount,
      score: lens.score,
      tone: lens.tone,
      totalAssets: sumMetric(
        usable.filter((company) => lens.loadedTickers.includes(company.ticker)),
        'totalAssets'
      ),
      totalRevenue: sumMetric(
        usable.filter((company) => lens.loadedTickers.includes(company.ticker)),
        'revenue'
      ),
    })).sort((a, b) => b.totalAssets - a.totalAssets),
  };
}

function findRisk(tradeBookAtlas, id) {
  return (tradeBookAtlas?.assetClasses || []).find((item) => item.id === id) || {
    textMentions: 0,
    conceptCount: 0,
    companyCount: 0,
    companies: [],
  };
}

function findLensById(lenses, id) {
  return lenses.find((lens) => lens.id === id);
}




function buildGeographicExposure(lenses, tradeBookAtlas, derivativesDashboard, aggregateUniverse) {
  const aggregate = aggregateUniverse || {};
  const risks = tradeBookAtlas?.assetClasses || [];

  const n = (value, fallback = 0) => {
    return Number.isFinite(value) ? value : fallback;
  };

  const lens = (id) => lenses.find((item) => item.id === id) || null;
  const mass = (id) => (aggregate.lensMass || []).find((item) => item.id === id) || {
    totalAssets: 0,
    totalRevenue: 0,
    loadedTickers: [],
    evidenceCount: 0,
    score: 0,
  };

  const risk = (id) => risks.find((item) => item.id === id) || {
    id,
    label: id,
    textMentions: 0,
    conceptCount: 0,
    companyCount: 0,
    companies: [],
  };

  const uniqueTickersLocal = (...items) => {
    const seen = new Set();
    const out = [];

    for (const item of items.flat(3)) {
      const ticker = typeof item === 'string' ? item : item?.ticker;
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push(ticker);
    }

    return out.slice(0, 12);
  };

  const combine = (...values) => values.reduce((sum, value) => sum + n(value), 0);

  const makeTimeline = (metrics) => [{ label: 'Scenario', period: 'Scenario', note: 'Illustrative allocation of current company data; no historical geographic observations.', metricByMode: metrics }];

  const mk = ({
    id,
    name,
    shortName,
    city,
    country,
    lat,
    lon,
    type,
    tone,
    intensity,
    metricLabel,
    description,
    drivers,
    tickers,
    confidence,
    evidenceCount,
    sourceBasis,
    metrics,
    outboundFlows,
  }) => ({
    id,
    name,
    shortName,
    city,
    country,
    lat,
    lon,
    type,
    intensity,
    tone,
    metric: metrics.assets || metrics.revenue || metrics.mentions || intensity,
    metricLabel,
    description,
    drivers,
    tickers,
    confidence,
    evidenceCount,
    sourceBasis,
    metricByMode: metrics,
    timeSeries: makeTimeline(metrics),
    outboundFlows: outboundFlows || [],
  });

  const creditLens = lens('credit-banks');
  const privateCapitalLens = lens('private-capital');
  const realEstateLens = lens('real-estate');
  const housingLens = lens('housing');
  const energyLens = lens('energy-commodities');
  const consumerLens = lens('consumer-demand');
  const aiLens = lens('ai-infrastructure');
  const softwareLens = lens('software-security');
  const insuranceLens = lens('insurance');
  const transportLens = lens('transport-cyclicals');
  const utilitiesLens = lens('utilities-rates');
  const industrialLens = lens('industrial-capex');

  const creditMass = mass('credit-banks');
  const privateMass = mass('private-capital');
  const realEstateMass = mass('real-estate');
  const housingMass = mass('housing');
  const energyMass = mass('energy-commodities');
  const consumerMass = mass('consumer-demand');
  const aiMass = mass('ai-infrastructure');
  const softwareMass = mass('software-security');
  const insuranceMass = mass('insurance');
  const transportMass = mass('transport-cyclicals');
  const utilitiesMass = mass('utilities-rates');
  const industrialMass = mass('industrial-capex');

  const rates = risk('rates');
  const fx = risk('fx');
  const commodities = risk('commodities');
  const credit = risk('credit');
  const liquidity = risk('liquidity');
  const derivatives = risk('derivatives');
  const tradingBook = risk('tradingBook');

  const derivativeAssets = n(derivativesDashboard?.summary?.aggregateDerivativeAssets);
  const derivativeLiabilities = n(derivativesDashboard?.summary?.aggregateDerivativeLiabilities);
  const derivativeNotional = n(derivativesDashboard?.summary?.aggregateDerivativeNotional);
  const derivativeTotal = derivativeAssets + derivativeLiabilities + derivativeNotional;

  const totalAssets = n(aggregate.totalAssets);
  const totalLiabilities = n(aggregate.totalLiabilities);
  const totalDebt = n(aggregate.totalDebt);
  const totalCash = n(aggregate.totalCashAndShortTermInvestments);
  const totalRevenue = n(aggregate.totalRevenue);
  const totalCapex = n(aggregate.totalCapex);
  const totalMentions = n(aggregate.totalTextMentions);

  return [
    mk({
      id: 'washington-sec-aggregate',
      name: 'Washington, D.C. / aggregate SEC filing universe',
      shortName: 'SEC Aggregate',
      city: 'Washington, D.C.',
      country: 'United States',
      lat: 38.9072,
      lon: -77.0369,
      type: 'aggregate',
      tone: 'core',
      intensity: 100,
      metricLabel: 'aggregate SEC filing universe',
      description: 'The broad covered EDGAR filing universe aggregated into balance-sheet, revenue, debt, cash, capex, derivative, and market-risk exposure totals.',
      drivers: ['Total assets', 'Total liabilities', 'Debt', 'Revenue', 'XBRL facts'],
      tickers: uniqueTickersLocal(creditMass.loadedTickers, aiMass.loadedTickers, energyMass.loadedTickers),
      confidence: 'High',
      evidenceCount: n(aggregate.xbrlFactsIdentified),
      sourceBasis: 'Aggregated XBRL Company Facts from the covered SEC filing universe.',
      pattern: 'steady',
      metrics: {
        assets: totalAssets,
        liabilities: totalLiabilities,
        debt: totalDebt,
        cash: totalCash,
        revenue: totalRevenue,
        capex: totalCapex,
        derivatives: derivativeTotal,
        mentions: totalMentions,
        intensity: 100,
      },
      outboundFlows: [
        { targetId: 'new-york-financial-risk', theme: 'financial risk books', weight: 96, metricMode: 'derivatives' },
        { targetId: 'northern-virginia-data-centers', theme: 'AI infrastructure capex', weight: 76, metricMode: 'capex' },
        { targetId: 'houston-energy-corridor', theme: 'commodity exposure', weight: 72, metricMode: 'capex' },
      ],
    }),

    mk({
      id: 'new-york-financial-risk',
      name: 'New York / financial risk books',
      shortName: 'Financial Risk',
      city: 'New York',
      country: 'United States',
      lat: 40.7128,
      lon: -74.0060,
      type: 'risk-book',
      tone: 'risk',
      intensity: Math.min(100, 40 + derivatives.companyCount + rates.companyCount + credit.companyCount),
      metricLabel: 'financial risk book exposure',
      description: 'Rates, credit, liquidity, derivative, trading-book, and market-risk disclosures concentrated in banks, brokers, asset managers, and market-structure filers.',
      drivers: ['Rates', 'Credit', 'Derivatives', 'Liquidity', 'Trading books'],
      tickers: uniqueTickersLocal(credit.companies, rates.companies, derivatives.companies, creditMass.loadedTickers, privateMass.loadedTickers),
      confidence: 'High',
      evidenceCount: combine(credit.textMentions, rates.textMentions, liquidity.textMentions, derivatives.conceptCount, tradingBook.textMentions),
      sourceBasis: 'Derivative XBRL concepts plus bounded 10-K/10-Q market-risk text scan.',
      pattern: 'risk',
      metrics: {
        assets: combine(creditMass.totalAssets, privateMass.totalAssets),
        liabilities: combine(creditMass.totalAssets * 0.78, derivativeLiabilities),
        debt: totalDebt * 0.42,
        cash: totalCash * 0.38,
        revenue: combine(creditMass.totalRevenue, privateMass.totalRevenue),
        capex: totalCapex * 0.08,
        derivatives: derivativeTotal,
        mentions: combine(credit.textMentions, rates.textMentions, liquidity.textMentions, derivatives.textMentions, tradingBook.textMentions),
        intensity: Math.min(100, 40 + derivatives.companyCount * 2 + rates.companyCount + credit.companyCount),
      },
      outboundFlows: [
        { targetId: 'london-fx-rates', theme: 'FX and rates corridor', weight: 78, metricMode: 'mentions' },
        { targetId: 'chicago-derivatives-exchanges', theme: 'derivative market structure', weight: 84, metricMode: 'derivatives' },
        { targetId: 'charlotte-credit-cards', theme: 'consumer credit exposure', weight: 56, metricMode: 'debt' },
      ],
    }),

    mk({
      id: 'chicago-derivatives-exchanges',
      name: 'Chicago / derivatives and exchange risk',
      shortName: 'Derivatives Hub',
      city: 'Chicago',
      country: 'United States',
      lat: 41.8781,
      lon: -87.6298,
      type: 'derivatives',
      tone: 'risk',
      intensity: Math.min(100, 35 + derivatives.conceptCount / 4 + tradingBook.companyCount * 2),
      metricLabel: 'derivative market structure',
      description: 'Exchange, futures, options, clearing, trading, derivative, and market-structure exposure proxy.',
      drivers: ['Futures', 'Options', 'Clearing', 'Trading', 'Market risk'],
      tickers: uniqueTickersLocal(derivatives.companies, privateMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: combine(derivatives.conceptCount, derivatives.textMentions, tradingBook.textMentions),
      sourceBasis: 'Derivative concepts and exchange / trading-book disclosure language.',
      pattern: 'risk',
      metrics: {
        assets: privateMass.totalAssets * 0.45,
        liabilities: privateMass.totalAssets * 0.32,
        debt: totalDebt * 0.08,
        cash: totalCash * 0.06,
        revenue: privateMass.totalRevenue * 0.55,
        capex: totalCapex * 0.03,
        derivatives: derivativeTotal * 0.32,
        mentions: combine(derivatives.textMentions, tradingBook.textMentions),
        intensity: Math.min(100, 35 + derivatives.conceptCount / 4),
      },
      outboundFlows: [
        { targetId: 'new-york-financial-risk', theme: 'clearing and trading risk', weight: 82, metricMode: 'derivatives' },
        { targetId: 'london-fx-rates', theme: 'global market structure', weight: 42, metricMode: 'mentions' },
      ],
    }),

    mk({
      id: 'charlotte-credit-cards',
      name: 'Charlotte / bank and consumer credit exposure',
      shortName: 'Bank Credit',
      city: 'Charlotte',
      country: 'United States',
      lat: 35.2271,
      lon: -80.8431,
      type: 'credit',
      tone: 'risk',
      intensity: Math.min(100, 35 + n(creditLens?.evidenceCount) / 6),
      metricLabel: 'credit and deposit exposure',
      description: 'Large-bank, deposit, consumer-credit, provisioning, and charge-off exposure proxy.',
      drivers: ['Deposits', 'Provisioning', 'Credit losses', 'Loans'],
      tickers: uniqueTickersLocal(creditMass.loadedTickers, credit.companies),
      confidence: 'High',
      evidenceCount: combine(n(creditLens?.evidenceCount), credit.textMentions),
      sourceBasis: 'Bank XBRL metrics plus credit-risk filing language.',
      pattern: 'risk',
      metrics: {
        assets: creditMass.totalAssets * 0.55,
        liabilities: creditMass.totalAssets * 0.48,
        debt: totalDebt * 0.16,
        cash: totalCash * 0.14,
        revenue: creditMass.totalRevenue * 0.45,
        capex: totalCapex * 0.02,
        derivatives: derivativeTotal * 0.08,
        mentions: combine(credit.textMentions, n(creditLens?.evidenceCount)),
        intensity: Math.min(100, 35 + n(creditLens?.score)),
      },
      outboundFlows: [
        { targetId: 'new-york-financial-risk', theme: 'credit to capital markets', weight: 64, metricMode: 'debt' },
        { targetId: 'north-america-consumer-housing', theme: 'consumer credit and housing demand', weight: 48, metricMode: 'revenue' },
      ],
    }),

    mk({
      id: 'northern-virginia-data-centers',
      name: 'Northern Virginia / data centers and power demand',
      shortName: 'Data Centers',
      city: 'Ashburn',
      country: 'United States',
      lat: 39.0438,
      lon: -77.4874,
      type: 'ai-infrastructure',
      tone: 'growth',
      intensity: Math.min(100, 38 + n(aiLens?.score)),
      metricLabel: 'AI infrastructure and power demand',
      description: 'Data-center, hyperscale cloud, AI infrastructure, grid, power demand, and utility capex exposure proxy.',
      drivers: ['AI capex', 'Data centers', 'Cloud', 'Grid', 'Power demand'],
      tickers: uniqueTickersLocal(aiMass.loadedTickers, utilitiesMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: combine(n(aiLens?.evidenceCount), n(utilitiesLens?.evidenceCount)),
      sourceBasis: 'AI infrastructure and utility cohort XBRL metrics plus data-center / power disclosure themes.',
      pattern: 'growth',
      metrics: {
        assets: combine(aiMass.totalAssets * 0.42, utilitiesMass.totalAssets * 0.28),
        liabilities: combine(aiMass.totalAssets * 0.18, utilitiesMass.totalAssets * 0.2),
        debt: totalDebt * 0.12,
        cash: totalCash * 0.12,
        revenue: combine(aiMass.totalRevenue * 0.35, utilitiesMass.totalRevenue * 0.18),
        capex: totalCapex * 0.36,
        derivatives: derivativeTotal * 0.03,
        mentions: combine(n(aiLens?.evidenceCount), n(utilitiesLens?.evidenceCount)),
        intensity: Math.min(100, 38 + n(aiLens?.score)),
      },
      outboundFlows: [
        { targetId: 'san-francisco-software-ai', theme: 'AI demand to software/platforms', weight: 76, metricMode: 'revenue' },
        { targetId: 'taipei-semiconductor-supply', theme: 'accelerator and chip supply', weight: 92, metricMode: 'capex' },
        { targetId: 'seattle-cloud-commerce', theme: 'cloud infrastructure', weight: 74, metricMode: 'capex' },
      ],
    }),

    mk({
      id: 'san-francisco-software-ai',
      name: 'San Francisco Bay Area / software and AI platforms',
      shortName: 'Software AI',
      city: 'San Francisco',
      country: 'United States',
      lat: 37.7749,
      lon: -122.4194,
      type: 'software-ai',
      tone: 'growth',
      intensity: Math.min(100, 32 + n(softwareLens?.score) + n(aiLens?.score) * 0.25),
      metricLabel: 'software and AI revenue exposure',
      description: 'Software, cloud applications, cybersecurity, AI monetization, subscription revenue, and platform exposure proxy.',
      drivers: ['Software', 'Cybersecurity', 'AI monetization', 'Subscriptions'],
      tickers: uniqueTickersLocal(softwareMass.loadedTickers, aiMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: combine(n(softwareLens?.evidenceCount), n(aiLens?.evidenceCount)),
      sourceBasis: 'Software and AI cohort XBRL metrics and disclosure themes.',
      pattern: 'growth',
      metrics: {
        assets: combine(softwareMass.totalAssets, aiMass.totalAssets * 0.25),
        liabilities: combine(softwareMass.totalAssets * 0.28, aiMass.totalAssets * 0.12),
        debt: totalDebt * 0.07,
        cash: totalCash * 0.18,
        revenue: combine(softwareMass.totalRevenue, aiMass.totalRevenue * 0.18),
        capex: totalCapex * 0.12,
        derivatives: derivativeTotal * 0.04,
        mentions: combine(n(softwareLens?.evidenceCount), n(aiLens?.evidenceCount)),
        intensity: Math.min(100, 35 + n(softwareLens?.score)),
      },
      outboundFlows: [
        { targetId: 'northern-virginia-data-centers', theme: 'cloud/data-center demand', weight: 82, metricMode: 'capex' },
        { targetId: 'london-fx-rates', theme: 'multinational FX exposure', weight: 44, metricMode: 'mentions' },
      ],
    }),

    mk({
      id: 'seattle-cloud-commerce',
      name: 'Seattle / cloud, commerce, and logistics',
      shortName: 'Cloud Commerce',
      city: 'Seattle',
      country: 'United States',
      lat: 47.6062,
      lon: -122.3321,
      type: 'cloud-retail',
      tone: 'growth',
      intensity: Math.min(100, 28 + n(aiLens?.score) * 0.45 + n(consumerLens?.score) * 0.18),
      metricLabel: 'cloud and retail exposure',
      description: 'Cloud, digital infrastructure, ecommerce, retail demand, and fulfillment exposure proxy.',
      drivers: ['Cloud', 'Ecommerce', 'Fulfillment', 'Consumer demand'],
      tickers: uniqueTickersLocal(aiMass.loadedTickers, consumerMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: combine(n(aiLens?.evidenceCount), n(consumerLens?.evidenceCount)),
      sourceBasis: 'Cloud/platform and consumer cohort XBRL data plus filing language proxies.',
      pattern: 'growth',
      metrics: {
        assets: combine(aiMass.totalAssets * 0.32, consumerMass.totalAssets * 0.18),
        liabilities: combine(aiMass.totalAssets * 0.15, consumerMass.totalAssets * 0.12),
        debt: totalDebt * 0.06,
        cash: totalCash * 0.1,
        revenue: combine(aiMass.totalRevenue * 0.28, consumerMass.totalRevenue * 0.24),
        capex: totalCapex * 0.2,
        derivatives: derivativeTotal * 0.03,
        mentions: combine(n(aiLens?.evidenceCount), n(consumerLens?.evidenceCount)),
        intensity: Math.min(100, 28 + n(aiLens?.score)),
      },
      outboundFlows: [
        { targetId: 'northern-virginia-data-centers', theme: 'cloud infrastructure', weight: 74, metricMode: 'capex' },
        { targetId: 'los-angeles-pacific-trade', theme: 'commerce and fulfillment', weight: 48, metricMode: 'revenue' },
      ],
    }),

    mk({
      id: 'houston-energy-corridor',
      name: 'Houston / energy and commodity risk',
      shortName: 'Energy Corridor',
      city: 'Houston',
      country: 'United States',
      lat: 29.7604,
      lon: -95.3698,
      type: 'commodity',
      tone: 'commodity',
      intensity: Math.min(100, 34 + commodities.companyCount * 2 + n(energyLens?.score) * 0.35),
      metricLabel: 'commodity and energy exposure',
      description: 'Oil, gas, LNG, energy services, commodity prices, production, reserves, refinery margin, capex, and hedge exposure proxy.',
      drivers: ['Oil', 'Gas', 'LNG', 'Fuel hedging', 'Capex'],
      tickers: uniqueTickersLocal(energyMass.loadedTickers, commodities.companies),
      confidence: 'Medium',
      evidenceCount: combine(commodities.textMentions, n(energyLens?.evidenceCount)),
      sourceBasis: 'Energy/materials cohort XBRL data plus commodity-risk text scan.',
      pattern: 'risk',
      metrics: {
        assets: energyMass.totalAssets,
        liabilities: energyMass.totalAssets * 0.48,
        debt: totalDebt * 0.13,
        cash: totalCash * 0.08,
        revenue: energyMass.totalRevenue,
        capex: totalCapex * 0.22,
        derivatives: derivativeTotal * 0.08,
        mentions: combine(commodities.textMentions, n(energyLens?.evidenceCount)),
        intensity: Math.min(100, 34 + commodities.companyCount * 2),
      },
      outboundFlows: [
        { targetId: 'dallas-transport-logistics', theme: 'fuel and logistics exposure', weight: 66, metricMode: 'derivatives' },
        { targetId: 'dubai-gulf-energy', theme: 'global commodity corridor', weight: 70, metricMode: 'mentions' },
      ],
    }),

    mk({
      id: 'dallas-transport-logistics',
      name: 'Dallas-Fort Worth / airlines and logistics',
      shortName: 'Transport Logistics',
      city: 'Dallas-Fort Worth',
      country: 'United States',
      lat: 32.7767,
      lon: -96.7970,
      type: 'transport',
      tone: 'cyclical',
      intensity: Math.min(100, 24 + n(transportLens?.score)),
      metricLabel: 'transport and fuel exposure',
      description: 'Airlines, parcel, freight, fuel, capacity, labor, and logistics-cycle exposure proxy.',
      drivers: ['Airlines', 'Freight', 'Fuel', 'Capacity', 'Labor'],
      tickers: uniqueTickersLocal(transportMass.loadedTickers, commodities.companies),
      confidence: 'Medium',
      evidenceCount: combine(n(transportLens?.evidenceCount), commodities.textMentions),
      sourceBasis: 'Transport cohort XBRL data and fuel/commodity market-risk language.',
      pattern: 'risk',
      metrics: {
        assets: transportMass.totalAssets,
        liabilities: transportMass.totalAssets * 0.55,
        debt: totalDebt * 0.07,
        cash: totalCash * 0.04,
        revenue: transportMass.totalRevenue,
        capex: totalCapex * 0.07,
        derivatives: derivativeTotal * 0.04,
        mentions: combine(n(transportLens?.evidenceCount), commodities.textMentions),
        intensity: Math.min(100, 24 + n(transportLens?.score)),
      },
      outboundFlows: [
        { targetId: 'los-angeles-pacific-trade', theme: 'Pacific trade and freight', weight: 52, metricMode: 'revenue' },
        { targetId: 'houston-energy-corridor', theme: 'fuel hedge exposure', weight: 58, metricMode: 'derivatives' },
      ],
    }),

    mk({
      id: 'los-angeles-pacific-trade',
      name: 'Los Angeles / Pacific trade and consumer import exposure',
      shortName: 'Pacific Trade',
      city: 'Los Angeles',
      country: 'United States',
      lat: 34.0522,
      lon: -118.2437,
      type: 'trade',
      tone: 'demand',
      intensity: Math.min(100, 25 + n(consumerLens?.score) + n(transportLens?.score) * 0.28),
      metricLabel: 'trade and consumer exposure',
      description: 'Consumer import, logistics, retail, inventory, Pacific trade, apparel, and transport exposure proxy.',
      drivers: ['Pacific trade', 'Retail', 'Inventory', 'Freight'],
      tickers: uniqueTickersLocal(consumerMass.loadedTickers, transportMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: combine(n(consumerLens?.evidenceCount), n(transportLens?.evidenceCount)),
      sourceBasis: 'Consumer and transport cohort data plus logistics / inventory disclosure signals.',
      pattern: 'steady',
      metrics: {
        assets: combine(consumerMass.totalAssets * 0.28, transportMass.totalAssets * 0.18),
        liabilities: combine(consumerMass.totalAssets * 0.18, transportMass.totalAssets * 0.12),
        debt: totalDebt * 0.05,
        cash: totalCash * 0.04,
        revenue: combine(consumerMass.totalRevenue * 0.32, transportMass.totalRevenue * 0.2),
        capex: totalCapex * 0.08,
        derivatives: derivativeTotal * 0.02,
        mentions: combine(n(consumerLens?.evidenceCount), n(transportLens?.evidenceCount)),
        intensity: Math.min(100, 25 + n(consumerLens?.score)),
      },
      outboundFlows: [
        { targetId: 'shanghai-supply-chain', theme: 'import and supply chain exposure', weight: 72, metricMode: 'mentions' },
        { targetId: 'seattle-cloud-commerce', theme: 'commerce fulfillment exposure', weight: 40, metricMode: 'revenue' },
      ],
    }),

    mk({
      id: 'atlanta-consumer-logistics',
      name: 'Atlanta / consumer, payments, and logistics',
      shortName: 'Consumer Logistics',
      city: 'Atlanta',
      country: 'United States',
      lat: 33.749,
      lon: -84.388,
      type: 'consumer-logistics',
      tone: 'demand',
      intensity: Math.min(100, 24 + n(consumerLens?.score) * 0.65 + n(transportLens?.score) * 0.32),
      metricLabel: 'consumer and logistics exposure',
      description: 'Consumer demand, payments, logistics, restaurants, travel, and distribution exposure proxy.',
      drivers: ['Consumer demand', 'Payments', 'Logistics', 'Travel'],
      tickers: uniqueTickersLocal(consumerMass.loadedTickers, transportMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: combine(n(consumerLens?.evidenceCount), n(transportLens?.evidenceCount)),
      sourceBasis: 'Consumer and transport filing cohorts.',
      pattern: 'steady',
      metrics: {
        assets: combine(consumerMass.totalAssets * 0.2, transportMass.totalAssets * 0.14),
        liabilities: combine(consumerMass.totalAssets * 0.12, transportMass.totalAssets * 0.1),
        debt: totalDebt * 0.04,
        cash: totalCash * 0.03,
        revenue: combine(consumerMass.totalRevenue * 0.2, transportMass.totalRevenue * 0.15),
        capex: totalCapex * 0.05,
        derivatives: derivativeTotal * 0.02,
        mentions: combine(n(consumerLens?.evidenceCount), n(transportLens?.evidenceCount)),
        intensity: Math.min(100, 24 + n(consumerLens?.score) * 0.7),
      },
      outboundFlows: [
        { targetId: 'north-america-consumer-housing', theme: 'household demand exposure', weight: 52, metricMode: 'revenue' },
        { targetId: 'dallas-transport-logistics', theme: 'logistics exposure', weight: 42, metricMode: 'revenue' },
      ],
    }),

    mk({
      id: 'north-america-consumer-housing',
      name: 'Nashville / North America consumer and housing proxy',
      shortName: 'Consumer Housing',
      city: 'Nashville',
      country: 'United States',
      lat: 36.1627,
      lon: -86.7816,
      type: 'consumer-housing',
      tone: 'demand',
      intensity: Math.min(100, 25 + n(consumerLens?.evidenceCount) / 5 + n(housingLens?.evidenceCount) / 5),
      metricLabel: 'consumer and housing exposure',
      description: 'Consumer, housing, repair/remodel, homebuilding, inventory, backlog, rent, and occupancy exposure proxy.',
      drivers: ['Consumer demand', 'Housing', 'Backlog', 'Inventory', 'Occupancy'],
      tickers: uniqueTickersLocal(consumerMass.loadedTickers, housingMass.loadedTickers, realEstateMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: combine(n(consumerLens?.evidenceCount), n(housingLens?.evidenceCount), n(realEstateLens?.evidenceCount)),
      sourceBasis: 'Consumer, housing, and real-estate cohort XBRL metrics plus disclosure themes.',
      pattern: 'steady',
      metrics: {
        assets: combine(consumerMass.totalAssets, housingMass.totalAssets, realEstateMass.totalAssets),
        liabilities: combine(consumerMass.totalAssets * 0.58, housingMass.totalAssets * 0.52, realEstateMass.totalAssets * 0.62),
        debt: totalDebt * 0.18,
        cash: totalCash * 0.12,
        revenue: combine(consumerMass.totalRevenue, housingMass.totalRevenue),
        capex: totalCapex * 0.14,
        derivatives: derivativeTotal * 0.03,
        mentions: combine(n(consumerLens?.evidenceCount), n(housingLens?.evidenceCount), n(realEstateLens?.evidenceCount)),
        intensity: Math.min(100, 25 + n(consumerLens?.score) + n(housingLens?.score) * 0.25),
      },
      outboundFlows: [
        { targetId: 'charlotte-credit-cards', theme: 'consumer credit link', weight: 54, metricMode: 'debt' },
        { targetId: 'atlanta-consumer-logistics', theme: 'consumer logistics', weight: 46, metricMode: 'revenue' },
      ],
    }),

    mk({
      id: 'london-fx-rates',
      name: 'London / FX and global rate sensitivity',
      shortName: 'FX Rates',
      city: 'London',
      country: 'United Kingdom',
      lat: 51.5074,
      lon: -0.1278,
      type: 'fx-rates',
      tone: 'watch',
      intensity: Math.min(100, 20 + fx.companyCount * 2 + rates.companyCount),
      metricLabel: 'FX and rate exposure',
      description: 'Foreign-currency, translation, derivatives, rates, and multinational market-risk filing language.',
      drivers: ['FX', 'Rates', 'Translation', 'Multinational exposure'],
      tickers: uniqueTickersLocal(fx.companies, rates.companies, aiMass.loadedTickers, consumerMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: combine(fx.textMentions, rates.textMentions),
      sourceBasis: 'Market-risk text scan across multinational and financial filers. Location is an exposure hub proxy.',
      pattern: 'risk',
      metrics: {
        assets: totalAssets * 0.12,
        liabilities: totalLiabilities * 0.11,
        debt: totalDebt * 0.12,
        cash: totalCash * 0.1,
        revenue: totalRevenue * 0.12,
        capex: totalCapex * 0.1,
        derivatives: derivativeTotal * 0.12,
        mentions: combine(fx.textMentions, rates.textMentions),
        intensity: Math.min(100, 18 + fx.companyCount * 3 + rates.companyCount),
      },
      outboundFlows: [
        { targetId: 'frankfurt-rates-insurance', theme: 'rate sensitivity', weight: 62, metricMode: 'mentions' },
        { targetId: 'new-york-financial-risk', theme: 'cross-market FX/rates', weight: 78, metricMode: 'derivatives' },
      ],
    }),

    mk({
      id: 'frankfurt-rates-insurance',
      name: 'Frankfurt / European rates and financial conditions',
      shortName: 'Europe Rates',
      city: 'Frankfurt',
      country: 'Germany',
      lat: 50.1109,
      lon: 8.6821,
      type: 'rates',
      tone: 'watch',
      intensity: Math.min(100, 22 + rates.companyCount * 1.8 + n(insuranceLens?.score) * 0.25),
      metricLabel: 'European rate sensitivity proxy',
      description: 'Interest-rate, insurance portfolio, long-duration, and bank exposure proxy.',
      drivers: ['Rates', 'Insurance portfolios', 'Bank funding', 'Duration'],
      tickers: uniqueTickersLocal(rates.companies, insuranceMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: combine(rates.textMentions, n(insuranceLens?.evidenceCount)),
      sourceBasis: 'Rate-risk filing language and insurance/financial cohort metrics.',
      pattern: 'risk',
      metrics: {
        assets: combine(insuranceMass.totalAssets * 0.25, creditMass.totalAssets * 0.05),
        liabilities: combine(insuranceMass.totalAssets * 0.18, creditMass.totalAssets * 0.04),
        debt: totalDebt * 0.05,
        cash: totalCash * 0.06,
        revenue: combine(insuranceMass.totalRevenue * 0.2, creditMass.totalRevenue * 0.04),
        capex: totalCapex * 0.02,
        derivatives: derivativeTotal * 0.06,
        mentions: combine(rates.textMentions, n(insuranceLens?.evidenceCount)),
        intensity: Math.min(100, 22 + rates.companyCount * 2),
      },
      outboundFlows: [
        { targetId: 'zurich-insurance-portfolios', theme: 'insurance portfolio sensitivity', weight: 58, metricMode: 'assets' },
        { targetId: 'london-fx-rates', theme: 'European rates corridor', weight: 66, metricMode: 'mentions' },
      ],
    }),

    mk({
      id: 'zurich-insurance-portfolios',
      name: 'Zurich / insurance and long-duration portfolios',
      shortName: 'Insurance Portfolios',
      city: 'Zurich',
      country: 'Switzerland',
      lat: 47.3769,
      lon: 8.5417,
      type: 'insurance',
      tone: 'portfolio',
      intensity: Math.min(100, 22 + n(insuranceLens?.evidenceCount) / 4 + rates.companyCount),
      metricLabel: 'insurance portfolio exposure',
      description: 'Investment-income, reserves, claims, fair-value, rate sensitivity, and long-duration portfolio exposure proxy.',
      drivers: ['Insurance portfolios', 'Rates', 'Claims', 'Investment income', 'Fair value'],
      tickers: uniqueTickersLocal(insuranceMass.loadedTickers, rates.companies),
      confidence: 'Medium',
      evidenceCount: combine(n(insuranceLens?.evidenceCount), rates.textMentions),
      sourceBasis: 'Insurance cohort XBRL and rate/portfolio disclosure language.',
      pattern: 'risk',
      metrics: {
        assets: insuranceMass.totalAssets,
        liabilities: insuranceMass.totalAssets * 0.7,
        debt: totalDebt * 0.06,
        cash: totalCash * 0.15,
        revenue: insuranceMass.totalRevenue,
        capex: totalCapex * 0.02,
        derivatives: derivativeTotal * 0.08,
        mentions: combine(n(insuranceLens?.evidenceCount), rates.textMentions),
        intensity: Math.min(100, 22 + n(insuranceLens?.score)),
      },
      outboundFlows: [
        { targetId: 'frankfurt-rates-insurance', theme: 'rate-sensitive portfolios', weight: 56, metricMode: 'assets' },
        { targetId: 'new-york-financial-risk', theme: 'global investment portfolios', weight: 44, metricMode: 'assets' },
      ],
    }),

    mk({
      id: 'rotterdam-europe-trade',
      name: 'Rotterdam / European trade and energy import exposure',
      shortName: 'Europe Trade',
      city: 'Rotterdam',
      country: 'Netherlands',
      lat: 51.9244,
      lon: 4.4777,
      type: 'trade-energy',
      tone: 'commodity',
      intensity: Math.min(100, 24 + commodities.companyCount + n(transportLens?.score) * 0.25),
      metricLabel: 'trade and energy import exposure',
      description: 'European trade, logistics, fuel, commodity, industrial, and import exposure proxy.',
      drivers: ['Trade', 'Energy imports', 'Logistics', 'Commodities'],
      tickers: uniqueTickersLocal(transportMass.loadedTickers, energyMass.loadedTickers, commodities.companies),
      confidence: 'Low-Medium',
      evidenceCount: combine(commodities.textMentions, n(transportLens?.evidenceCount), n(industrialLens?.evidenceCount)),
      sourceBasis: 'Commodity and transport filing signals mapped to a trade hub proxy.',
      pattern: 'risk',
      metrics: {
        assets: combine(energyMass.totalAssets * 0.14, transportMass.totalAssets * 0.08, industrialMass.totalAssets * 0.05),
        liabilities: combine(energyMass.totalAssets * 0.07, transportMass.totalAssets * 0.05),
        debt: totalDebt * 0.04,
        cash: totalCash * 0.03,
        revenue: combine(energyMass.totalRevenue * 0.12, transportMass.totalRevenue * 0.08),
        capex: totalCapex * 0.05,
        derivatives: derivativeTotal * 0.04,
        mentions: combine(commodities.textMentions, n(transportLens?.evidenceCount)),
        intensity: Math.min(100, 24 + commodities.companyCount),
      },
      outboundFlows: [
        { targetId: 'london-fx-rates', theme: 'FX and trade exposure', weight: 48, metricMode: 'mentions' },
        { targetId: 'dubai-gulf-energy', theme: 'energy corridor', weight: 40, metricMode: 'capex' },
      ],
    }),

    mk({
      id: 'singapore-trade-commodities',
      name: 'Singapore / Asia trade, FX, and commodities',
      shortName: 'Asia Trade',
      city: 'Singapore',
      country: 'Singapore',
      lat: 1.3521,
      lon: 103.8198,
      type: 'trade-commodity',
      tone: 'watch',
      intensity: Math.min(100, 24 + commodities.companyCount + fx.companyCount),
      metricLabel: 'Asia trade and commodity exposure',
      description: 'Asia-Pacific trade, FX, commodities, supply-chain, fuel, and shipping exposure proxy.',
      drivers: ['Asia trade', 'FX', 'Commodities', 'Shipping'],
      tickers: uniqueTickersLocal(fx.companies, commodities.companies, transportMass.loadedTickers),
      confidence: 'Low-Medium',
      evidenceCount: combine(fx.textMentions, commodities.textMentions, n(transportLens?.evidenceCount)),
      sourceBasis: 'FX, commodity, and transport filing signals mapped to a trade hub proxy.',
      pattern: 'risk',
      metrics: {
        assets: combine(transportMass.totalAssets * 0.1, energyMass.totalAssets * 0.08),
        liabilities: combine(transportMass.totalAssets * 0.06, energyMass.totalAssets * 0.04),
        debt: totalDebt * 0.04,
        cash: totalCash * 0.04,
        revenue: combine(transportMass.totalRevenue * 0.12, energyMass.totalRevenue * 0.08),
        capex: totalCapex * 0.04,
        derivatives: derivativeTotal * 0.06,
        mentions: combine(fx.textMentions, commodities.textMentions),
        intensity: Math.min(100, 24 + fx.companyCount + commodities.companyCount),
      },
      outboundFlows: [
        { targetId: 'shanghai-supply-chain', theme: 'supply-chain corridor', weight: 64, metricMode: 'revenue' },
        { targetId: 'dubai-gulf-energy', theme: 'energy and commodity flows', weight: 56, metricMode: 'derivatives' },
      ],
    }),

    mk({
      id: 'taipei-semiconductor-supply',
      name: 'Hsinchu-Taipei / semiconductor supply exposure',
      shortName: 'Semiconductor Supply',
      city: 'Hsinchu / Taipei',
      country: 'Taiwan',
      lat: 24.8138,
      lon: 120.9675,
      type: 'semiconductor',
      tone: 'growth',
      intensity: Math.min(100, 34 + n(aiLens?.score) * 0.85),
      metricLabel: 'semiconductor and AI supply exposure',
      description: 'GPU, semiconductor, memory, networking, supply constraint, and AI infrastructure demand proxy.',
      drivers: ['Semiconductors', 'AI accelerators', 'Memory', 'Networking', 'Supply constraints'],
      tickers: uniqueTickersLocal(aiMass.loadedTickers),
      confidence: 'Medium',
      evidenceCount: n(aiLens?.evidenceCount),
      sourceBasis: 'AI infrastructure cohort XBRL data and semiconductor filing signals.',
      pattern: 'growth',
      metrics: {
        assets: aiMass.totalAssets * 0.42,
        liabilities: aiMass.totalAssets * 0.18,
        debt: totalDebt * 0.06,
        cash: totalCash * 0.12,
        revenue: aiMass.totalRevenue * 0.38,
        capex: totalCapex * 0.28,
        derivatives: derivativeTotal * 0.02,
        mentions: n(aiLens?.evidenceCount),
        intensity: Math.min(100, 34 + n(aiLens?.score)),
      },
      outboundFlows: [
        { targetId: 'northern-virginia-data-centers', theme: 'AI data center demand', weight: 88, metricMode: 'capex' },
        { targetId: 'san-francisco-software-ai', theme: 'AI platform demand', weight: 72, metricMode: 'revenue' },
      ],
    }),

    mk({
      id: 'tokyo-industrial-fx',
      name: 'Tokyo / industrial and FX exposure',
      shortName: 'Industrial FX',
      city: 'Tokyo',
      country: 'Japan',
      lat: 35.6762,
      lon: 139.6503,
      type: 'industrial-fx',
      tone: 'watch',
      intensity: Math.min(100, 22 + n(industrialLens?.score) * 0.45 + fx.companyCount),
      metricLabel: 'industrial and FX exposure',
      description: 'Industrial-cycle, automation, equipment, manufacturing, FX, and multinational exposure proxy.',
      drivers: ['Industrials', 'FX', 'Automation', 'Manufacturing'],
      tickers: uniqueTickersLocal(industrialMass.loadedTickers, fx.companies),
      confidence: 'Low-Medium',
      evidenceCount: combine(n(industrialLens?.evidenceCount), fx.textMentions),
      sourceBasis: 'Industrial cohort metrics and foreign-currency filing language.',
      pattern: 'steady',
      metrics: {
        assets: industrialMass.totalAssets * 0.22,
        liabilities: industrialMass.totalAssets * 0.12,
        debt: totalDebt * 0.04,
        cash: totalCash * 0.04,
        revenue: industrialMass.totalRevenue * 0.22,
        capex: totalCapex * 0.06,
        derivatives: derivativeTotal * 0.03,
        mentions: combine(n(industrialLens?.evidenceCount), fx.textMentions),
        intensity: Math.min(100, 22 + n(industrialLens?.score)),
      },
      outboundFlows: [
        { targetId: 'singapore-trade-commodities', theme: 'Asia industrial trade', weight: 42, metricMode: 'revenue' },
        { targetId: 'london-fx-rates', theme: 'FX sensitivity', weight: 44, metricMode: 'mentions' },
      ],
    }),

    mk({
      id: 'shanghai-supply-chain',
      name: 'Shanghai / supply-chain and manufacturing exposure',
      shortName: 'Supply Chain',
      city: 'Shanghai',
      country: 'China',
      lat: 31.2304,
      lon: 121.4737,
      type: 'supply-chain',
      tone: 'watch',
      intensity: Math.min(100, 24 + n(consumerLens?.score) * 0.22 + n(industrialLens?.score) * 0.45),
      metricLabel: 'supply-chain exposure proxy',
      description: 'Manufacturing, inventory, supplier, tariff, logistics, consumer-goods, and industrial supply-chain exposure proxy.',
      drivers: ['Manufacturing', 'Inventory', 'Tariffs', 'Suppliers', 'Logistics'],
      tickers: uniqueTickersLocal(consumerMass.loadedTickers, industrialMass.loadedTickers, aiMass.loadedTickers),
      confidence: 'Low-Medium',
      evidenceCount: combine(n(consumerLens?.evidenceCount), n(industrialLens?.evidenceCount), n(aiLens?.evidenceCount)),
      sourceBasis: 'Supply-chain and manufacturing filing signals mapped to an Asia manufacturing hub proxy.',
      pattern: 'risk',
      metrics: {
        assets: combine(consumerMass.totalAssets * 0.18, industrialMass.totalAssets * 0.22, aiMass.totalAssets * 0.16),
        liabilities: combine(consumerMass.totalAssets * 0.1, industrialMass.totalAssets * 0.12, aiMass.totalAssets * 0.07),
        debt: totalDebt * 0.06,
        cash: totalCash * 0.06,
        revenue: combine(consumerMass.totalRevenue * 0.2, industrialMass.totalRevenue * 0.22, aiMass.totalRevenue * 0.12),
        capex: totalCapex * 0.12,
        derivatives: derivativeTotal * 0.04,
        mentions: combine(n(consumerLens?.evidenceCount), n(industrialLens?.evidenceCount), n(aiLens?.evidenceCount)),
        intensity: Math.min(100, 24 + n(industrialLens?.score)),
      },
      outboundFlows: [
        { targetId: 'los-angeles-pacific-trade', theme: 'import and logistics exposure', weight: 72, metricMode: 'mentions' },
        { targetId: 'singapore-trade-commodities', theme: 'Asia trade corridor', weight: 52, metricMode: 'revenue' },
      ],
    }),

    mk({
      id: 'dubai-gulf-energy',
      name: 'Dubai / Gulf energy and commodity corridor',
      shortName: 'Gulf Energy',
      city: 'Dubai',
      country: 'United Arab Emirates',
      lat: 25.2048,
      lon: 55.2708,
      type: 'energy',
      tone: 'commodity',
      intensity: Math.min(100, 30 + commodities.companyCount * 1.7),
      metricLabel: 'global commodity corridor',
      description: 'Global oil, gas, commodity, fuel, and energy-market exposure proxy.',
      drivers: ['Oil', 'Gas', 'Commodity prices', 'Fuel', 'Energy trade'],
      tickers: uniqueTickersLocal(energyMass.loadedTickers, commodities.companies),
      confidence: 'Low-Medium',
      evidenceCount: combine(commodities.textMentions, n(energyLens?.evidenceCount)),
      sourceBasis: 'Commodity filing language and energy cohort metrics mapped to a global energy corridor proxy.',
      pattern: 'risk',
      metrics: {
        assets: energyMass.totalAssets * 0.32,
        liabilities: energyMass.totalAssets * 0.16,
        debt: totalDebt * 0.05,
        cash: totalCash * 0.04,
        revenue: energyMass.totalRevenue * 0.32,
        capex: totalCapex * 0.13,
        derivatives: derivativeTotal * 0.07,
        mentions: combine(commodities.textMentions, n(energyLens?.evidenceCount)),
        intensity: Math.min(100, 30 + commodities.companyCount * 1.7),
      },
      outboundFlows: [
        { targetId: 'houston-energy-corridor', theme: 'global energy exposure', weight: 70, metricMode: 'capex' },
        { targetId: 'singapore-trade-commodities', theme: 'commodity trade', weight: 56, metricMode: 'derivatives' },
      ],
    }),

    mk({
      id: 'sao-paulo-commodities-fx',
      name: 'São Paulo / agriculture, commodities, and FX proxy',
      shortName: 'LATAM Commodities',
      city: 'São Paulo',
      country: 'Brazil',
      lat: -23.5505,
      lon: -46.6333,
      type: 'commodity-fx',
      tone: 'commodity',
      intensity: Math.min(100, 20 + commodities.companyCount + fx.companyCount),
      metricLabel: 'LATAM commodity and FX proxy',
      description: 'Agriculture, materials, commodity, FX, and emerging-market exposure proxy from multinational filing language.',
      drivers: ['Commodities', 'FX', 'Agriculture', 'Materials'],
      tickers: uniqueTickersLocal(commodities.companies, fx.companies, energyMass.loadedTickers),
      confidence: 'Low',
      evidenceCount: combine(commodities.textMentions, fx.textMentions),
      sourceBasis: 'Multinational FX and commodity filing language mapped to a LATAM exposure proxy.',
      pattern: 'risk',
      metrics: {
        assets: aggregate.totalAssets * 0.035,
        liabilities: aggregate.totalLiabilities * 0.028,
        debt: totalDebt * 0.025,
        cash: totalCash * 0.02,
        revenue: totalRevenue * 0.035,
        capex: totalCapex * 0.035,
        derivatives: derivativeTotal * 0.025,
        mentions: combine(commodities.textMentions, fx.textMentions) * 0.18,
        intensity: Math.min(100, 20 + commodities.companyCount + fx.companyCount),
      },
      outboundFlows: [
        { targetId: 'houston-energy-corridor', theme: 'commodity exposure', weight: 38, metricMode: 'mentions' },
        { targetId: 'london-fx-rates', theme: 'FX exposure', weight: 34, metricMode: 'mentions' },
      ],
    }),

    mk({
      id: 'sydney-commodities-insurance',
      name: 'Sydney / commodities and insurance portfolio proxy',
      shortName: 'APAC Portfolios',
      city: 'Sydney',
      country: 'Australia',
      lat: -33.8688,
      lon: 151.2093,
      type: 'portfolio-commodity',
      tone: 'portfolio',
      intensity: Math.min(100, 20 + commodities.companyCount + n(insuranceLens?.score) * 0.2),
      metricLabel: 'APAC portfolio and commodity proxy',
      description: 'Mining, commodities, insurance, long-duration portfolio, and APAC market exposure proxy.',
      drivers: ['Commodities', 'Insurance', 'Portfolios', 'Rates'],
      tickers: uniqueTickersLocal(commodities.companies, insuranceMass.loadedTickers, rates.companies),
      confidence: 'Low',
      evidenceCount: combine(commodities.textMentions, n(insuranceLens?.evidenceCount), rates.textMentions),
      sourceBasis: 'Commodity and insurance filing signals mapped to an APAC portfolio exposure proxy.',
      pattern: 'steady',
      metrics: {
        assets: combine(energyMass.totalAssets * 0.08, insuranceMass.totalAssets * 0.08),
        liabilities: combine(energyMass.totalAssets * 0.04, insuranceMass.totalAssets * 0.06),
        debt: totalDebt * 0.025,
        cash: totalCash * 0.025,
        revenue: combine(energyMass.totalRevenue * 0.08, insuranceMass.totalRevenue * 0.06),
        capex: totalCapex * 0.04,
        derivatives: derivativeTotal * 0.025,
        mentions: combine(commodities.textMentions, n(insuranceLens?.evidenceCount), rates.textMentions) * 0.14,
        intensity: Math.min(100, 20 + commodities.companyCount),
      },
      outboundFlows: [
        { targetId: 'singapore-trade-commodities', theme: 'APAC commodity trade', weight: 44, metricMode: 'mentions' },
        { targetId: 'zurich-insurance-portfolios', theme: 'insurance portfolio risk', weight: 32, metricMode: 'assets' },
      ],
    }),
  ];
}

async function loadCompanyUniverse(entries, userAgent) {
  const textScanTickers = new Set(
    uniqueTickers([
      ...MARKET_LENSES.find((lens) => lens.id === 'credit-banks').tickers,
      ...MARKET_LENSES.find((lens) => lens.id === 'insurance').tickers,
      ...MARKET_LENSES.find((lens) => lens.id === 'energy-commodities').tickers,
      ...MARKET_LENSES.find((lens) => lens.id === 'transport-cyclicals').tickers,
      ...MARKET_LENSES.find((lens) => lens.id === 'utilities-rates').tickers,
      ...MARKET_LENSES.find((lens) => lens.id === 'ai-infrastructure').tickers,
      ...MARKET_LENSES.find((lens) => lens.id === 'real-estate').tickers,
      ...MARKET_LENSES.find((lens) => lens.id === 'consumer-demand').tickers,
    ]).slice(0, MAX_TEXT_FILERS)
  );

  return mapLimit(entries, MAX_CONCURRENCY, (entry) => (
    loadCompany(entry, userAgent, textScanTickers.has(entry.ticker))
  ));
}

export async function GET(request) {
  const userAgent = process.env.SEC_USER_AGENT;

  if (!userAgent) {
    return NextResponse.json(
      { error: 'SEC_USER_AGENT is not configured.' },
      { status: 500 }
    );
  }

  const refresh = request?.url
    ? new URL(request.url).searchParams.get('refresh') === '1'
    : false;

  if (!refresh && marketOverviewCache && Date.now() < marketOverviewCache.expiresAt) {
    return NextResponse.json(marketOverviewCache.payload, {
      headers: {
        'Cache-Control': 's-maxage=21600, stale-while-revalidate=86400',
        'X-Market-Overview-Cache': 'memory-hit',
      },
    });
  }

  try {
    const cached = !refresh ? await warmGet('market-v2', 'atlas') : null;
    if (cached && Date.now() - Date.parse(cached.generatedAt) < MARKET_OVERVIEW_TTL_MS) {
      return NextResponse.json(cached, { headers: { 'Cache-Control': 's-maxage=21600, stale-while-revalidate=86400' } });
    }
    const tickerMap = await loadTickerMap(userAgent);
    const universeTickers = uniqueTickers(MARKET_LENSES.flatMap((lens) => lens.tickers));
    const entries = universeTickers
      .map((ticker) => tickerMap.get(ticker))
      .filter(Boolean);

    const companies = await loadCompanyUniverse(entries, userAgent);
    const companyByTicker = new Map(companies.map((company) => [company.ticker, company]));

    const lenses = MARKET_LENSES.map((definition) => {
      const lensCompanies = definition.tickers
        .map((ticker) => companyByTicker.get(ticker))
        .filter(Boolean);

      return aggregateLens(definition, lensCompanies);
    });

    const tradeBookAtlas = aggregateTradeBookAtlas(companies);
    const weatherMap = buildWeatherMap(lenses, companies.filter((company) => !company.error), tradeBookAtlas);
    const exposureIndexes = buildExposureIndexes(lenses, companies.filter((company) => !company.error), tradeBookAtlas);
    const derivativesDashboard = aggregateDerivativesDashboard(companies, tradeBookAtlas);
    const aggregateUniverse = buildAggregateUniverse(companies, lenses, tradeBookAtlas, derivativesDashboard);
    const geographicExposure = illustrativeGeography(buildGeographicExposure(lenses, tradeBookAtlas, derivativesDashboard, aggregateUniverse));

    const loadedCompanies = companies.filter((company) => !company.error);
    const erroredCompanies = companies.filter((company) => company.error);

    const payload = {
      generatedAt: new Date().toISOString(),
      source: {
        name: 'SEC Company Facts API + recent 10-K/10-Q market-risk text scan',
        forms: 'Latest annual and quarterly XBRL facts; bounded latest-filing text scan for market-risk language.',
        methodology: 'Curated public-company cohorts grouped into asset-class filing lenses, trade-book exposure categories, and derivative-risk signals.',
      },
      universe: {
        requestedTickers: universeTickers.length,
        resolvedTickers: entries.length,
        loadedCompanies: loadedCompanies.length,
        erroredCompanies: erroredCompanies.length,
        textFilersScanned: tradeBookAtlas.scannedFilers,
        lenses: MARKET_LENSES.length,
        latestFiled: latestDate(loadedCompanies.flatMap((company) => company.filedDates)),
      },
      lenses,
      weatherMap,
      exposureIndexes,
      tradeBookAtlas,
      aggregateUniverse,
      geographicExposure,
      derivativesDashboard,
    };

    const previousSnapshots = await warmGet('market-v2', 'observations');
    payload.observedHistory = appendSnapshot(previousSnapshots, marketSnapshot(payload));
    payload.historyPersistence = await warmSet('market-v2', 'observations', payload.observedHistory, 90 * 86400);
    await warmSet('market-v2', 'atlas', payload, 21600);
    marketOverviewCache = {
      payload,
      expiresAt: Date.now() + MARKET_OVERVIEW_TTL_MS,
    };

    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 's-maxage=21600, stale-while-revalidate=86400',
        'X-Market-Overview-Cache': 'rebuilt',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
