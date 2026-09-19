import { ASSET_LABELS, portfolioSummary } from './fundResearch.js';
import { summarize13FPortfolio } from './thirteenF.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? value : null;
const fraction = value => finite(value) ? value / 100 : null;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const unique = values => [...new Set(values.filter(Boolean))];
const col = (key, label, format = 'text', width) => ({ key, label, format, ...(width ? { width } : {}) });
const countText = value => value.toLocaleString('en-US');
const percentText = value => `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
const dollarsText = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(value);
const byValue = (a, b) => (finite(b.value) ? b.value : -Infinity) - (finite(a.value) ? a.value : -Infinity) || String(a.name).localeCompare(String(b.name));
function failure(message, code = 'REPORT_UNAVAILABLE') { return Object.assign(new Error(message), { status: 422, code }); }
function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
function secUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.sec.gov', 'sec.gov', 'data.sec.gov'].includes(url.hostname)
      && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}
function timestamp(value = new Date().toISOString()) {
  if (!Number.isFinite(Date.parse(value))) throw failure('The report generation date is invalid.', 'INVALID_REPORT_DATE');
  return new Date(value).toISOString();
}
function assertIdentity(cik, name, date) {
  if (!/^(?!0000000000)\d{10}$/.test(cik || '') || !text(name) || !isoDate(date))
    throw failure('The report identity or reporting date could not be verified. Retry the source report.', 'INVALID_REPORT_SOURCE');
}
function sourceClockNotes(data, observedAt) {
  return [
    ...(text(observedAt) ? [`Source retrieved: ${observedAt}.`] : []),
    ...(text(data.cache?.checkedAt) ? [`Source last checked: ${data.cache.checkedAt}.`] : []),
    ...(data.cache?.stale ? ['The source check is due. This retained report may not include a newer filing or amendment.'] : []),
    text(data.sourceCheckNotice),
  ].filter(Boolean);
}

/** Pure report projection. The caller must supply the complete validated loader result. */
export function buildNportReport(data, { generatedAt } = {}) {
  if (data?.status !== 'ready') throw failure(data?.reason || 'A public N-PORT portfolio is unavailable for this fund.');
  assertIdentity(data.cik, data.name, data.asOf);
  if (!Array.isArray(data.holdings) || !data.fundInfo || data.responseScope === 'summary'
    || data.pagination && data.pagination.portfolioTotal !== data.holdings.length
    || data.summary?.count != null && data.summary.count !== data.holdings.length)
    throw failure('A complete N-PORT holdings response is required to prepare the report. Retry the full portfolio.', 'INCOMPLETE_REPORT_RESPONSE');
  const sourceUrl = secUrl(data.sourceUrl), filingUrl = secUrl(data.filingUrl);
  if (!sourceUrl || !filingUrl) throw failure('The original N-PORT source links could not be verified.', 'INVALID_REPORT_SOURCE');
  const summary = portfolioSummary(data);
  const valuedComplete = summary.valuedCount === summary.count;
  const weightComplete = summary.weightCount === summary.count;
  const sources = [
    { id: 'nport-filing', label: `${data.form || 'NPORT-P'} filing`, url: filingUrl, form: data.form || 'NPORT-P', periodEnd: data.asOf, filed: data.filingDate, accession: data.accession },
    { id: 'nport-portfolio', label: 'N-PORT portfolio XML', url: sourceUrl, form: data.form || 'NPORT-P', periodEnd: data.asOf, filed: data.filingDate, accession: data.accession,
      note: data.seriesId ? `SEC series ${data.seriesId}; ${data.identity || 'verified portfolio identity'}.` : data.identity || 'Verified SEC registrant identity.' },
  ];
  const holdings = data.holdings.map(row => ({
    position: row.id, name: row.name, title: row.title, ticker: row.tickerSymbol, cusip: row.cusip, isin: row.isin,
    asset: ASSET_LABELS[row.assetCat] || row.assetCat, assetCode: row.assetCat, country: row.invCountry,
    value: number(row.value), weight: fraction(row.pctOfNav), weightSource: row.weightSource,
    quantity: number(row.balance), quantityUnits: row.units, payoffProfile: row.payoffProfile,
    periodEnd: data.asOf, sourceId: 'nport-portfolio',
  })).sort(byValue);
  const top = holdings.slice(0, 10).map(row => ({ name: row.name, identifier: row.ticker || row.cusip || row.isin || 'Not reported',
    asset: row.asset, value: row.value, weight: row.weight, sourceId: row.sourceId }));
  const allocation = (groups, labels = {}) => groups.map(group => ({
    name: labels[group.key] || group.key, positions: group.count, valuedPositions: group.valued,
    value: number(group.value), weight: fraction(group.pctOfNav), sourceId: 'nport-portfolio',
  }));
  const assets = allocation(summary.assets, ASSET_LABELS), countries = allocation(summary.countries);
  const top10Weight = fraction(summary.top10Weight);
  const complete = valuedComplete && weightComplete && !data.cache?.stale && data.sourceCheckStatus !== 'regressed';
  const sourceIds = ['nport-portfolio'];
  const highlights = [
    { title: 'The reported portfolio', text: `${data.name} disclosed ${countText(holdings.length)} positions for ${data.asOf}${finite(data.fundInfo.netAssets) ? `, alongside ${dollarsText(data.fundInfo.netAssets)} in fund-series net assets` : ''}. The portfolio date differs from its ${data.filingDate || 'unavailable'} filing date.` },
    { title: 'Position concentration', text: summary.top10Weight !== null
      ? `The ten largest positive disclosed position weights total ${percentText(summary.top10Weight)} of fund-series net assets.${!weightComplete ? ' Some position weights are unavailable, so this is a view of known positive weights.' : ''} This measure does not net short positions or derivative exposure.`
      : 'Position concentration is unavailable because usable portfolio weights were not reported or could not be calculated.' },
  ];
  const largestAsset = assets.find(row => finite(row.value));
  if (largestAsset) highlights.push({ title: 'Portfolio composition', text: `${largestAsset.name} is the largest category by known reported holding value, with ${countText(largestAsset.positions)} positions${finite(largestAsset.value) ? ` and ${dollarsText(largestAsset.value)} of reported value` : ''}.${!valuedComplete ? ' Missing position values limit the allocation totals.' : ''}` });
  const notes = [
    'N-PORT describes a historical fund-series portfolio. Multiple share classes can share these net assets and holdings; this is not ticker-specific assets under management or a live portfolio.',
    'USD values are whole dollars. Percentages use fund-series net assets. Missing inputs remain blank and do not become zero.',
    'Top-ten concentration adds the ten largest positive position weights. Negative positions remain in the full holdings workbook; weights are not rescaled to 100%.',
    'Asset and country allocations add known reported holding values. They are not a complete economic exposure or derivative-notional calculation.',
    'The PDF summarizes the largest reported positions. The Excel workbook contains every available position in this selected report.',
    ...(data.form?.endsWith('/A') ? ['The selected source is an amended N-PORT filing. The report uses this portfolio as filed.'] : []),
    ...(!valuedComplete ? [`Reported values are available for ${countText(summary.valuedCount)} of ${countText(summary.count)} positions. Allocation values are sums of known amounts.`] : []),
    ...(!weightComplete ? [`Position weights are available for ${countText(summary.weightCount)} of ${countText(summary.count)} positions.`] : []),
    ...sourceClockNotes(data, data.retrievedAt),
  ];
  return {
    schema: 'edgar.report.v1', kind: 'nport', generatedAt: timestamp(generatedAt),
    entity: { id: data.ticker, name: data.name, ...(/^S\d{9}$/.test(data.ticker) && data.ticker === data.seriesId ? {} : { ticker: data.ticker }), cik: data.cik, ...(data.seriesId ? { seriesId: data.seriesId } : {}) },
    title: `${data.ticker} | Fund portfolio report`, subtitle: 'SEC N-PORT · Portfolio composition, concentration and disclosed positions',
    period: { label: `Portfolio at ${data.asOf}`, asOf: data.asOf, filingDate: isoDate(data.filingDate), basis: 'N-PORT portfolio snapshot' },
    summary: [
      { label: 'Fund-series net assets', value: number(data.fundInfo.netAssets), unit: 'usd', detail: data.fundInfo.netAssetsSource === 'assets less liabilities' ? 'Calculated: total assets less liabilities' : 'Reported series-level amount', sourceIds },
      { label: 'Disclosed positions', value: holdings.length, unit: 'number', sourceIds },
      { label: 'Top 10 positive weights', value: top10Weight, unit: 'percent', detail: 'Share of fund-series net assets', sourceIds },
      { label: valuedComplete ? 'Reported holdings value' : 'Known holdings value', value: number(summary.value), unit: 'usd', detail: `${summary.valuedCount}/${summary.count} positions with reported values`, sourceIds },
    ],
    highlights,
    charts: [{ kind: 'bar', title: 'Largest asset categories · known USD value', unit: 'usd', points: assets.slice(0, 8).map(row => ({ label: row.name, value: row.value })) }],
    sections: [
      { id: 'portfolio-finances', title: 'Fund portfolio finances', columns: [col('metric', 'Measure'), col('value', 'USD', 'usd'), col('basis', 'Reporting basis')], rows: [
        { metric: 'Total assets', value: number(data.fundInfo.totAssets), basis: 'Reported', sourceId: 'nport-portfolio' },
        { metric: 'Total liabilities', value: number(data.fundInfo.totLiabs), basis: 'Reported', sourceId: 'nport-portfolio' },
        { metric: 'Net assets', value: number(data.fundInfo.netAssets), basis: data.fundInfo.netAssetsSource, sourceId: 'nport-portfolio' },
        { metric: 'Cash not reported in Parts C or D', value: number(data.fundInfo.cash), basis: 'N-PORT reported cash field; not a total cash balance', sourceId: 'nport-portfolio' },
      ] },
      { id: 'top-positions', title: 'Largest disclosed positions', description: 'Ranked by reported USD value.', columns: [col('name', 'Position', 'text', 36), col('identifier', 'Ticker / identifier'), col('value', 'Value (USD)', 'usd'), col('weight', 'Net assets', 'percent')], rows: top, pdfRowLimit: 10, footnote: 'Weights use full fund-series net assets. See All holdings in Excel for every disclosed position.' },
      { id: 'asset-allocation', title: 'Asset composition', columns: [col('name', 'Asset category'), col('positions', 'Positions', 'number'), col('valuedPositions', 'With value', 'number'), col('value', 'Known value (USD)', 'usd'), col('weight', 'Net assets', 'percent')], rows: assets, pdfRowLimit: 10, footnote: 'Allocations add known position values; missing values remain excluded from these sums.' },
      { id: 'country-allocation', title: 'Reported country composition', columns: [col('name', 'Country'), col('positions', 'Positions', 'number'), col('value', 'Known value (USD)', 'usd'), col('weight', 'Net assets', 'percent')], rows: countries, pdfRowLimit: 10 },
      { id: 'all-holdings', title: 'All holdings', description: 'Every available position in the selected N-PORT report. Values are USD; percentages are shares of fund-series net assets.', pdfRowLimit: 0,
        columns: [col('position', 'Source position', 'number'), col('name', 'Position', 'text', 40), col('title', 'Title'), col('ticker', 'Reported ticker'), col('cusip', 'CUSIP'), col('isin', 'ISIN'), col('asset', 'Asset category'), col('assetCode', 'Asset code'), col('country', 'Country'), col('value', 'Value (USD)', 'usd'), col('weight', 'Net assets', 'percent'), col('weightSource', 'Weight basis'), col('quantity', 'Balance', 'number'), col('quantityUnits', 'Units'), col('payoffProfile', 'Payoff profile'), col('periodEnd', 'Portfolio date', 'date'), col('sourceId', 'Source ID')], rows: holdings },
      { id: 'report-identity', title: 'Report identity', columns: [col('field', 'Field'), col('value', 'Value')], rows: [
        { field: 'SEC registrant', value: data.registrant }, { field: 'CIK', value: data.cik },
        { field: 'Series ID', value: data.seriesId }, { field: 'Share class ID', value: data.classId },
        { field: 'Identity validation', value: data.identity }, { field: 'Accession', value: data.accession },
      ], pdfRowLimit: 0 },
    ], sources, notes,
    coverage: { status: complete ? 'ready' : 'partial', recordCount: holdings.length,
      message: `${countText(holdings.length)} disclosed positions included. ${countText(summary.valuedCount)} have reported values and ${countText(summary.weightCount)} have usable weights.${data.cache?.stale ? ' Source check is due.' : ''}` },
  };
}

/** Preserve the loader's amendment assembly and the distinction between options and securities. */
export function buildThirteenFReport(data, { generatedAt } = {}) {
  if (data?.status !== 'ready' || !data.portfolio) throw failure(data?.reason || 'Public Form 13F holdings are unavailable for this manager.');
  const portfolio = data.portfolio;
  assertIdentity(data.manager?.cik, data.manager?.name, portfolio.period);
  if (portfolio.cik !== data.manager.cik || data.selectedPeriod !== portfolio.period || !Array.isArray(portfolio.holdings)
    || portfolio.positionCount !== portfolio.holdings.length)
    throw failure('A complete holdings response for the selected manager and quarter is required.', 'INCOMPLETE_REPORT_RESPONSE');
  const reconciled = portfolio.complete === true && data.coverage?.selectedPeriodComplete === true;
  const summary = summarize13FPortfolio({ ...portfolio, complete: reconciled });
  const sourceMap = new Map();
  const addSource = (id, label, url, metadata) => {
    const safe = secUrl(url);
    if (safe && !sourceMap.has(safe)) sourceMap.set(safe, { id, label, url: safe, ...metadata });
  };
  const filings = (portfolio.filings || []).map((filing, i) => {
    const sourceId = `13f-${i + 1}`;
    const treatment = filing.superseded ? 'Superseded' : filing.amendmentType === 'NEW HOLDINGS' ? 'Supplemental holdings' : filing.amendmentType === 'RESTATEMENT' ? 'Restated baseline' : 'Original baseline';
    const meta = { form: filing.form, periodEnd: portfolio.period, filed: filing.filingDate, accession: filing.accession, note: treatment };
    addSource(sourceId, `${filing.form} · ${treatment}`, filing.indexUrl, meta);
    addSource(`${sourceId}-cover`, `${filing.form} cover document`, filing.primaryUrl, meta);
    (filing.tableUrls || []).forEach((url, j) => addSource(`${sourceId}-table-${j + 1}`, `${filing.form} information table ${j + 1}`, url, meta));
    return { accession: filing.accession, form: filing.form, filed: filing.filingDate, periodEnd: portfolio.period,
      treatment, amendmentNumber: number(filing.amendmentNumber), sourceId };
  });
  const sources = [...sourceMap.values()];
  if (!sources.length) throw failure('The original Form 13F source links could not be verified.', 'INVALID_REPORT_SOURCE');
  const activeSourceIds = sources.filter(source => source.note !== 'Superseded').map(source => source.id);
  const holdings = portfolio.holdings.map(row => ({
    name: row.issuer, title: row.classTitles?.join('; ') || row.classTitle, cusip: row.cusip,
    positionType: row.putCall === 'PUT' ? 'Put option' : row.putCall === 'CALL' ? 'Call option' : row.quantityType === 'PRN' ? 'Principal amount' : 'Shares',
    putCall: row.putCall, value: number(row.valueUsd), weight: reconciled ? fraction(row.weightPct) : null,
    quantity: number(row.quantity), quantityType: row.quantityType, discretion: row.investmentDiscretion, otherManager: row.otherManager,
    votingSole: number(row.votingAuthority?.sole), votingShared: number(row.votingAuthority?.shared), votingNone: number(row.votingAuthority?.none),
    sourceRows: number(row.sourceRowCount), periodEnd: portfolio.period,
  })).sort(byValue);
  const top = holdings.slice(0, 10).map(row => ({ name: row.name, cusip: row.cusip, positionType: row.positionType, value: row.value, weight: row.weight }));
  const mix = [
    { name: 'Shares', value: number(summary.ordinaryValueUsd) },
    { name: 'Principal amount', value: number(summary.principalValueUsd) },
    { name: 'Calls · underlying value', value: number(summary.callValueUsd) },
    { name: 'Puts · underlying value', value: number(summary.putValueUsd) },
  ].map(row => ({ ...row, weight: summary.totalValueUsd > 0 && row.value !== null ? row.value / summary.totalValueUsd : null }));
  const filingDate = filings.map(filing => isoDate(filing.filed)).filter(Boolean).sort().at(-1) || null;
  const confidential = portfolio.confidentialOmitted === true;
  const notes = unique([
    'Form 13F describes a manager’s public reportable holdings at quarter end. Reported value is not total assets under management, an individual fund NAV, cash flow or investment performance.',
    'Cash, short positions and securities outside Form 13F coverage are absent. Public reports may omit confidential positions.',
    'Put and call options remain separate from shares and principal-amount positions. Their reported values represent underlying securities, not premiums or net directional exposure.',
    'All monetary values are normalized to whole USD using the source filing’s applicable value units. Percentages use reconciled public 13F holdings value.',
    'The latest restatement replaces superseded filings; eligible new-holdings amendments supplement the baseline. The filing sequence is retained below.',
    'Separate source rows for the same CUSIP, option type and quantity type are combined by the source loader. Source row counts and aggregated voting authority remain in Excel.',
    'The PDF summarizes the largest reported positions. The Excel workbook contains every available assembled position for this quarter.',
    ...(confidential ? ['This filing explicitly omits confidential holdings. Values and weights describe only the public information table.'] : []),
    ...(portfolio.reportType === '13F COMBINATION REPORT' ? ['This is a combination report. Other reporting managers can hold additional reportable positions outside the included table.'] : []),
    ...(!reconciled ? ['The selected quarter could not be completely reconciled. Available rows are retained, but total value, concentration and portfolio weights are withheld.'] : []),
    ...(portfolio.issues || []), text(data.coverage?.note), ...sourceClockNotes(data, data.observedAt),
  ]);
  const highlights = [
    { title: 'Publicly disclosed holdings', text: `${data.manager.name} disclosed ${countText(holdings.length)} assembled positions for ${portfolio.period}${finite(summary.totalValueUsd) ? ` with ${dollarsText(summary.totalValueUsd)} of reported 13F value` : ''}. This describes the manager’s public reportable portfolio.` },
    { title: 'Concentration', text: finite(summary.top10Pct)
      ? `The ten largest positions account for ${percentText(summary.top10Pct)} of reconciled public holdings value. Positions retain their share, principal or option classification.`
      : 'Concentration is unavailable because the public holdings total could not be reconciled or its denominator is zero.' },
    { title: 'Filing sequence', text: `${countText(filings.length)} filing${filings.length === 1 ? '' : 's'} reviewed for this quarter, including ${countText(portfolio.amendmentCount || 0)} amendment${portfolio.amendmentCount === 1 ? '' : 's'}.${confidential ? ' The source explicitly omits confidential positions.' : ''}${!reconciled ? ' Source coverage is incomplete; review the report notes before interpreting the rows.' : ''}` },
  ];
  return {
    schema: 'edgar.report.v1', kind: '13f', generatedAt: timestamp(generatedAt),
    entity: { id: data.manager.cik, cik: data.manager.cik, name: data.manager.name },
    title: `${data.manager.name} | Institutional holdings report`, subtitle: 'SEC Form 13F · Public holdings, concentration and reporting scope',
    period: { label: `Quarter ended ${portfolio.period}`, asOf: portfolio.period, filingDate, basis: 'Form 13F quarter-end holdings' },
    summary: [
      { label: 'Reported 13F value', value: number(summary.totalValueUsd), unit: 'usd', detail: 'Public holdings value; not AUM or fund NAV', sourceIds: activeSourceIds },
      { label: 'Disclosed positions', value: holdings.length, unit: 'number', detail: `${portfolio.entryCount ?? 'Unavailable'} underlying source rows`, sourceIds: activeSourceIds },
      { label: 'Top 10 positions', value: fraction(summary.top10Pct), unit: 'percent', detail: 'Share of reconciled public holdings value', sourceIds: activeSourceIds },
      { label: 'Amendments reviewed', value: number(portfolio.amendmentCount), unit: 'number', sourceIds: activeSourceIds },
    ], highlights,
    charts: [{ kind: 'bar', title: 'Reported value by position type', unit: 'usd', points: mix.map(row => ({ label: row.name, value: row.value })) }],
    sections: [
      { id: 'top-positions', title: 'Largest disclosed positions', description: 'Ranked by reported USD value, with options shown separately.', columns: [col('name', 'Issuer', 'text', 36), col('positionType', 'Position type'), col('value', 'Value (USD)', 'usd'), col('weight', 'Reported value', 'percent')], rows: top, pdfRowLimit: 10 },
      { id: 'position-mix', title: 'Position composition', columns: [col('name', 'Position type'), col('value', 'Reported value (USD)', 'usd'), col('weight', 'Reported value', 'percent')], rows: mix,
        footnote: 'Option values describe underlying securities. They are not option premiums and do not measure net directional exposure.' },
      { id: 'filing-sequence', title: 'Filings and amendment treatment', columns: [col('accession', 'Accession', 'text', 26), col('form', 'Form'), col('filed', 'Filed', 'date'), col('treatment', 'Treatment'), col('amendmentNumber', 'Amendment', 'number')], rows: filings, pdfRowLimit: 16,
        footnote: 'Superseded filings remain traceable; their holdings are not added again to the current baseline.' },
      { id: 'all-holdings', title: 'All holdings', description: 'Every available assembled position in the selected quarter. USD values are whole dollars; weights use the reconciled public 13F total.', pdfRowLimit: 0,
        columns: [col('name', 'Issuer', 'text', 40), col('title', 'Security class'), col('cusip', 'CUSIP'), col('positionType', 'Position type'), col('putCall', 'Put / call'), col('value', 'Value (USD)', 'usd'), col('weight', 'Reported value', 'percent'), col('quantity', 'Quantity', 'number'), col('quantityType', 'Quantity units'), col('discretion', 'Investment discretion'), col('otherManager', 'Other managers'), col('votingSole', 'Voting: sole', 'number'), col('votingShared', 'Voting: shared', 'number'), col('votingNone', 'Voting: none', 'number'), col('sourceRows', 'Source rows', 'number'), col('periodEnd', 'Quarter end', 'date')], rows: holdings },
      ...(portfolio.otherManagers?.length ? [{ id: 'other-managers', title: 'Other managers named in the filing', columns: [col('name', 'Manager', 'text', 40), col('cik', 'CIK'), col('fileNumber', '13F file number'), col('sequenceNumber', 'Sequence', 'number')], rows: portfolio.otherManagers.map(row => ({ name: row.name, cik: row.cik, fileNumber: row.fileNumber, sequenceNumber: row.sequenceNumber })), pdfRowLimit: 8 }] : []),
    ], sources, notes,
    coverage: { status: reconciled && !confidential && portfolio.reportType !== '13F COMBINATION REPORT' && !data.cache?.stale ? 'ready' : 'partial', recordCount: holdings.length,
      message: `${countText(holdings.length)} assembled positions included. ${reconciled ? 'Public table and selected-quarter filing history reconciled.' : 'Incomplete reconciliation; portfolio totals and weights withheld.'}${confidential ? ' Confidential holdings omitted.' : ''}${data.cache?.stale ? ' Source check is due.' : ''}` },
  };
}

/** Reuse prepared SEC loaders; no curated catalog or browser-page row limits. */
export async function loadFundReport({ kind, id, accession = '', period = '' }, signal, options = {}) {
  signal?.throwIfAborted();
  if (kind === 'nport') {
    if (/^S\d{9}$/.test(String(id).trim().toUpperCase())) {
      const { loadReportSeriesFund } = await import('./reportFundSeriesServer.js');
      return buildNportReport(await loadReportSeriesFund(id, accession, { signal }), options);
    }
    const { loadFund } = await import('./fundResearchServer.js');
    return buildNportReport(await loadFund(id, accession, { signal }), options);
  }
  if (kind === '13f') {
    const { loadThirteenF } = await import('./thirteenFServer.js');
    return buildThirteenFReport(await loadThirteenF(id, { period, signal }), options);
  }
  throw failure('Choose an N-PORT fund or a Form 13F manager.', 'INVALID_REPORT_KIND');
}
