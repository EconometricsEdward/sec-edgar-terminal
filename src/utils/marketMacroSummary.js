import sicReference from '../data/sec-sic-codes.json' with { type: 'json' };
import { isOlderReport, metricStats } from './marketResearch.js';
import { withholdInvalidMarketPeriods } from './marketPeriodIntegrity.js';

export const MARKET_SECTOR_METRICS = [
  { key: 'revenueGrowth', label: 'Revenue growth', shortLabel: 'Growth', context: 'Year-over-year reported revenue growth. Revenue reflects both volumes and prices; this is not real GDP growth.' },
  { key: 'netMargin', label: 'Net margin', shortLabel: 'Profitability', context: 'Net income as a share of revenue. Industry business models, financing and unusual items affect comparability.' },
  { key: 'cashFlowMargin', label: 'Operating cash flow / revenue', shortLabel: 'Cash generation', context: 'Operating cash flow relative to revenue. Working capital and financial-sector cash movements affect this ratio.' },
  { key: 'capexIntensity', label: 'Capex / revenue', shortLabel: 'Investment', context: 'Reported purchases of property, plant and equipment relative to revenue. This excludes acquisitions and is not a forecast of investment.' },
  { key: 'equityToAssets', label: 'Book equity / assets', shortLabel: 'Capital structure', context: 'Reported stockholders’ equity relative to assets. Financial companies have structurally different balance sheets.' },
];

const validSector = value => typeof value === 'string' && value.trim() && !/^(unknown|unclassified|unavailable|n\/a|sector not covered)$/i.test(value.trim());
const sectorId = label => `sector-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const issuerKey = company => /^\d+$/.test(String(company.cik || '')) && Number(company.cik) > 0
  ? `cik:${String(company.cik).replace(/^0+/, '')}` : `ticker:${company.ticker}`;

/** Count reported SIC codes even when the bundled SEC reference has no label. */
export function marketSicIndustry(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{3,4}$/.test(raw) || Number(raw) === 0) return null;
  const code = raw.padStart(4, '0');
  return { code, label: sicReference.codes[code] || 'Industry label unavailable', known: Boolean(sicReference.codes[code]) };
}

function groupIndustries(companies, basis) {
  const groups = new Map();
  let missing = 0;
  for (const company of companies) {
    const industry = marketSicIndustry(company.sic);
    if (!industry) { missing++; continue; }
    if (!groups.has(industry.code)) groups.set(industry.code, { ...industry, companies: [] });
    groups.get(industry.code).companies.push(company);
  }
  return {
    missing,
    rows: [...groups.values()].map(group => ({
      code: group.code, label: group.label, known: group.known, count: group.companies.length,
      ...(basis ? { metrics: summaryMetrics(group.companies, basis) } : {}),
    })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}

function summaryMetrics(companies, basis) {
  return Object.fromEntries([...MARKET_SECTOR_METRICS.map(metric => metric.key), 'netIncome']
    .map(key => [key, metricStats(companies, basis, key)]));
}

/** Primary sectors are disjoint. Legacy overlapping research themes are never counted as sectors. */
export function buildMarketMacroSummary(data, basis = 'ttm') {
  const companies = [...new Map((data?.companies || []).map(company => [issuerKey(company), withholdInvalidMarketPeriods(company)])).values()];
  const cohorts = data?.cohorts || [];
  const primary = cohorts.filter(cohort => cohort.id.startsWith('sector-'));
  const groups = new Map();
  let missingSectorCount = 0;
  for (const company of companies) {
    const matches = primary.filter(cohort => (company.cohorts || []).includes(cohort.id));
    const label = validSector(company.sector) ? company.sector.trim()
      : matches.length === 1 && validSector(matches[0].label) ? matches[0].label : null;
    if (!label) { missingSectorCount++; continue; }
    const cohort = primary.find(row => row.label === label)
      || (data?.coverage ? cohorts.find(row => row.label === label) : null);
    if (!groups.has(label)) groups.set(label, { id: cohort?.id || sectorId(label), label, cohort, companies: [] });
    groups.get(label).companies.push(company);
  }
  const sectors = [...groups.values()].map(group => {
    const industries = groupIndustries(group.companies, basis);
    return { id: group.id, label: group.label, count: group.companies.length,
      targetCount: group.cohort && group.cohort.targetKnown !== false ? group.cohort.tickers.length : null,
      industries: industries.rows, missingIndustryCount: industries.missing,
      metrics: summaryMetrics(group.companies, basis) };
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const industries = groupIndustries(companies);
  const metrics = summaryMetrics(companies, basis);
  const reportEnds = companies.map(company => company.reports?.[basis]?.end)
    .filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
  return {
    companyCount: companies.length, sectorCount: sectors.length, industryCount: industries.rows.length,
    sectors, industries: industries.rows, missingSectorCount, missingIndustryCount: industries.missing,
    unknownIndustryCount: industries.rows.filter(row => !row.known).length,
    unknownIndustryCompanyCount: industries.rows.filter(row => !row.known).reduce((sum, row) => sum + row.count, 0),
    metrics, growth: metrics.revenueGrowth, profit: metrics.netIncome, cash: metrics.cashFlowMargin,
    olderReports: companies.filter(company => isOlderReport(company, basis, data.generatedAt)).length,
    reportRange: reportEnds.length ? { earliest: reportEnds[0], latest: reportEnds[reportEnds.length - 1], count: reportEnds.length } : null,
    generatedAt: data?.generatedAt || null,
    classificationSource: sicReference.source,
  };
}
