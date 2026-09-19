import {
  analysisBaseline,
  analysisChange,
  unpackAnalysisCompany,
} from './analysisResearch.js';
import { comparePairQuality, comparePointQuality } from './compareQuality.js';
import { evidenceSources } from './researchEvidence.js';

const REPORT_SCHEMA = 'edgar.report.v1';
const BASES = new Set(['annual', 'quarter', 'ttm']);
const normalizedCik = value => /^\d{1,10}$/.test(String(value || '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const CATEGORIES = [
  ['income', 'Income Statement', 'Revenue and earnings for the selected reporting duration.'],
  ['balance', 'Balance Sheet', 'Reported balances at each period end.'],
  ['cashflow', 'Cash Flow', 'Operating, investing and financing cash flows for the selected duration.'],
  ['ratios', 'Ratios', 'Profitability, liquidity and capital ratios use compatible reported inputs; unavailable inputs remain blank.'],
];
const HEADLINES = {
  corporate: ['revenue', 'netIncome', 'operatingCashFlow', 'freeCashFlow', 'totalAssets', 'equityAssets'],
  banking: ['bankRevenue', 'netIncome', 'deposits', 'loans', 'roe', 'equityAssets'],
  insurance: ['premiumsEarned', 'investmentIncome', 'netIncome', 'totalAssets', 'roe', 'equityAssets'],
};
const formatMap = { currency: 'usd', percent: 'percent', decimal: 'ratio', eps: 'number', shares: 'number', days: 'number', number: 'number' };
const cleanText = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const sourceTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
}
function secUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['sec.gov', 'www.sec.gov'].includes(url.hostname)
      && !url.username && !url.password && !url.port && url.pathname.startsWith('/Archives/edgar/data/')
      ? url.href : null;
  } catch { return null; }
}
function normalizedSource(source) {
  const url = secUrl(source?.documentUrl), end = date(source?.end), filed = date(source?.filed);
  if (!url || !end || !filed || !/^\d{10}-\d{2}-\d{6}$/.test(source?.accession || '')
    || !url.includes(`/${source.accession.replaceAll('-', '')}/`)
    || !source?.taxonomy || !source?.tag || !source?.unit || number(source?.value) === null
    || source.start != null && (!date(source.start) || source.start > end)) return null;
  return {
    label: `${cleanText(source.taxonomy, 40)}:${cleanText(source.tag, 240)}`,
    url, form: cleanText(source.form, 20), periodEnd: end, filed, accession: source.accession,
    concept: `${cleanText(source.taxonomy, 40)}:${cleanText(source.tag, 240)}`,
    unit: cleanText(source.unit, 40), value: source.value,
    ...(source.start ? { start: source.start } : {}),
    ...((source.scopeNote || source.revised) ? { note: [cleanText(source.scopeNote, 700), source.revised ? 'Different filed values exist for this context; review the source revisions.' : ''].filter(Boolean).join(' ') } : {}),
  };
}
const labelFor = definition => `${cleanText(definition.label, 160)}${definition.format === 'eps' ? ' (USD/share)' : definition.format === 'shares' ? ' (shares)' : definition.format === 'days' ? ' (days)' : ''}`;
const convertValue = (value, definition) => number(value) === null ? null : definition.format === 'percent' ? value / 100 : value;
function display(value, format) {
  if (number(value) === null) return 'Unavailable';
  if (format === 'percent') return new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(value);
  if (format === 'ratio') return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}×`;
  return new Intl.NumberFormat('en-US', { ...(format === 'usd' ? { style: 'currency', currency: 'USD' } : {}), notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

/** A finished report projection of the same SEC mapping used by Analysis.
 * It neither fetches data nor replaces missing observations with estimates. */
export function buildCompanyReport(analysis, { generatedAt = new Date().toISOString(), sourceSnapshot = null } = {}) {
  if (!analysis || !Array.isArray(analysis.periods) || !Array.isArray(analysis.definitions)
    || !analysis.metrics || !BASES.has(analysis.basis)
    || !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(analysis.ticker || '')
    || !/^\d{1,10}$/.test(String(analysis.cik || '')) || Number(analysis.cik) <= 0
    || !Number.isFinite(Date.parse(generatedAt))) throw Object.assign(new Error('A verified company financial model is required to build this report.'), { status: 422 });
  const generated = new Date(generatedAt).toISOString();
  const sourceRetrievedAt = sourceTime(sourceSnapshot?.metadata?.fetchedAt);
  const sourceCheckedAt = sourceTime(sourceSnapshot?.metadata?.revalidatedAt) || sourceRetrievedAt;
  const sourceExpiresAt = sourceTime(sourceSnapshot?.metadata?.expiresAt);
  const sourceStale = sourceSnapshot?.stale === true || Boolean(sourceExpiresAt && sourceExpiresAt <= generated);
  const data = unpackAnalysisCompany(analysis), basis = data.basis;
  const selectedPeriods = data.periods.map((period, index) => ({ period, index }))
    .filter(({ period }) => period?.kind === basis && date(period.end)
      && (!period.start || date(period.start) && period.start <= period.end))
    .sort((a, b) => b.period.end.localeCompare(a.period.end))
    .filter(({ period }, index, all) => all.findIndex(entry => entry.period.end === period.end) === index)
    .slice(0, basis === 'annual' ? 5 : 8);
  if (!selectedPeriods.length) throw Object.assign(new Error('No supported reporting periods are available for this company and basis.'), { status: 422 });
  const definitions = data.definitions.filter(definition => CATEGORIES.some(([category]) => category === definition.category))
    .filter((definition, index, all) => definition && typeof definition.key === 'string'
      && all.findIndex(item => item?.key === definition.key) === index);
  const sources = [], sourceIndex = new Map(), observations = [], normalized = new Map();
  function sourceIds(inputs) {
    return inputs.map(input => {
      const fingerprint = JSON.stringify(input);
      if (!sourceIndex.has(fingerprint)) {
        const id = `S${String(sources.length + 1).padStart(4, '0')}`;
        sourceIndex.set(fingerprint, id); sources.push({ id, ...input });
      }
      return sourceIndex.get(fingerprint);
    });
  }
  for (const definition of definitions) {
    const points = selectedPeriods.map(({ period, index }) => {
      const point = data.metrics[definition.key]?.[index];
      const inputs = evidenceSources(point), mappedSources = inputs.map(normalizedSource);
      let reason = cleanText(point?.reason || point?.note, 800), value = convertValue(point?.value, definition);
      if (value !== null) {
        if (!['reported', 'calculated'].includes(point.classification) || !inputs.length || inputs.length > 128 || mappedSources.some(input => !input)) {
          value = null; reason = 'The reported source provenance could not be verified for this observation.';
        } else if (['currency', 'percent', 'decimal'].includes(definition.format)) {
          const quality = comparePointQuality(point, definition.key, period);
          if (!quality.valid) { value = null; reason = cleanText(quality.reason, 800); }
        } else if (inputs.some(input => input.end > period.end || input.start == null && input.end !== period.end)) {
          value = null; reason = 'A source observation does not match the selected reporting period.';
        }
      }
      const ids = value === null ? [] : sourceIds(mappedSources);
      const classification = value === null ? 'unavailable' : point.classification;
      const formula = cleanText(point?.formula || definition.formula, 1400);
      const unit = formatMap[definition.format] || 'number';
      const result = { value, sourceIds: ids, classification, reason: value === null ? reason || 'A compatible reported input is unavailable.' : reason || null, formula, unit, period };
      observations.push({ metric: labelFor(definition), key: definition.key, period: period.end, start: period.start || null,
        basis, value, unit, classification, formula, sourceRefs: ids.join(', '), sourceIds: ids,
        reason: result.reason || '', calculationSteps: (point?.calculations || []).map(step => cleanText(step.formula, 1400)).filter(Boolean).join('; ') });
      return result;
    });
    normalized.set(definition.key, points);
  }
  const latest = selectedPeriods[0].period;
  const lens = ['banking', 'insurance'].includes(data.lens) ? data.lens : 'corporate';
  const summary = HEADLINES[lens].map(key => {
    const definition = definitions.find(item => item.key === key), point = normalized.get(key)?.[0];
    if (!definition) return null;
    return { label: labelFor(definition), value: point.value, unit: point.unit,
      detail: point.value === null ? point.reason : `${latest.start && point.sourceIds.some(id => sources.find(source => source.id === id)?.start) ? `${latest.start} to ` : ''}${latest.end}${point.classification === 'calculated' ? ' · calculated' : ''}`,
      sourceIds: point.sourceIds };
  }).filter(Boolean);
  const periodColumns = selectedPeriods.map(({ period }, index) => ({ key: `p${index}`, label: period.end, format: 'number', formatKey: 'unit' }));
  const sections = CATEGORIES.map(([category, title, description]) => ({
    id: category, title, description,
    columns: [{ key: 'metric', label: 'Metric', format: 'text', width: 2.3 }, ...periodColumns],
    rows: definitions.filter(definition => definition.category === category
      && normalized.get(definition.key).some(point => point.value !== null)).map(definition => {
      const points = normalized.get(definition.key);
      return { metric: labelFor(definition), unit: formatMap[definition.format] || 'number', key: definition.key,
        ...Object.fromEntries(points.map((point, index) => [`p${index}`, point.value])),
        sourceIds: [...new Set(points.flatMap(point => point.sourceIds))],
        sourcesByPeriod: points.map(point => ({ period: point.period.end, sourceIds: point.sourceIds })) };
    }),
    footnote: category === 'ratios' ? 'Percentages are shown as percent; coverage and liquidity multiples use ×. Interim ROA and ROE use the annualization stated in their source formulas.'
      : category === 'cashflow' ? 'Free cash flow is operating cash flow less reported PP&E purchases; it is not cash available after every investing or financing obligation.'
        : 'USD; EPS and share counts are labeled separately. Missing figures are unavailable, not zero.',
  })).filter(section => section.rows.length);
  sections.push({ id: 'observations', title: 'Metric methodology and source references',
    description: 'Supporting observation detail retained for calculations and validation.',
    columns: [
      { key: 'metric', label: 'Metric', format: 'text' }, { key: 'period', label: 'Period end', format: 'date' },
      { key: 'start', label: 'Period start', format: 'date' }, { key: 'basis', label: 'Basis', format: 'text' },
      { key: 'value', label: 'Value', format: 'number', formatKey: 'unit' }, { key: 'unit', label: 'Unit', format: 'text' },
      { key: 'classification', label: 'Status', format: 'text' }, { key: 'formula', label: 'Formula', format: 'text' },
      { key: 'calculationSteps', label: 'Intermediate calculations', format: 'text' },
      { key: 'sourceRefs', label: 'Source IDs', format: 'text' }, { key: 'reason', label: 'Coverage note', format: 'text' },
    ], rows: observations, pdfRowLimit: 0 });
  const highlights = [];
  const revenueKey = lens === 'banking' ? 'bankRevenue' : lens === 'insurance' ? 'premiumsEarned' : 'revenue';
  const currentRevenue = normalized.get(revenueKey)?.[0], revenueDefinition = definitions.find(item => item.key === revenueKey);
  if (currentRevenue?.value !== null && currentRevenue) {
    const currentIndex = selectedPeriods[0].index;
    const beforeIndex = analysisBaseline(data.periods, currentIndex, 'year');
    const before = data.metrics[revenueKey]?.[beforeIndex], current = data.metrics[revenueKey]?.[currentIndex];
    if (before && comparePairQuality(current, before, revenueKey).valid && evidenceSources(before).every(source => normalizedSource(source))) {
      const change = analysisChange(current, before, 'currency');
      if (change.percent !== null) highlights.push({ title: `${labelFor(revenueDefinition)} compared with a year earlier`,
        text: `${labelFor(revenueDefinition)} ${change.percent < 0 ? 'decreased' : change.percent > 0 ? 'increased' : 'was unchanged'}${change.percent ? ` ${display(Math.abs(change.percent) / 100, 'percent')}` : ''} versus the comparable period ending ${before.period.end}, to ${display(currentRevenue.value, 'usd')}.` });
    }
  }
  const cash = normalized.get('operatingCashFlow')?.[0], net = normalized.get('netIncome')?.[0];
  if (cash?.value !== null && cash && net?.value !== null && net) highlights.push({ title: 'Earnings and operating cash flow',
    text: `Reported net income was ${display(net.value, 'usd')} and operating cash flow was ${display(cash.value, 'usd')} for the period ending ${latest.end}. Collection and payment timing can affect the difference.` });
  const equity = normalized.get('equityAssets')?.[0], coverage = normalized.get('operatingInterestCoverage')?.[0];
  if (equity?.value !== null && equity) highlights.push({ title: 'Capital supporting reported assets',
    text: `Book equity represented ${display(equity.value, 'percent')} of total assets at ${latest.end}. This accounting measure does not establish regulatory capital adequacy or market value.` });
  if (lens === 'corporate' && coverage?.value !== null && coverage) highlights.push({ title: 'Operating earnings and interest expense',
    text: `Operating income was ${display(coverage.value, 'ratio')} reported interest expense. This uses reported operating income and is not EBITDA coverage.` });
  const latestObservations = observations.filter(observation => observation.period === latest.end);
  const available = latestObservations.filter(observation => observation.value !== null).length;
  if (!observations.some(observation => observation.value !== null))
    throw Object.assign(new Error('No supported SEC financial values could be verified for this company and reporting basis. Try another basis or inspect the original company filings.'), { status: 422 });
  const sourceDates = sources.filter(source => source.periodEnd <= latest.end).map(source => source.filed).sort();
  const notes = [
    'This report is a normalized SEC financial extract, not a complete reproduction of the filed statements. USD monetary observations are used; other currencies are not silently converted.',
    'The latest filed values available to the financial model are used. Comparative filings can revise earlier values. Financial period end, filing date and report generation time are different dates.',
    ...(sourceRetrievedAt ? [`Financial inputs retrieved: ${sourceRetrievedAt} (oldest canonical source).`] : []),
    ...(sourceCheckedAt ? [`Financial inputs last checked: ${sourceCheckedAt} (oldest canonical source check). Generating this report does not perform a new SEC source check.`] : []),
    ...(sourceStale ? ['The source check is due. This report uses a retained financial model that may not include a newer filing or amendment. Report generation time is not a new source check.'] : []),
    'Unavailable values are not zero. Custom issuer tags, nonpublic data and incompatible reporting contexts can leave gaps. Metrics with no verified values in the included history are omitted from the financial tables.',
    basis === 'annual' ? 'History includes up to five annual periods. Balance-sheet values are period-end amounts; earnings and cash flows cover the stated annual duration.'
      : basis === 'ttm' ? 'History includes up to eight trailing-twelve-month periods. Flow calculations require four compatible standalone quarters; balance-sheet values remain period-end amounts.'
        : 'History includes up to eight standalone quarters. A quarter can be derived from compatible cumulative reported amounts.',
    lens === 'banking' ? 'Bank revenue is net of interest expense. Deposits, lending and regulatory capital needs make industrial-company liquidity and free-cash-flow comparisons less useful.'
      : lens === 'insurance' ? 'Premiums and investment income are shown separately. Insurance reserves and investment portfolios require review of the original disclosures.'
        : 'Debt uses the mapped reported combined amount or compatible current and noncurrent components. Interest coverage does not measure every fixed charge or refinancing obligation.',
    'The Excel workbook organizes financial statements, ratios and trends. Original filing links are listed in this PDF’s source register.',
  ];
  if (data.lensNote) notes.push(cleanText(data.lensNote, 1000));
  if (data.sourceCoverage?.filingFallback?.status === 'unavailable' || data.sourceCoverage?.continuity?.status === 'partial')
    notes.push('Some supplemental filing or historical continuity inputs were unavailable when the financial model was retrieved. Retry later or inspect the source filing for missing items.');
  return {
    schema: REPORT_SCHEMA, kind: 'company', generatedAt: generated,
    entity: { id: data.ticker, ...(/^\d+$/.test(data.ticker) ? {} : { ticker: data.ticker }), name: cleanText(data.name, 240) || data.ticker, cik: String(data.cik).padStart(10, '0') },
    title: `${cleanText(data.name, 240) || data.ticker} — Company report`,
    subtitle: `SEC financial analysis · ${basis === 'annual' ? 'Annual' : basis === 'ttm' ? 'Trailing twelve months' : 'Standalone quarter'} · ${/^\d+$/.test(data.ticker) ? `CIK ${String(data.cik).padStart(10, '0')}` : data.ticker}`,
    period: { label: `${basis === 'annual' ? 'Annual period' : basis === 'ttm' ? 'Trailing twelve months' : 'Standalone quarter'} ending ${latest.end}`,
      asOf: latest.end, filingDate: sourceDates.at(-1) || null, basis },
    summary, highlights, sections,
    charts: [revenueKey, 'netIncome', 'operatingCashFlow'].filter(key => normalized.get(key)?.some(point => point.value !== null)).map(key => ({
      kind: 'line', title: labelFor(definitions.find(definition => definition.key === key)), unit: 'usd',
      points: [...normalized.get(key)].reverse().map(point => ({ label: point.period.end, value: point.value })),
    })),
    sources, notes,
    coverage: { status: sourceStale || available < latestObservations.length ? 'partial' : 'ready',
      message: `${available} of ${latestObservations.length} financial metrics have verified values for ${latest.end}. ${selectedPeriods.length} reporting periods are included.${sourceStale ? ' Source check is due; the retained model may not include a newer filing or amendment.' : ''}`,
      recordCount: observations.length, availableMetrics: available, totalMetrics: latestObservations.length },
  };
}

/** Untickered SEC registrants use the exact CIK selected in search. Both
 * canonical source identities must match before the ordinary Analysis mapping
 * or its optional original-filing enrichment can run. */
export function createReportCikCompanyLoader({ loadJson, enrich } = {}) {
  return async function loadByCik(id, { basis = 'annual', asOf = '', signal } = {}) {
    const cik = normalizedCik(id);
    if (!cik || !BASES.has(basis)) throw Object.assign(new Error('Select a valid SEC company CIK and reporting basis.'), { status: 400 });
    signal?.throwIfAborted();
    const { secResearchJson, submissionRows } = await import('./secResearchData.js');
    const load = loadJson || secResearchJson;
    const [submissions, facts] = await Promise.all([
      load(`/submissions/CIK${cik}.json`, signal),
      load(`/api/xbrl/companyfacts/CIK${cik}.json`, signal),
    ]);
    signal?.throwIfAborted();
    if (normalizedCik(submissions?.cik) !== cik || normalizedCik(facts?.cik) !== cik
      || typeof submissions?.name !== 'string' || !submissions.name.trim()
      || !Array.isArray(submissions.filings?.recent?.accessionNumber)
      || !facts?.facts || typeof facts.facts !== 'object' || Array.isArray(facts.facts))
      throw Object.assign(new Error('SEC source documents did not verify the selected company CIK.'), { status: 502 });
    const company = { ticker: id, cik, companyName: submissions.name, sic: submissions.sic,
      facts: facts.facts, filings: submissionRows(submissions.filings.recent, cik), historyLimited: false };
    const enrichSources = enrich || (await import('./analysisResearchSources.js')).enrichAnalysisCompanySources;
    const enriched = await enrichSources(company, { basis, asOf }, { signal });
    signal?.throwIfAborted();
    if (normalizedCik(enriched?.cik) !== cik || enriched?.ticker !== id)
      throw Object.assign(new Error('The financial source response did not match the selected company CIK.'), { status: 502 });
    return enriched;
  };
}
let cikAnalysisLoader;
async function loadCikAnalysis(selection, signal) {
  cikAnalysisLoader ||= import('./analysisResearchServer.js').then(({ createInteractiveAnalysisLoader }) =>
    createInteractiveAnalysisLoader({ load: createReportCikCompanyLoader() }));
  return (await cikAnalysisLoader)(selection, signal);
}

/** Prepared company models are shared with Analysis; other tickers use its
 * bounded on-demand loader, without enrolling them in the prepared universe. */
export function createCompanyReportLoader({ readPrepared, loadInteractive, loadCik = loadCikAnalysis, now = () => new Date().toISOString() } = {}) {
  return async function load(selection, signal) {
    const ticker = typeof selection?.ticker === 'string' ? selection.ticker.trim().toUpperCase() : '';
    const basis = selection?.basis || 'annual';
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker) || /^\d+$/.test(ticker) && !normalizedCik(ticker) || !BASES.has(basis))
      throw Object.assign(new Error('Select a company ticker or CIK and annual, quarter or TTM reporting basis.'), { status: 400 });
    signal?.throwIfAborted();
    let result;
    if (!/^\d+$/.test(ticker)) {
      const read = readPrepared || (await import('./preparedFinancialData.js')).readPreparedAnalysis;
      try { result = await read({ ticker, basis, asOf: '' }); }
      catch (error) { if (error.name !== 'PreparedSecUnavailableError') throw error; }
    }
    signal?.throwIfAborted();
    if (!result) {
      const interactive = /^\d+$/.test(ticker) ? loadCik
        : loadInteractive || (await import('./analysisResearchServer.js')).loadInteractiveAnalysis;
      result = await interactive({ ticker, basis, asOf: '' }, signal);
    }
    signal?.throwIfAborted();
    if (result?.payload?.ticker !== ticker || result?.payload?.basis !== basis
      || /^\d+$/.test(ticker) && normalizedCik(result?.payload?.cik) !== normalizedCik(ticker))
      throw Object.assign(new Error('The financial response did not match the selected company and reporting basis.'), { status: 502 });
    return buildCompanyReport(result.payload, { generatedAt: now(), sourceSnapshot: result });
  };
}
export const loadCompanyReport = createCompanyReportLoader();
