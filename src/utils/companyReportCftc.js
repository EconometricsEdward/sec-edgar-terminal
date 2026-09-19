import { CFTC_FAMILIES, CFTC_LAUNCH_CATALOG, CFTC_SCHEMA_VERSION, cftcDate, parseCftcNumber } from './cftc.js';
import { companyCftcEvidence, matchesCompanyCftcHistory } from './companyCftcEvidence.js';
import { cftcPositionChange } from './cftcContextAnalytics.js';

const MAX_MARKETS = 4;
const BUDGET_MS = 22000;
const DAY = 86400000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? value : null;
const fraction = value => finite(value) ? value / 100 : null;
const text = (value, max = 1600) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
const column = (key, label, format = 'text', width) => ({ key, label, format, ...(width ? { width } : {}) });
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const nearly = (a, b) => a === b || finite(a) && finite(b) && Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-10;
const unique = values => [...new Set(values.filter(Boolean))];
const SCOPE = 'CFTC figures describe aggregate trader categories in futures-only markets. They do not identify the company’s futures positions, hedge amounts, measured exposures, investment performance, or a share-price forecast.';

async function bounded(task, signal) {
  signal.throwIfAborted();
  let stop;
  const aborted = new Promise((_, reject) => {
    stop = () => reject(signal.reason || new Error('CFTC context timed out.'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(task), aborted]); }
  finally { signal.removeEventListener('abort', stop); }
}

function sourceUrl(value, host, path) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && host.includes(url.hostname) && !url.username && !url.password && !url.port
      && (typeof path === 'string' ? url.pathname === path : path.test(url.pathname)) ? url.href : null;
  } catch { return null; }
}

function evidenceUrl(evidence, cik) {
  const sourceCik = evidence.sourceCik || cik;
  if (!/^\d{10}$/.test(sourceCik) || !/^\d{10}-\d{2}-\d{6}$/.test(evidence.accession || '')) return null;
  return sourceUrl(evidence.url, ['www.sec.gov', 'sec.gov'],
    new RegExp(`^/Archives/edgar/data/${Number(sourceCik)}/${evidence.accession.replaceAll('-', '')}/[^/]+$`));
}

/** Bind normalized numerical rows back to the selected official raw fields.
 * Missing source values remain null; changes use exact seven/28-day dates. */
function validatedHistory(value, link, nowMs) {
  const selection = { family: link.family, contract: link.contract, group: link.group, window: '1y' };
  const config = CFTC_FAMILIES[link.family], group = config.groups.find(item => item.id === link.group);
  if (value?.schema_version !== CFTC_SCHEMA_VERSION || !['ready', 'partial', 'stale'].includes(value.status)
    || !matchesCompanyCftcHistory(value, selection) || value.history.length > 600
    || value.selected.reportDate > new Date(nowMs).toISOString().slice(0, 10)
    || !timestamp(value.retrieved_at) || Date.parse(value.retrieved_at) > nowMs + 60000
    || value.source?.dataset_id !== config.datasetId || value.source?.report_basis !== 'futures_only')
    throw new Error('The CFTC response did not verify the requested market, trader category, dates, and reporting basis.');
  const url = sourceUrl(value.source.url, ['publicreporting.cftc.gov'], `/resource/${config.datasetId}.json`);
  if (!url) throw new Error('The original CFTC dataset source could not be verified.');
  const seen = new Set();
  for (const point of value.history) {
    const raw = point.raw;
    if (seen.has(point.reportDate) || !raw || text(raw.cftc_contract_market_code).toUpperCase() !== link.contract
      || text(raw.cftc_market_code) !== value.selected.venueCode || text(raw.contract_units) !== value.selected.units
      || text(raw.futonly_or_combined) !== 'FutOnly' || cftcDate(raw.report_date_as_yyyy_mm_dd) !== point.reportDate)
      throw new Error('The CFTC history contains a conflicting contract, venue, units, or observation date.');
    seen.add(point.reportDate);
    const long = parseCftcNumber(raw[group.long]).value, short = parseCftcNumber(raw[group.short]).value;
    const openInterest = parseCftcNumber(raw.open_interest_all).value;
    if ([long, short, openInterest].some(item => finite(item) && item < 0)) throw new Error('A CFTC position input is invalid.');
    const net = finite(long) && finite(short) ? long - short : null;
    const netPctOi = finite(net) && openInterest > 0 ? net / openInterest * 100 : null;
    if (![nearly(point.long, long), nearly(point.short, short), nearly(point.openInterest, openInterest),
      nearly(point.net, net), nearly(point.netPctOi, netPctOi)].every(Boolean))
      throw new Error('A CFTC metric does not reconcile to its reported inputs.');
  }
  const current = value.history.find(point => point.reportDate === value.selected.reportDate);
  if (!['long', 'short', 'net', 'netPctOi'].every(key => nearly(current[key], value.selected.selectedGroup[key]))
    || !nearly(current.openInterest, value.selected.openInterest)) throw new Error('The selected CFTC observation conflicts with its history.');
  return { history: value, url, group, current,
    week: cftcPositionChange(value, 1), fourWeeks: cftcPositionChange(value, 4) };
}

