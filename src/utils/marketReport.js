import { buildMarketMacroSummary, MARKET_SECTOR_METRICS } from './marketMacroSummary.js';
import { MARKET_METRICS, MARKET_ATLAS_FRESH_MS, isOlderReport } from './marketResearch.js';
import { CFTC_FAMILIES, CFTC_REPORT_BASIS, CFTC_SCHEMA_VERSION, cftcDate, isCftcContractCode, normalizeCftcRow } from './cftc.js';
import { isCftcEnabled } from './cftcFeature.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? value : null;
const fraction = value => finite(value) ? value / 100 : null;
const text = value => typeof value === 'string' ? value.trim().slice(0, 1200) : '';
const day = value => typeof value === 'string' && cftcDate(value) === value ? value : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const cik = value => /^\d{1,10}$/.test(String(value)) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const col = (key, label, format = 'text', width) => ({ key, label, format, ...(width ? { width } : {}) });
const fail = message => Object.assign(new Error(message), { status: 503, code: 'MARKET_REPORT_UNAVAILABLE' });
const pct = value => finite(value) ? `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%` : 'unavailable';

function validOverview(input, generatedAt, basis) {
  if (!input || !timestamp(input.generatedAt) || Date.parse(input.generatedAt) > Date.parse(generatedAt)
    || !Array.isArray(input.companies) || !input.companies.length || input.companies.length > 20000
    || !Array.isArray(input.cohorts)) throw fail('The prepared sector research snapshot is unavailable or invalid. Retry the market report.');
  const issuers = new Map();
  for (const company of input.companies) {
    const id = cik(company?.cik);
    if (!id || !/^[A-Z0-9][A-Z0-9.^/$-]{0,31}$/.test(company.ticker || '') || !text(company.name)
      || !Array.isArray(company.cohorts) || !company.metrics || !company.reports)
      throw fail('The prepared sector research contains an unverifiable company identity.');
    const period = company.reports[basis];
    if (period && (!day(period.end) || period.end > generatedAt.slice(0, 10)
      || period.filed && (!day(period.filed) || period.filed > generatedAt.slice(0, 10))))
      throw fail('A company reporting date is invalid in the prepared sector snapshot.');
    const normalized = { ...company, cik: id,
      metrics: { ...company.metrics, [basis]: Object.fromEntries(MARKET_METRICS.map(metric =>
        [metric.key, period ? number(company.metrics[basis]?.[metric.key]) : null])) } };
    const prior = issuers.get(id);
    // Share classes identify one issuer. Identical observations collapse; a
    // conflicting copy cannot silently choose a different financial result.
    if (prior && (JSON.stringify(prior.metrics[basis]) !== JSON.stringify(normalized.metrics[basis])
      || JSON.stringify(prior.reports[basis]) !== JSON.stringify(normalized.reports[basis])
      || prior.sector !== normalized.sector)) throw fail('Conflicting share-class observations prevent an issuer-level market comparison.');
    if (!prior) issuers.set(id, normalized);
  }
  return { ...input, companies: [...issuers.values()] };
}

