import { MARKET_SECTOR_METRICS } from './marketMacroSummary.js';
import { buildMarketMacroPositioning } from './marketMacroPositioning.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const fraction = value => finite(value) ? value / 100 : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const col = (key, label, format = 'text', width) => ({ key, label, format, ...(width ? { width } : {}) });
const metricColumns = () => MARKET_SECTOR_METRICS.flatMap(metric => [
  col(metric.key, metric.label, 'percent'), col(`${metric.key}N`, `${metric.shortLabel} n`, 'number'),
]);
const metricValues = metrics => Object.fromEntries(MARKET_SECTOR_METRICS.flatMap(metric => [
  [metric.key, fraction(metrics[metric.key]?.median)], [`${metric.key}N`, metrics[metric.key]?.count ?? 0],
]));

// Inclusive linear interpolation, equivalent to PERCENTILE.INC in a workbook.
function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability, lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** Shared Market-page statistics plus export tables. `macro` comes from
 * buildMarketMacroSummary, and positioning contains only validated CFTC rows.
 * Rich sector stats and CFTC cards retain the Market page's percentage-point
 * scale; breadth.share and every flat percentage column use fractions. */
export function buildReportMarketBriefing({ data, macro, companies, positioning, requestedCount, missingCompanies }) {
  const breadth = [
    { id: 'revenue-growth', label: 'Growing revenue', stats: macro.growth, context: 'Positive year-over-year revenue growth' },
    { id: 'profitable', label: 'Profitable businesses', stats: macro.profit, context: 'Positive reported net income' },
    { id: 'positive-cash-flow', label: 'Positive operating cash flow', stats: macro.cash, context: 'Positive operating cash flow / revenue' },
  ].map(({ stats, ...definition }) => ({ ...definition, positive: stats.positive, count: stats.count, share: fraction(stats.positivePct) }));
  const growthRanked = macro.sectors.filter(sector => finite(sector.metrics.revenueGrowth?.median))
    .slice().sort((a, b) => b.metrics.revenueGrowth.median - a.metrics.revenueGrowth.median);
  const leader = sector => sector ? { sector: sector.label, sectorId: sector.id, value: sector.metrics.revenueGrowth.median,
    count: sector.metrics.revenueGrowth.count, companies: sector.count } : null;
  const highest = leader(growthRanked[0]), lowest = growthRanked.length > 1 ? leader(growthRanked.at(-1)) : null;
  const unsupportedCount = Math.min(missingCompanies ?? data.failures?.length ?? 0, count(data.coverage?.unsupported_issuers) ?? 0);
  const coverage = {
    companyCount: macro.companyCount, sectorCount: macro.sectorCount, industryCount: macro.industryCount,
    requestedCount, missingCompanies, unsupportedCount,
    awaitingCount: missingCompanies === null ? null : Math.max(0, missingCompanies - unsupportedCount),
    missingSectorCount: macro.missingSectorCount, missingIndustryCount: macro.missingIndustryCount,
    unknownIndustryCount: macro.unknownIndustryCount, unknownIndustryCompanyCount: macro.unknownIndustryCompanyCount,
    olderReports: macro.olderReports, snapshotAt: data.generatedAt, reportRange: macro.reportRange,
    sourceSecurities: count(data.coverage?.source_securities), duplicateShareClasses: count(data.coverage?.duplicate_share_classes),
    grouping: typeof data.coverage?.grouping === 'string' ? data.coverage.grouping : '',
    membershipWarning: typeof data.coverage?.membership_warning === 'string' ? data.coverage.membership_warning : '',
  };
  const macroPositioning = buildMarketMacroPositioning(Object.fromEntries(positioning.map(snapshot => [snapshot.family, snapshot.macroSnapshot])));
  const marketBriefing = { coverage, breadth, growthLeaders: { highest, lowest,
    spreadPp: highest && lowest ? highest.value - lowest.value : null },
    positioning: macroPositioning, sectorMetrics: MARKET_SECTOR_METRICS, sectors: macro.sectors, industries: macro.industries };
  const sectorRows = macro.sectors.map(sector => ({ sectorId: sector.id, sector: sector.label, companies: sector.count,
    target: sector.targetCount, industries: sector.industries.length, ...metricValues(sector.metrics) }));
  const companyGroups = new Map();
  for (const company of companies) {
    if (!companyGroups.has(company.sectorId)) companyGroups.set(company.sectorId, []);
    companyGroups.get(company.sectorId).push(company);
  }
  const statistics = macro.sectors.flatMap(sector => MARKET_SECTOR_METRICS.map(metric => {
    const stats = sector.metrics[metric.key];
    const values = (companyGroups.get(sector.id) || []).map(company => company[metric.key]).filter(finite).sort((a, b) => a - b);
    return { sectorId: sector.id, sector: sector.label, metricKey: metric.key, metric: metric.label,
      median: fraction(stats.median), mean: fraction(stats.mean), p25: quantile(values, 0.25), p75: quantile(values, 0.75),
      min: values[0] ?? null, max: values.at(-1) ?? null, positive: stats.positive, negative: stats.negative,
      count: stats.count, companies: sector.count, coverage: sector.count ? stats.count / sector.count : null };
  }));
  const industries = macro.sectors.flatMap(sector => sector.industries.map(industry => ({ sectorId: sector.id,
    sector: sector.label, code: industry.code, industry: industry.label, known: industry.known,
    companies: industry.count, ...metricValues(industry.metrics) })));
  const macroRows = macroPositioning.cards.map(card => ({ id: card.id, category: card.category, market: card.label,
    family: card.familyLabel, familyId: card.family, group: card.groupLabel, groupId: card.group,
    code: card.code, reportDate: card.reportDate, net: card.net, netOi: fraction(card.netPctOi),
    oneWeekChange: card.weeklyNetChange, oneWeekChangePp: card.weeklyChange,
    long: card.long, short: card.short, openInterest: card.openInterest,
    exchange: card.exchange, units: card.units, context: card.context,
    coverage: !card.available ? 'Observation unavailable' : card.aged || card.stale ? 'Retained or aged snapshot' : 'Prepared observation',
  }));
  return { marketBriefing, sections: [
    { id: 'business-conditions', title: 'Business conditions', description: 'The same three breadth measures as the Market briefing. Positive means greater than zero; denominators include only available observations.',
      columns: [col('label', 'Business measure'), col('share', 'Positive share', 'percent'), col('positive', 'Positive companies', 'number'),
        col('count', 'Available companies', 'number'), col('context', 'Definition', 'text', 65)], rows: breadth, pdfRowLimit: 3 },
    { id: 'cftc-macro', title: 'Six windows into the macro market', description: 'The Market page’s fixed financial and physical market observations. Each retains its own participant category and report date.',
      columns: [col('category', 'Macro category'), col('market', 'Contract', 'text', 38), col('family', 'Family'), col('group', 'Trader category'),
        col('code', 'Contract code'), col('reportDate', 'Report date', 'date'), col('netOi', 'Net / open interest', 'percent'),
        col('oneWeekChangePp', '1-week change (pp)', 'number'), col('long', 'Long contracts', 'number'), col('short', 'Short contracts', 'number'),
        col('net', 'Net contracts', 'number'), col('openInterest', 'Open interest', 'number'), col('oneWeekChange', '1-week net change', 'number'),
        col('exchange', 'Exchange'), col('units', 'Contract units'), col('context', 'Macro context', 'text', 65), col('coverage', 'Coverage')],
      rows: macroRows, pdfRowLimit: 0, footnote: 'Net/open-interest changes are percentage points, not price returns or investment flows. Contracts are not added across markets.' },
    { id: 'sector-comparison', title: 'Sector performance', description: 'Five financial-statement measures from the Market page. Equal-issuer medians with a separate available-company denominator for each metric.',
      columns: [col('sector', 'Primary sector', 'text', 32), col('companies', 'Loaded companies', 'number'), ...metricColumns()],
      rows: sectorRows, pdfRowLimit: 0, footnote: 'Financial performance describes business fundamentals, not security-price returns. Missing values are excluded separately for each metric.' },
    { id: 'sector-statistics', title: 'Sector statistics', description: 'Median, mean, quartiles and range across available companies. Quartiles use inclusive linear interpolation at (n − 1) × p; sample sizes are explicit.',
      columns: [col('sector', 'Sector', 'text', 32), col('metric', 'Financial measure', 'text', 36),
        ...['median', 'mean', 'p25', 'p75', 'min', 'max'].map(key => col(key, { median: 'Median', mean: 'Mean', p25: '25th percentile', p75: '75th percentile', min: 'Minimum', max: 'Maximum' }[key], 'percent')),
        col('positive', 'Positive companies', 'number'), col('negative', 'Negative companies', 'number'), col('count', 'Available companies', 'number'),
        col('companies', 'Sector companies', 'number'), col('coverage', 'Metric coverage', 'percent')], rows: statistics, pdfRowLimit: 0 },
    { id: 'sector-industries', title: 'Industries within sectors', description: 'Every valid reported SEC SIC code within its primary sector, with the same five median measures and their available-company counts.',
      columns: [col('sector', 'Sector', 'text', 32), col('code', 'SEC SIC'), col('industry', 'Industry', 'text', 48),
        col('known', 'Reference label available'), col('companies', 'Companies', 'number'), ...metricColumns()], rows: industries, pdfRowLimit: 0,
      footnote: 'Missing or invalid SIC codes are excluded. Valid reported codes without a reference label remain present. Small samples can be dominated by individual companies.' },
  ] };
}