function withCoverage(report, message, { partial = false, checkedAt = null, notes = [] } = {}) {
  return { ...report,
    sections: [...report.sections, { id: 'cftc-coverage', title: 'CFTC market context',
      description: SCOPE, columns: [column('status', 'Coverage'), column('detail', 'Context', 'text', 85)],
      rows: [{ status: partial ? 'Unavailable or partial' : 'No supported market match', detail: message }], pdfRowLimit: 1 }],
    notes: [...report.notes, SCOPE, ...notes, ...(checkedAt ? [`SEC market-evidence check: ${checkedAt}.`] : []), message],
    coverage: { ...report.coverage, status: partial ? 'partial' : report.coverage.status,
      message: `${report.coverage.message} CFTC context: ${message}` },
  };
}

/** Optional company-only enrichment. Loader contracts mirror existing services:
 * loadContext({cik, asOf:null}, {signal}) -> company-exposure-map.v1;
 * loadHistory({family, code, group, reportDate:'latest', window:'1y', signal})
 * -> the existing CFTC history response. No ticker is invented for CIK issuers.
 */
export async function enrichCompanyReportCftc(report, { loadContext, loadHistory, signal, now = () => new Date().toISOString() } = {}) {
  if (report?.kind !== 'company') return report;
  signal?.throwIfAborted();
  const nowValue = typeof now === 'function' ? now() : now;
  const nowMs = new Date(nowValue).getTime();
  if (!Number.isFinite(nowMs) || !/^\d{10}$/.test(report.entity?.cik || '') || Number(report.entity.cik) <= 0)
    throw new Error('A verified company report and generation clock are required for CFTC context.');
  const deadline = AbortSignal.timeout(BUDGET_MS);
  const workSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let context, selected;
  try {
    const read = loadContext || (await import('./companyExposureServer.js')).loadCompanyExposures;
    context = await bounded(() => read({ cik: report.entity.cik, asOf: null }, { signal: workSignal }), workSignal);
    if (report.entity.ticker && context?.ticker != null && context.ticker !== report.entity.ticker)
      throw new Error('The SEC market evidence ticker does not match the selected company.');
    const checkedAt = timestamp(context?.checkedAt);
    if (!checkedAt || Date.parse(checkedAt) > nowMs + 60000) throw new Error('The SEC evidence check date could not be verified.');
    selected = companyCftcEvidence(context, { ticker: context.ticker, cik: report.entity.cik, asOf: '', basis: report.period.basis || 'annual' });
    if (selected.rows.some(row => row.evidence.some(item => !evidenceUrl(item, report.entity.cik)
      || item.filed > checkedAt.slice(0, 10)))) throw new Error('The SEC market passage is outside the verified issuer filing source or check date.');
  } catch {
    signal?.throwIfAborted();
    return withCoverage(report, 'Company-specific SEC market evidence could not be verified during this request. The financial report remains available; retry for CFTC context.', { partial: true });
  }

  const candidates = new Map();
  for (const row of selected.rows) {
    if (!row.benchmark || !row.evidence.length) continue;
    const catalog = CFTC_LAUNCH_CATALOG.find(item => item.family === row.family && item.code === row.contract);
    if (!catalog) continue;
    const key = `${row.family}:${row.contract}:${row.group}`;
    const candidate = candidates.get(key) || { ...row, catalog, connections: [] };
    candidate.connections.push(row); candidates.set(key, candidate);
  }
  const checkedAt = timestamp(context.checkedAt);
  const evidenceNotes = [
    `SEC market evidence uses ${selected.evidenceBasis.toLowerCase()}; effective SEC filing-date cutoff ${checkedAt.slice(0, 10)}. The financial baseline ends ${report.period.asOf}.`,
    'CFTC observations are the latest validated market context retrieved for this report, not information verified as publicly available at the financial period end or SEC filing cutoff. Each market retains its own position-report date.',
    'Business connections are candidates supported by selected SEC passages. A named benchmark or proxy does not establish materiality, contract equivalence, hedge effectiveness, or a measured company exposure.',
  ];
  if (!candidates.size) return withCoverage(report,
    'No supported CFTC benchmark was established from the selected SEC passages. This does not establish that the company has no market exposure.',
    { checkedAt, partial: context.status === 'partial', notes: evidenceNotes });

  const links = [...candidates.values()].slice(0, MAX_MARKETS);
  const readHistory = loadHistory || (await import('./cftcServer.js')).loadCftcHistory;
  const outcomes = await Promise.all(links.map(async link => {
    try {
      const history = await bounded(() => readHistory({ family: link.family, code: link.contract, group: link.group,
        reportDate: 'latest', window: '1y', signal: workSignal }), workSignal);
      return { link, ...validatedHistory(history, link, nowMs) };
    } catch { return { link, unavailable: true }; }
  }));
  signal?.throwIfAborted();
  const sources = [...report.sources], positionRows = [], relevanceRows = [], detailRows = [], historyRows = [], charts = [];
  const extraNotes = [...evidenceNotes, `SEC market-evidence check: ${checkedAt}.`, SCOPE,
    'Net contracts equal reported longs less shorts. Net / open interest divides by that date’s positive market open interest. Weekly and four-week changes require matching observations exactly 7 and 28 calendar days earlier; a nearby report is not substituted. Percentage-point changes use each observation’s own open interest.',
    'Contracts across markets are not summed: contract units, trader categories, and economic meanings differ. Missing values remain blank. Historical positioning does not measure returns.'];
  const usedIds = new Set(sources.map(source => source.id));
  let sourceNumber = 0;
  const addSource = source => {
    let id;
    do { id = `CFTC${String(++sourceNumber).padStart(4, '0')}`; } while (usedIds.has(id));
    usedIds.add(id); sources.push({ id, ...source }); return id;
  };
  let partial = context.status === 'partial' || candidates.size > links.length;
  for (const outcome of outcomes) {
    const { link } = outcome, sourceIds = [];
    const proof = new Map();
    for (const row of link.connections) for (const evidence of row.evidence) {
      if (row.benchmarkEvidenceIds.includes(evidence.id) || evidence.disclosureDirection === 'qualifying-or-negative') proof.set(evidence.id, evidence);
    }
    for (const evidence of [...proof.values()].slice(0, 4)) sourceIds.push(addSource({
      label: `SEC business connection · ${link.catalog.label}`, url: evidenceUrl(evidence, report.entity.cik),
      form: evidence.form, periodEnd: evidence.reportDate, filed: evidence.filed, accession: evidence.accession,
      note: `${evidence.disclosureDirection === 'qualifying-or-negative' ? 'Qualification or negative disclosure: ' : ''}${text(evidence.text, 1000)}`,
    }));
    const qualified = link.connections.some(row => row.qualifyingEvidenceIds.length);
    relevanceRows.push({ market: link.catalog.label, connection: unique(link.connections.map(row => row.reason)).join(' '),
      benchmarkFit: link.connections.some(row => row.fit === 'named-reference') ? 'Named benchmark reference' : 'Proxy benchmark',
      evidenceDates: unique([...proof.values()].map(item => item.filed)).sort().join(', '),
      qualification: qualified ? 'The selected evidence also includes a qualifying or negative disclosure; review it before interpreting the connection.' : 'Candidate research connection; company positions and exposure size are not established.', sourceIds });
    if (outcome.unavailable) {
      partial = true;
      positionRows.push({ market: link.catalog.label, traderGroup: CFTC_FAMILIES[link.family].groups.find(item => item.id === link.group).label,
        reportDate: null, net: null, netPctOi: null, oneWeekChange: null, fourWeekChange: null, status: 'CFTC observation unavailable', sourceIds });
      extraNotes.push(`${link.catalog.label}: the requested CFTC observation could not be verified. No position or change is inferred.`);
      continue;
    }
    const { history, current, group, week, fourWeeks } = outcome;
    const sourceId = addSource({ label: `${link.catalog.label} · ${group.label} · futures only`, url: outcome.url,
      periodEnd: current.reportDate, unit: 'contracts', value: number(current.net),
      note: `CFTC ${CFTC_FAMILIES[link.family].label}; retrieved ${timestamp(history.retrieved_at)}. Net = long − short. Code ${link.contract}; ${history.selected.units}.` });
    sourceIds.push(sourceId);
    const sourceAge = Math.floor((Date.parse(new Date(nowMs).toISOString().slice(0, 10)) - Date.parse(current.reportDate)) / DAY);
    const stale = history.status === 'stale' || history.freshness?.source_currency === 'aged' || sourceAge > 14;
    const incomplete = history.status !== 'ready' || stale || !finite(current.net) || !finite(current.netPctOi);
    partial ||= incomplete;
    const status = stale ? 'Retained or aged source' : incomplete ? 'Partial source coverage' : 'Validated market observation';
    const row = { market: link.catalog.label, traderGroup: group.label, reportDate: current.reportDate,
      net: number(current.net), netPctOi: fraction(current.netPctOi),
      oneWeekChange: week.available ? number(week.netChange) : null,
      fourWeekChange: fourWeeks.available ? number(fourWeeks.netChange) : null, status, sourceIds };
    positionRows.push(row);
    detailRows.push({ ...row, family: CFTC_FAMILIES[link.family].label, contractCode: link.contract,
      units: text(history.selected.units, 160), long: number(current.long), short: number(current.short), openInterest: number(current.openInterest),
      oneWeekPriorDate: week.priorDate || null, fourWeekPriorDate: fourWeeks.priorDate || null,
      oneWeekPctPoints: week.available ? number(week.netPctChange) : null,
      fourWeekPctPoints: fourWeeks.available ? number(fourWeeks.netPctChange) : null, retrievedAt: timestamp(history.retrieved_at) });
    const points = [...history.history].sort((a, b) => a.reportDate.localeCompare(b.reportDate));
    for (const point of points) historyRows.push({ market: link.catalog.label, traderGroup: group.label,
      reportDate: point.reportDate, long: number(point.long), short: number(point.short), openInterest: number(point.openInterest),
      net: number(point.net), netPctOi: fraction(point.netPctOi), sourceIds: [sourceId] });
    const chartPoints = [];
    for (const [index, point] of points.entries()) {
      const previous = points[index - 1];
      if (previous && Date.parse(point.reportDate) - Date.parse(previous.reportDate) > 7 * DAY)
        chartPoints.push({ label: new Date(Date.parse(previous.reportDate) + 7 * DAY).toISOString().slice(0, 10), value: null });
      chartPoints.push({ label: point.reportDate, value: fraction(point.netPctOi) });
    }
    if (chartPoints.some(point => point.value !== null)) charts.push({ kind: 'line',
      title: `${link.catalog.label} · ${group.label} net / open interest`, unit: 'percent', points: chartPoints });
    extraNotes.push(`${link.catalog.label} · ${group.label}: CFTC position-report date ${current.reportDate}; retrieved ${timestamp(history.retrieved_at)}. ${status}.${history.refresh_warning ? ` ${text(history.refresh_warning)}` : ''}`);
  }
  if (candidates.size > links.length) extraNotes.push(`${candidates.size} distinct supported market links were found; this report includes the first ${links.length} under the bounded market-context coverage. Additional links remain available in company research.`);
  const available = outcomes.filter(outcome => !outcome.unavailable).length;
  const marketMessage = `${available} of ${links.length} selected evidence-linked CFTC markets include verified observations.`;
  const valueColumns = [column('market', 'Market', 'text', 34), column('traderGroup', 'Trader category', 'text', 24),
    column('reportDate', 'Position date', 'date'), column('net', 'Net contracts', 'number'), column('netPctOi', 'Net / open interest', 'percent')];
  const sections = [
    { id: 'cftc-positioning', title: 'CFTC market positioning', description: 'Aggregate futures-only positioning in markets supported by the selected company disclosures.',
      columns: [...valueColumns, column('oneWeekChange', '1-week change (contracts)', 'number'), column('fourWeekChange', '4-week change (contracts)', 'number')],
      rows: positionRows, pdfRowLimit: MAX_MARKETS, footnote: SCOPE },
    { id: 'cftc-company-relevance', title: 'Why these CFTC markets are included', description: 'Disclosure-supported research connections; benchmark proxies remain explicitly qualified.',
      columns: [column('market', 'Market', 'text', 34), column('connection', 'Company connection', 'text', 85), column('benchmarkFit', 'Benchmark fit'),
        column('evidenceDates', 'SEC filing dates'), column('qualification', 'Interpretation', 'text', 75)], rows: relevanceRows, pdfRowLimit: MAX_MARKETS },
    { id: 'cftc-market-detail', title: 'CFTC observation detail', description: 'Position dates and source retrieval times are separate from the company financial period. Percentage-point changes are numeric points, not percent changes.',
      columns: [...valueColumns, column('family', 'CFTC report family'), column('contractCode', 'Contract code'), column('units', 'Contract units'),
        column('long', 'Long contracts', 'number'), column('short', 'Short contracts', 'number'), column('openInterest', 'Open interest (contracts)', 'number'),
        column('oneWeekPriorDate', '1-week comparison date', 'date'), column('oneWeekChange', '1-week net change (contracts)', 'number'),
        column('oneWeekPctPoints', '1-week net/OI change (pp)', 'number'), column('fourWeekPriorDate', '4-week comparison date', 'date'),
        column('fourWeekChange', '4-week net change (contracts)', 'number'), column('fourWeekPctPoints', '4-week net/OI change (pp)', 'number'),
        column('retrievedAt', 'CFTC retrieved at'), column('status', 'Coverage')], rows: detailRows, pdfRowLimit: 0 },
    { id: 'cftc-history', title: 'CFTC positioning history', description: 'Compatible dated observations used for the included positioning charts. No return or company exposure is calculated.',
      columns: [...valueColumns, column('long', 'Long contracts', 'number'), column('short', 'Short contracts', 'number'), column('openInterest', 'Open interest (contracts)', 'number')],
      rows: historyRows, pdfRowLimit: 0 },
  ];
  return { ...report, sections: [...report.sections, ...sections], sources,
    summary: [...report.summary, { label: 'CFTC markets with data', value: available, unit: 'number', detail: `Of ${links.length} selected disclosure-supported market connections; aggregate positioning` }],
    highlights: [...report.highlights, { title: 'CFTC market context', text: `${marketMessage} Financial results retain their original reporting periods; CFTC observations are separately dated market context.` }],
    charts: [...(report.charts || []), ...charts], notes: [...report.notes, ...extraNotes],
    coverage: { ...report.coverage, status: partial ? 'partial' : report.coverage.status, message: `${report.coverage.message} ${marketMessage}` } };
}