function officialCftcSource(value, family) {
  try {
    const url = new URL(value), expected = new URL(CFTC_FAMILIES[family].sourceUrl);
    return url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

/** Validate the public snapshot and recalculate current positions from the raw
 * CFTC row. Catalog-only contracts remain explicit, with blank position cells. */
function cftcProjection(input, family, generatedAt) {
  const definition = CFTC_FAMILIES[family], date = day(input?.report_date);
  const sourceUrl = officialCftcSource(input?.source?.url, family);
  if (input?.schema_version !== CFTC_SCHEMA_VERSION || input.report_family !== family || input.report_basis !== CFTC_REPORT_BASIS
    || !date || date > generatedAt.slice(0, 10) || !timestamp(input.retrieved_at) || Date.parse(input.retrieved_at) > Date.parse(generatedAt)
    || !['ready', 'partial', 'stale'].includes(input.status) || !sourceUrl || input.source.dataset_id !== definition.datasetId
    || !Array.isArray(input.catalog) || !input.catalog.length || input.catalog.length > 1000 || !Array.isArray(input.latest)
    || input.coverage?.catalog_rows !== input.catalog.length) throw fail(`The ${definition.label} snapshot did not verify its dataset, basis, date and catalog.`);
  const catalog = new Map();
  for (const item of input.catalog) {
    if (item?.family !== family || item.reportDate !== date || !isCftcContractCode(item.code) || !text(item.marketName)
      || catalog.has(item.code)) throw fail(`The ${definition.label} contract catalog contains an invalid or duplicated identity.`);
    catalog.set(item.code, item);
  }
  const latest = new Map();
  for (const row of input.latest) {
    const normalized = normalizeCftcRow(row?.raw, family);
    if (!normalized.ok || normalized.value.reportDate !== date || row.family !== family || row.reportBasis !== CFTC_REPORT_BASIS
      || row.reportDate !== date || row.code !== normalized.value.code || !catalog.has(row.code) || latest.has(row.code)
      || row.openInterest !== normalized.value.openInterest || !row.groups)
      throw fail(`The ${definition.label} position row did not match its original CFTC identity.`);
    const contract = catalog.get(row.code);
    if (row.venueCode !== normalized.value.venueCode || row.units !== normalized.value.units
      || ['units', 'exchange', 'marketName', 'contractName'].some(key => contract[key] !== normalized.value[key]))
      throw fail(`The ${definition.label} contract units or market identity did not match its original CFTC row.`);
    for (const group of definition.groups) {
      const actual = row.groups[group.id], original = normalized.value.groups[group.id];
      if (!actual || ['long', 'short', 'spreading', 'net', 'netPctOi'].some(key => actual[key] !== original[key]))
        throw fail(`The ${definition.label} position calculations did not reconcile to the original CFTC row.`);
    }
    latest.set(row.code, { ...row, ...normalized.value, analytics: row.groups });
  }
  const defaultGroup = family === 'tff' ? 'leveraged-funds' : 'managed-money';
  const rows = [], categories = new Map(), defaultRows = [];
  let available = 0, missingValues = 0;
  for (const item of [...catalog.values()].sort((a, b) => String(a.category).localeCompare(String(b.category)) || a.code.localeCompare(b.code))) {
    const position = latest.get(item.code), category = text(item.categoryLabel) || 'Unclassified';
    if (!categories.has(category)) categories.set(category, { family: definition.shortLabel, category, catalog: 0, positions: 0, reportDate: date });
    const groupCoverage = categories.get(category); groupCoverage.catalog++;
    const numeric = Boolean(position && finite(position.openInterest) && text(position.units) && definition.groups.every(group =>
      finite(position.groups[group.id].long) && finite(position.groups[group.id].short)
      && (!group.spread || finite(position.groups[group.id].spreading))));
    if (numeric) { available++; groupCoverage.positions++; }
    for (const group of definition.groups) {
      const current = position?.groups[group.id], analytics = position?.analytics[group.id];
      const row = { family: definition.label, familyId: family, basis: 'Futures only', reportDate: date,
        code: item.code, market: text(item.launchLabel) || text(item.contractName) || text(item.marketName),
        exchange: text(item.exchange), category, units: text(item.units), group: group.label, groupId: group.id,
        openInterest: number(position?.openInterest), long: number(current?.long), short: number(current?.short),
        spreading: number(current?.spreading), spreadingStatus: current?.spreadingStatus || (group.spread ? 'unavailable' : 'not_applicable'),
        net: number(current?.net), netOi: fraction(current?.netPctOi),
        oneWeekChange: number(analytics?.oneWeekChange), oneWeekChangePp: number(analytics?.oneWeekNetPctChange),
        fourWeekChange: number(analytics?.fourWeekChange), fourWeekChangePp: number(analytics?.fourWeekNetPctChange),
        sourceRowId: text(position?.sourceRowId), sourceId: `cftc-${family}`, retrievedAt: input.retrieved_at,
        coverage: !position ? 'Catalog identity only; positions not prepared' : current?.net == null || position.openInterest == null
          ? 'Position values incomplete' : position.reconciliation.status === 'mismatch' ? 'Source reconciliation difference' : 'Reported positions available' };
      if (position && (row.net === null || row.openInterest === null || row.netOi === null)) missingValues++;
      rows.push(row);
      if (position && group.id === defaultGroup) defaultRows.push(row);
    }
  }
  const stale = input.status === 'stale' || input.freshness?.source_currency === 'aged'
    || String(input.freshness?.cache_status).startsWith('stale') || Date.parse(generatedAt) - Date.parse(date) > 11 * 86400000;
  return { family, definition, date, sourceUrl, retrievedAt: input.retrieved_at, catalogCount: catalog.size,
    positionsCount: latest.size, available, missingValues, rows, defaultRows, categories: [...categories.values()],
    stale, partial: input.status !== 'ready' || stale || available !== catalog.size || missingValues > 0
      || (input.coverage.reconciliation_differences || 0) > 0,
    warning: text(input.refresh_warning), reconciliation: input.coverage.reconciliation_differences || 0 };
}

/** A reusable market-wide projection of prepared SEC fundamentals and CFTC
 * positioning. Financial performance here means reported business results. */
export function buildMarketReport({ overview, cftcFamilies = [], failures = [] } = {}, {
  basis = 'ttm', generatedAt = new Date().toISOString(),
} = {}) {
  if (!['annual', 'ttm'].includes(basis) || !timestamp(generatedAt))
    throw Object.assign(new Error('Choose annual or TTM sector fundamentals.'), { status: 400 });
  generatedAt = timestamp(generatedAt);
  const data = validOverview(overview, generatedAt, basis), macro = buildMarketMacroSummary(data, basis);
  // Snapshot provenance retains its original clock. Reporting-age statements
  // and issuer rows both use this report's generation time, including retained
  // snapshots whose fiscal periods have crossed the age threshold since capture.
  macro.olderReports = data.companies.filter(company => isOlderReport(company, basis, generatedAt)).length;
  const sources = [];
  const addSource = source => { sources.push(source); return source.id; };
  addSource({ id: 'market-snapshot', label: 'Prepared SEC Market research snapshot', url: 'https://secedgarterminal.com/api/market-research',
    note: `Snapshot generated ${data.generatedAt}. ${text(data.coverage?.grouping) || 'One primary sector per issuer; overlapping themes excluded.'}` });
  const companies = data.companies.map(company => {
    const period = company.reports[basis], id = `sec-${company.cik}`;
    addSource({ id, label: `${company.ticker} · SEC company facts`, url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${company.cik}.json`,
      periodEnd: day(period?.end) || undefined, note: 'Prepared scalar metrics use the site’s SEC mapping. This facts document supports issuer research; it is not a claim that one filing supplies every metric.' });
    let filingSourceId = null;
    if (/^\d{10}-\d{2}-\d{6}$/.test(period?.accession || '')) filingSourceId = addSource({
      id: `${id}-filing`, label: `${company.ticker} · Reporting-period filing index`,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${period.accession.replaceAll('-', '')}/${period.accession}-index.html`,
      periodEnd: period.end, filed: day(period.filed) || undefined, accession: period.accession, form: text(period.form),
      note: 'Period-level filing reference; TTM and growth calculations can combine multiple filing contexts.' });
    const sector = macro.sectors.find(row => row.id && company.cohorts.includes(row.id))?.label;
    return { ticker: company.ticker, name: company.name, cik: company.cik, sector: text(company.sector) || sector || 'Unclassified',
      sic: text(String(company.sic ?? '')), basis: basis.toUpperCase(), periodEnd: day(period?.end), filed: day(period?.filed),
      sourceRetrievedAt: timestamp(company.factsRetrievedAt || company.observedAt), sourceCheckedAt: timestamp(company.secCheckedAt || company.factsValidatedAt),
      olderReport: isOlderReport(company, basis, generatedAt) ? 'Older or unavailable reporting period' : 'Within report-age window',
      revenueBasis: text(company.revenueBasis), sourceId: id, filingSourceId,
      ...Object.fromEntries(MARKET_METRICS.map(metric => [metric.key, metric.unit === 'pct'
        ? fraction(company.metrics[basis]?.[metric.key]) : number(company.metrics[basis]?.[metric.key])])) };
  }).sort((a, b) => a.sector.localeCompare(b.sector) || a.ticker.localeCompare(b.ticker));
  const issues = failures.map(item => typeof item === 'string' ? item : text(item?.message)).filter(Boolean), positioning = [];
  for (const family of Object.keys(CFTC_FAMILIES)) {
    const candidates = cftcFamilies.filter(snapshot => snapshot?.report_family === family);
    if (candidates.length !== 1) { issues.push(`${CFTC_FAMILIES[family].label}: prepared positioning is unavailable.`); continue; }
    try { positioning.push(cftcProjection(candidates[0], family, generatedAt)); }
    catch (error) { issues.push(error.message); }
  }
  for (const snapshot of positioning) addSource({ id: `cftc-${snapshot.family}`, label: `${snapshot.definition.label} · ${snapshot.date} · Futures only`,
    url: snapshot.sourceUrl, periodEnd: snapshot.date, note: `Dataset ${snapshot.definition.datasetId}. Retrieved ${snapshot.retrievedAt}. ${snapshot.positionsCount} contracts with prepared positions of ${snapshot.catalogCount} catalog identities.` });
  const requested = Number.isInteger(data.coverage?.target_issuers) ? data.coverage.target_issuers : Number.isInteger(data.requested) ? data.requested : null;
  const missingCompanies = requested !== null ? Math.max(0, requested - macro.companyCount) : Array.isArray(data.failures) ? data.failures.length : null;
  const cftcCatalog = positioning.reduce((sum, snapshot) => sum + snapshot.catalogCount, 0);
  const cftcPrepared = positioning.reduce((sum, snapshot) => sum + snapshot.positionsCount, 0);
  const stale = data.cache?.status === 'stale' || Date.parse(generatedAt) - Date.parse(data.generatedAt) > MARKET_ATLAS_FRESH_MS;
  const availableMetrics = companies.reduce((sum, row) => sum + MARKET_METRICS.filter(metric => finite(row[metric.key])).length, 0);
  const sectorMetrics = macro.sectors.flatMap(sector => MARKET_SECTOR_METRICS.map(metric => ({
    sector: sector.label, metric: metric.label, median: fraction(sector.metrics[metric.key]?.median),
    available: sector.metrics[metric.key]?.count || 0, companies: sector.count,
    coverage: sector.count ? (sector.metrics[metric.key]?.count || 0) / sector.count : null,
    sourceId: 'market-snapshot', methodology: metric.context,
  })));
  const sectorRows = macro.sectors.map(sector => ({ sector: sector.label, companies: sector.count,
    target: sector.targetCount, growth: fraction(sector.metrics.revenueGrowth.median), growthN: sector.metrics.revenueGrowth.count,
    margin: fraction(sector.metrics.netMargin.median), marginN: sector.metrics.netMargin.count,
    growthBreadth: fraction(sector.metrics.revenueGrowth.positivePct), cash: fraction(sector.metrics.cashFlowMargin.median),
    cashN: sector.metrics.cashFlowMargin.count, capex: fraction(sector.metrics.capexIntensity.median), capexN: sector.metrics.capexIntensity.count,
    equity: fraction(sector.metrics.equityToAssets.median), equityN: sector.metrics.equityToAssets.count, sourceId: 'market-snapshot' }));
  const sourceDates = [...new Set(positioning.map(snapshot => snapshot.date))].sort();
  const notes = [
    'Sector performance describes SEC-reported business fundamentals: revenue growth, margins, cash generation, investment and book capital. This report contains no security-price returns or investment-performance estimates.',
    'Sector statistics are unweighted medians across distinct covered SEC issuers. Each metric excludes unavailable values and discloses its own observation count. Growth breadth is the share of companies with positive revenue growth among companies with an available growth value. Zero remains a valid observation.',
    'The prepared research universe is not the entire U.S. equity market or a market-cap-weighted index. Primary sector groups are disjoint; overlapping research themes do not enter sector totals. Coverage and membership can change between snapshots.',
    `${basis === 'ttm' ? 'Trailing-twelve-month' : 'Annual'} results combine companies with different fiscal reporting dates. Snapshot time is not a common financial period or a point-in-time backtest. Industry accounting, revenue definitions, financial-company balance sheets and unusual items limit cross-sector comparisons.`,
    'The company appendix includes every distinct issuer in this snapshot, all available screening metrics and reporting dates. Prepared overview inputs do not contain fact-by-fact provenance; use the separate company report for detailed financial-source observations.',
    'CFTC counts distinguish the broad contract catalog from contracts with prepared position values. Catalog-only contracts and unreported values remain blank. The detailed workbook preserves all catalog contracts and trader groups; PDF positioning tables contain every contract with available prepared rows for the stated family and trader group.',
    'CFTC figures are futures-only contract counts. Net equals long minus short; net/open interest is that difference divided by open interest. Contract units differ, so contract counts and net positions are never added across different markets. Trader positioning is not a forecast, a security holding, or a company exposure.',
    'CFTC weekly and four-week changes use compatible observations exactly 7 and 28 calendar days earlier. Net/open-interest changes are percentage points, not percentage growth. Missing comparisons remain unavailable; source report dates can differ between families.',
    ...(stale ? ['The SEC research snapshot is retained and its scheduled check is due; it may not contain the newest filings.'] : []),
    ...positioning.flatMap(snapshot => [snapshot.warning, snapshot.stale ? `${snapshot.definition.label}: source report or cache is aged.` : '',
      snapshot.reconciliation ? `${snapshot.definition.label}: ${snapshot.reconciliation} source contract reconciliation differences are disclosed by the prepared dataset.` : ''].filter(Boolean)),
    ...issues,
  ];
  const fullPositionRows = positioning.flatMap(snapshot => snapshot.rows);
  const coverageRows = [{ dataset: 'SEC company fundamentals', observation: data.generatedAt, available: macro.companyCount, target: requested,
    detail: `${missingCompanies ?? 'Unknown'} unavailable issuers; ${macro.missingSectorCount} without a primary sector; ${macro.olderReports} older or unavailable reporting periods.` },
  ...Object.entries(CFTC_FAMILIES).map(([family, definition]) => {
    const snapshot = positioning.find(item => item.family === family);
    return { dataset: `CFTC ${definition.shortLabel}`, observation: snapshot?.date || null, available: snapshot?.positionsCount ?? null,
      target: snapshot?.catalogCount ?? null, detail: snapshot ? `Prepared positions / catalog contracts. Retrieved ${snapshot.retrievedAt}; ${snapshot.stale ? 'aged' : 'source date retained'}.` : 'Source unavailable; no positions inferred.' };
  })];
  const partial = stale || missingCompanies > 0 || macro.missingSectorCount > 0 || macro.olderReports > 0
    || availableMetrics < companies.length * MARKET_METRICS.length || issues.length > 0 || positioning.some(snapshot => snapshot.partial);
  return {
    schema: 'edgar.report.v1', kind: 'market', generatedAt, entity: { id: 'MARKET', name: 'Market overview', cik: '' },
    title: 'Market overview | Sectors, fundamentals and CFTC positioning',
    subtitle: 'SEC issuer fundamentals and CFTC futures positioning · Independent market research report',
    period: { label: `${basis.toUpperCase()} fundamentals · SEC snapshot ${data.generatedAt.slice(0, 10)}`,
      asOf: data.generatedAt.slice(0, 10), filingDate: null, basis },
    summary: [
      { label: 'Covered SEC issuers', value: macro.companyCount, unit: 'number', detail: requested === null ? 'Prepared universe; target unavailable' : `${requested} requested issuers`, sourceIds: ['market-snapshot'] },
      { label: 'Primary sectors', value: macro.sectorCount, unit: 'number', detail: `${macro.missingSectorCount} unclassified issuers`, sourceIds: ['market-snapshot'] },
      { label: 'Median revenue growth', value: fraction(macro.growth.median), unit: 'percent', detail: `${macro.growth.count} available company observations; year over year`, sourceIds: ['market-snapshot'] },
      { label: 'Median net margin', value: fraction(macro.metrics.netMargin.median), unit: 'percent', detail: `${macro.metrics.netMargin.count} available company observations`, sourceIds: ['market-snapshot'] },
      { label: 'Positive revenue growth', value: fraction(macro.growth.positivePct), unit: 'percent', detail: `${macro.growth.positive} of ${macro.growth.count} issuers with growth data`, sourceIds: ['market-snapshot'] },
      { label: 'CFTC prepared markets', value: positioning.length ? cftcPrepared : null, unit: 'number', detail: positioning.length ? `${cftcCatalog} catalog contracts across ${positioning.length} families; dates ${sourceDates.join(', ')}` : 'CFTC sources unavailable', sourceIds: positioning.map(snapshot => `cftc-${snapshot.family}`) },
    ],
    highlights: [
      { title: 'Business performance across sectors', text: `${macro.companyCount.toLocaleString('en-US')} distinct SEC issuers span ${macro.sectorCount} primary sectors. Median revenue growth is ${pct(macro.growth.median)}, using ${macro.growth.count} available observations. Sector comparisons retain their individual observation counts.` },
      { title: 'Reporting dates and breadth', text: macro.reportRange
        ? `Company reporting periods end from ${macro.reportRange.earliest} through ${macro.reportRange.latest}. ${macro.growth.positive} of ${macro.growth.count} measured issuers report positive revenue growth; ${macro.olderReports} issuers have older or unavailable reporting periods.`
        : 'Company reporting dates are unavailable; financial observations are withheld until a reporting period is verified.' },
      { title: 'Futures market context', text: positioning.length
        ? `${cftcPrepared} contracts have prepared position rows within a ${cftcCatalog}-contract catalog. Report dates: ${sourceDates.join(', ')}. The report preserves each contract, family, trader group and futures-only basis separately.`
        : 'CFTC prepared positioning could not be loaded. The available SEC sector report remains downloadable and CFTC cells remain unavailable.' },
    ],
    charts: [{ kind: 'bar', title: 'Median sector revenue growth', unit: 'percent', points: sectorRows.map(row => ({ label: row.sector, value: row.growth })) },
      { kind: 'bar', title: 'Median sector net margin', unit: 'percent', points: sectorRows.map(row => ({ label: row.sector, value: row.margin })) }],
    sections: [
      { id: 'market-coverage', title: 'Coverage and source dates', description: 'SEC companies and CFTC contracts have separate universes, dates and coverage denominators.',
        columns: [col('dataset', 'Dataset'), col('observation', 'Snapshot / report date'), col('available', 'Available', 'number'), col('target', 'Universe', 'number'), col('detail', 'Coverage detail', 'text', 70)], rows: coverageRows },
      { id: 'sector-performance', title: 'Sector growth and profitability', description: `${basis.toUpperCase()} company fundamentals; unweighted issuer medians. No stock-price returns. n = available issuer observations.`,
        columns: [col('sector', 'Primary sector', 'text', 32), col('companies', 'Issuers', 'number'), col('growth', 'Revenue growth', 'percent'), col('growthN', 'Growth n', 'number'), col('margin', 'Net margin', 'percent'), col('marginN', 'Margin n', 'number')], rows: sectorRows, pdfRowLimit: 40 },
      { id: 'sector-cash-capital', title: 'Sector cash generation and capital', description: 'Unweighted issuer medians; each available-value count appears beside the corresponding statistic.',
        columns: [col('sector', 'Primary sector', 'text', 32), col('cash', 'Operating CF / revenue', 'percent'), col('cashN', 'Cash n', 'number'), col('capex', 'Capex / revenue', 'percent'), col('capexN', 'Capex n', 'number'), col('equity', 'Book equity / assets', 'percent'), col('equityN', 'Capital n', 'number')], rows: sectorRows, pdfRowLimit: 40 },
      { id: 'sector-metric-coverage', title: 'Sector metric coverage', description: 'Every sector and displayed metric, with its available-value denominator and interpretation.', pdfRowLimit: 0,
        columns: [col('sector', 'Sector'), col('metric', 'Metric'), col('median', 'Median', 'percent'), col('available', 'Available observations', 'number'), col('companies', 'Sector issuers', 'number'), col('coverage', 'Metric coverage', 'percent'), col('methodology', 'Interpretation', 'text', 80)], rows: sectorMetrics },
      { id: 'cftc-market-coverage', title: 'CFTC market coverage by category', description: 'Coverage spans the full returned contract catalog. Numeric positions are limited to prepared contract rows.',
        columns: [col('family', 'Family'), col('category', 'Market category'), col('catalog', 'Catalog contracts', 'number'), col('positions', 'Complete positions', 'number'), col('reportDate', 'Report date', 'date')], rows: positioning.flatMap(snapshot => snapshot.categories), pdfRowLimit: 30 },
      ...positioning.map(snapshot => ({ id: `cftc-${snapshot.family}`, title: `CFTC ${snapshot.definition.shortLabel} positioning`,
        description: `${snapshot.family === 'tff' ? 'Leveraged Funds' : 'Managed Money'} · Futures only · ${snapshot.date}. Every contract with prepared positions in this family; counts are contracts, not dollars.`,
        columns: [col('market', 'Contract market', 'text', 38), col('netOi', 'Net / open interest', 'percent'), col('long', 'Long', 'number'), col('short', 'Short', 'number'), col('oneWeekChangePp', '1-week change (pp)', 'number')], rows: snapshot.defaultRows, pdfRowLimit: 100,
        footnote: 'One-week change is the change in net/open-interest percentage points from the compatible report exactly seven days earlier. No cross-contract position totals are calculated.' })),
      { id: 'market-companies', title: 'All covered SEC companies', description: `${basis.toUpperCase()} prepared observations for every distinct covered issuer. Missing metrics remain blank. Percent cells are fractional values.`, pdfRowLimit: 0,
        columns: [col('ticker', 'Ticker'), col('name', 'Company', 'text', 40), col('cik', 'SEC CIK'), col('sector', 'Primary sector'), col('sic', 'SIC'), col('basis', 'Basis'), col('periodEnd', 'Period end', 'date'), col('filed', 'Period filed', 'date'),
          ...MARKET_METRICS.map(metric => col(metric.key, metric.label, metric.unit === 'pct' ? 'percent' : metric.unit === 'ratio' ? 'ratio' : 'usd')),
          col('revenueBasis', 'Revenue basis'), col('sourceRetrievedAt', 'Source retrieved'), col('sourceCheckedAt', 'Source checked'), col('olderReport', 'Reporting age'), col('sourceId', 'Facts source ID'), col('filingSourceId', 'Period filing source ID')], rows: companies },
      { id: 'cftc-all-groups', title: 'All CFTC contracts and groups', description: 'Full returned catalog × family-specific trader groups. Catalog-only positions are blank. Current net values are recalculated from original long/short fields; source-derived weekly changes retain exact date scope.', pdfRowLimit: 0,
        columns: [col('family', 'Report family'), col('basis', 'Report basis'), col('reportDate', 'Report date', 'date'), col('code', 'Contract code'), col('market', 'Market', 'text', 40), col('exchange', 'Exchange'), col('category', 'Category'), col('units', 'Contract units'), col('group', 'Trader group'), col('openInterest', 'Open interest', 'number'), col('long', 'Long contracts', 'number'), col('short', 'Short contracts', 'number'), col('spreading', 'Spreading contracts', 'number'), col('spreadingStatus', 'Spreading status'), col('net', 'Net contracts', 'number'), col('netOi', 'Net / open interest', 'percent'), col('oneWeekChange', '1-week net change', 'number'), col('oneWeekChangePp', '1-week change (pp)', 'number'), col('fourWeekChange', '4-week net change', 'number'), col('fourWeekChangePp', '4-week change (pp)', 'number'), col('coverage', 'Coverage'), col('retrievedAt', 'Source retrieved'), col('sourceRowId', 'Original source row'), col('sourceId', 'Source ID')], rows: fullPositionRows },
    ], sources, notes: [...new Set(notes)],
    coverage: { status: partial ? 'partial' : 'ready', recordCount: companies.length + fullPositionRows.length,
      availableMetrics, totalMetrics: companies.length * MARKET_METRICS.length,
      message: `${companies.length} distinct SEC issuers; ${macro.sectorCount} primary sectors. CFTC: ${cftcPrepared} prepared-position contracts within ${cftcCatalog} returned catalog contracts across ${positioning.length} of 2 families. Missing values and unavailable sources are disclosed.` },
  };
}

/** Match the public CFTC endpoints' rollback switch before loading any source. */
export function createNativeMarketCftcReader({ enabled = isCftcEnabled, load } = {}) {
  return async options => {
    if (!enabled()) throw Object.assign(new Error('CFTC positioning is disabled.'), { code: 'CFTC_DISABLED' });
    const reader = load || (await import('./cftcServer.js')).loadCftcMarkets;
    return reader(options);
  };
}

/** Only prepared public readers. These callbacks never force an upstream
 * rebuild; preview callers can inject anonymous fixed-origin public GETs. */
export function createMarketReportLoader({ loadOverview, loadCftcMarkets, now = () => new Date().toISOString() } = {}) {
  return async ({ basis = 'ttm' } = {}, signal) => {
    if (!['annual', 'ttm'].includes(basis)) throw Object.assign(new Error('Choose annual or TTM sector fundamentals.'), { status: 400 });
    signal?.throwIfAborted();
    const overviewReader = loadOverview || (async () => (await import('./marketOverviewServer.js')).readMarketOverview());
    const cftcReader = loadCftcMarkets || createNativeMarketCftcReader();
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)]);
    const bounded = work => new Promise((resolve, reject) => {
      const abort = () => reject(deadline.reason || fail('Prepared market research timed out.'));
      deadline.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(work).then(resolve, reject).finally(() => deadline.removeEventListener('abort', abort));
      if (deadline.aborted) abort();
    });
    const tasks = [bounded(() => overviewReader({ signal: deadline })), ...Object.keys(CFTC_FAMILIES).map(family =>
      bounded(() => cftcReader({ family, reportDate: 'latest', preparedOnly: true, signal: deadline })))];
    const results = await Promise.allSettled(tasks);
    signal?.throwIfAborted();
    if (results[0].status !== 'fulfilled') throw fail('The prepared SEC market snapshot is unavailable. Retry the market report.');
    const cftcFamilies = results.slice(1).filter(result => result.status === 'fulfilled').map(result => result.value);
    const failures = results.slice(1).flatMap((result, index) => result.status === 'rejected'
      ? [`${Object.values(CFTC_FAMILIES)[index].label}: ${result.reason?.code === 'CFTC_DISABLED' ? 'positioning is disabled.' : 'prepared source could not be loaded.'}`] : []);
    return buildMarketReport({ overview: results[0].value, cftcFamilies, failures }, { basis, generatedAt: new Date(now()).toISOString() });
  };
}

export const loadMarketReport = createMarketReportLoader();
