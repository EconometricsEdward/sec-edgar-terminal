import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketMacroSummary, marketSicIndustry } from '../src/utils/marketMacroSummary.js';

const company = (ticker, sector, sic, metrics, extra = {}) => ({
  ticker, cik: ticker.charCodeAt(0).toString(), sector, sic,
  cohorts: sector ? [`sector-${sector.toLowerCase()}`, 'overlapping-theme'] : ['overlapping-theme'],
  metrics: { ttm: metrics, annual: { revenueGrowth: 2, netIncome: 1 } },
  reports: { ttm: { end: '2026-06-30' }, annual: { end: '2025-12-31' } }, ...extra,
});
function fixture() {
  return {
    generatedAt: '2026-09-17T12:00:00Z', requested: 5,
    companies: [
      company('A', 'Technology', '7372', { revenueGrowth: 10, netMargin: 20, cashFlowMargin: 15, netIncome: 40 }),
      company('B', 'Technology', '7372', { revenueGrowth: -4, netMargin: null, cashFlowMargin: 0, netIncome: -2 }),
      company('C', 'Industrials', '3510', { revenueGrowth: 2, netMargin: 8, cashFlowMargin: -5, netIncome: 10 }),
      company('D', 'Industrials', null, { revenueGrowth: null, netMargin: 10, cashFlowMargin: null, netIncome: 0 }),
    ],
    cohorts: [
      { id: 'sector-technology', label: 'Technology', tickers: ['A', 'B', 'MISSING'], targetKnown: true },
      { id: 'sector-industrials', label: 'Industrials', tickers: ['C', 'D'], targetKnown: true },
      { id: 'sector-financials', label: 'Financials', tickers: [] },
      { id: 'overlapping-theme', label: 'Theme', tickers: ['A', 'B', 'C', 'D'] },
    ],
  };
}

test('macro summary counts represented primary sectors and SIC industries without adding overlapping themes', () => {
  const summary = buildMarketMacroSummary(fixture());
  assert.equal(summary.companyCount, 4);
  assert.equal(summary.sectorCount, 2);
  assert.equal(summary.industryCount, 2);
  assert.equal(summary.missingIndustryCount, 1);
  assert.equal(summary.sectors.reduce((sum, sector) => sum + sector.count, 0), 4);
  assert.equal(summary.sectors.find(sector => sector.id === 'sector-technology').targetCount, 3);
  assert.equal(summary.industries.find(industry => industry.code === '7372').count, 2);
});

test('sector and industry financial measures use their own available-value denominators', () => {
  const summary = buildMarketMacroSummary(fixture());
  const technology = summary.sectors.find(sector => sector.id === 'sector-technology');
  assert.equal(technology.metrics.revenueGrowth.median, 3);
  assert.equal(technology.metrics.revenueGrowth.count, 2);
  assert.equal(technology.metrics.netMargin.count, 1);
  assert.equal(technology.metrics.netMargin.median, 20);
  assert.equal(technology.industries[0].metrics.netMargin.total, 2);
  assert.equal(summary.growth.count, 3);
  assert.equal(summary.growth.positive, 2);
  assert.equal(summary.growth.negative, 1);
  assert.equal(summary.cash.count, 3);
  assert.equal(summary.cash.positive, 1);
  assert.equal(summary.profit.count, 4);
  assert.equal(summary.profit.positive, 2);
  assert.equal(summary.profit.negative, 1);
});

test('missing primary classifications are excluded and overlapping cohorts are not fallback sectors', () => {
  const data = fixture();
  data.companies.push(company('E', null, '7372', { revenueGrowth: 50 }));
  const summary = buildMarketMacroSummary(data);
  assert.equal(summary.companyCount, 5);
  assert.equal(summary.sectorCount, 2);
  assert.equal(summary.missingSectorCount, 1);
  assert.equal(summary.growth.count, 4);
  assert.equal(summary.sectors.reduce((sum, sector) => sum + sector.count, 0), 4);
  const fallback = buildMarketMacroSummary({ ...data, companies: [company('F', null, '7372', {}, { cohorts: ['sector-technology'] })] });
  assert.equal(fallback.sectors[0].label, 'Technology');
});

test('duplicate share classes with the same CIK do not inflate coverage', () => {
  const data = fixture();
  data.companies.push({ ...data.companies[0], ticker: 'A2', cik: `000${data.companies[0].cik}` });
  const summary = buildMarketMacroSummary(data);
  assert.equal(summary.companyCount, 4);
  assert.equal(summary.growth.count, 3);
  assert.equal(summary.industries.find(industry => industry.code === '7372').count, 2);
});

test('annual and TTM metrics and period ranges remain distinct', () => {
  const data = fixture();
  data.companies[0].reports.ttm.end = '2025-06-30';
  const ttm = buildMarketMacroSummary(data);
  const annual = buildMarketMacroSummary(data, 'annual');
  assert.equal(ttm.olderReports, 1);
  assert.equal(annual.olderReports, 0);
  assert.equal(annual.growth.count, 4);
  assert.equal(annual.growth.median, 2);
  assert.equal(annual.reportRange.earliest, '2025-12-31');
  assert.equal(ttm.reportRange.earliest, '2025-06-30');
  assert.equal(ttm.reportRange.latest, '2026-06-30');
});

test('SIC codes normalize leading zeros and preserve unknown labels separately from missing codes', () => {
  assert.equal(marketSicIndustry(100).code, '0100');
  assert.equal(marketSicIndustry(' 7372 ').label, 'SERVICES-PREPACKAGED SOFTWARE');
  assert.equal(marketSicIndustry('0000'), null);
  assert.equal(marketSicIndustry('unknown'), null);
  assert.equal(marketSicIndustry(null), null);
  assert.equal(marketSicIndustry('12345'), null);
  const data = fixture();
  data.companies[0].sic = '9999';
  const summary = buildMarketMacroSummary(data);
  assert.equal(summary.industryCount, 3);
  assert.equal(summary.unknownIndustryCount, 1);
  assert.equal(summary.unknownIndustryCompanyCount, 1);
  assert.equal(summary.missingIndustryCount, 1);
  assert.equal(summary.industries.find(industry => industry.code === '9999').label, 'Industry label unavailable');
});

test('no loaded companies creates no fabricated statistics or classifications', () => {
  const summary = buildMarketMacroSummary({ ...fixture(), companies: [] });
  assert.equal(summary.companyCount, 0);
  assert.equal(summary.industryCount, 0);
  assert.equal(summary.sectorCount, 0);
  assert.equal(summary.growth.median, null);
  assert.equal(summary.profit.positivePct, null);
  assert.equal(summary.cash.count, 0);
  assert.equal(summary.reportRange, null);
});

test('unknown sector membership does not invent a coverage target', () => {
  const data = fixture();
  data.cohorts[0].targetKnown = false;
  const summary = buildMarketMacroSummary(data);
  assert.equal(summary.sectors.find(sector => sector.id === 'sector-technology').targetCount, null);
});