/** Exact-CIK disclosure discovery using only an injected SEC HTTP transport.
 * This preview helper neither reads nor writes any production research cache.
 * Cached proxy responses need an original retrieval/check timestamp; they
 * cannot silently acquire the current request's clock.
 */
export function createReportCompanyExposureDiscovery({ fetchSec, now = Date.now } = {}) {
  if (typeof fetchSec !== 'function') throw new Error('Provide a bounded SEC transport for company disclosure discovery.');
  return async (selection, { signal } = {}) => {
    if (!/^\d{10}$/.test(selection?.cik || '') || Number(selection.cik) <= 0 || selection.ticker != null)
      throw new Error('Use an exact verified SEC CIK for disclosure discovery.');
    signal?.throwIfAborted();
    const [{ discoverCompanyExposures }, { extractFilingReaderText, readBoundedFilingResponse }] = await Promise.all([
      import('./companyExposureServer.js'), import('./filingsReader.js'),
    ]);
    const checkTimes = [];
    const clock = () => new Date(typeof now === 'function' ? now() : now).toISOString();
    const sourceClock = response => {
      const fetched = timestamp(response.headers.get('x-data-fetched-at') || response.headers.get('x-source-retrieved-at'));
      const checked = timestamp(response.headers.get('x-data-revalidated-at')) || fetched;
      const retained = Number(response.headers.get('age')) > 0 || /^(?:HIT|STALE)$/i.test(response.headers.get('x-vercel-cache') || '')
        || response.headers.get('x-data-stale') === 'true' || /prepared|warm|cache|supabase/i.test(response.headers.get('x-cache-source') || '');
      if (retained && !checked) throw new Error('The retained SEC source has no verifiable retrieval timestamp.');
      const observed = checked || clock();
      if (Date.parse(observed) > Date.parse(clock()) + 60000) throw new Error('The SEC source clock is in the future.');
      return { retrievedAt: fetched || observed, checkedAt: observed };
    };
    const get = async (url, maxBytes, requestSignal) => {
      const response = await fetchSec(url, { signal: requestSignal, timeoutMs: 16000, retries: 0, maxBytes,
        cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json,text/html,text/plain' } });
      if (!response.ok) throw new Error('The SEC disclosure source is temporarily unavailable.');
      if (/application\/pdf|image\/|application\/(?:zip|octet-stream)/i.test(response.headers.get('content-type') || ''))
        throw new Error('The SEC disclosure source is not readable text.');
      const body = await readBoundedFilingResponse(response, maxBytes);
      requestSignal?.throwIfAborted();
      return { body, ...sourceClock(response) };
    };
    const revisionCache = { document: async () => null, extraction: async () => null,
      saveDocument: async () => {}, saveExtraction: async () => {} };
    const result = await discoverCompanyExposures(selection, { signal, now: new Date(clock()), revisionCache,
      lookupTicker: async () => { throw new Error('Exact-CIK discovery must not resolve a ticker.'); },
      loadSubmissions: async (file, requestSignal) => {
        if (!/^CIK\d{10}(?:-submissions-\d+)?\.json$/.test(file)) throw new Error('Invalid SEC submissions identity.');
        const response = await get(`https://data.sec.gov/submissions/${file}`, 8 * 1024 * 1024, requestSignal);
        checkTimes.push(response.checkedAt); return JSON.parse(response.body);
      },
      loadFilingText: async (cik, filing, { signal: requestSignal } = {}) => {
        const url = evidenceUrl({ ...filing, sourceCik: String(cik).padStart(10, '0') }, selection.cik);
        if (!url) throw new Error('The SEC filing URL does not match the verified document identity.');
        const response = await get(url, 24_000_000, requestSignal);
        return { ...extractFilingReaderText(response.body, filing.primaryDoc), retrievedAt: response.retrievedAt };
      },
    });
    signal?.throwIfAborted();
    if (checkTimes.length) result.checkedAt = checkTimes.sort()[0];
    return result;
  };
}
