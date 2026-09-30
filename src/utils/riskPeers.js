import { riskResearchLens } from '../app/risk/riskResearchModel.js';
import { validFinancialPeriodDates } from './financialPeriodDates.js';
import { marketCorporateRiskApplicable } from './marketResearchData.js';

export const RISK_PEER_VERSION = 'risk-peers-v1';
export const RISK_PEER_MINIMUM = 8;
export const RISK_PEER_DOTS = 60;
const DAY = 86400000;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const cikKey = row => String(row?.cik || '').replace(/^0+/, '');
const tickerKey = ticker => String(ticker || '').toUpperCase().replaceAll('.', '-');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const quantile = (values, p) => {
  if (!values.length) return null;
  const position = (values.length - 1) * p, lower = Math.floor(position);
  return values[lower] + (values[Math.ceil(position)] - values[lower]) * (position - lower);
};

export const RISK_PEER_METRICS = [
  { id: 'currentRatio', label: 'Current ratio', format: 'ratio', formula: 'Current assets / current liabilities', corporate: true },
  { id: 'interestCoverage', label: 'Interest coverage', format: 'ratio', formula: 'Operating income / reported interest expense', corporate: true },
  { id: 'debtToAssets', label: 'Reported debt / assets', format: 'pct', formula: 'Selected reported current and noncurrent debt / total assets × 100', corporate: true },
  { id: 'cashToAssets', label: 'Cash / assets', format: 'pct', formula: 'Tagged cash and equivalents / total assets × 100', corporate: true },
  { id: 'equityToAssets', label: 'Book equity / assets', format: 'pct', formula: 'Stockholders’ equity / total assets × 100' },
  { id: 'cashFlowMargin', label: 'Operating cash margin', format: 'pct', formula: 'Operating cash flow / reported revenue × 100', corporate: true, revenue: true },
  { id: 'freeCashFlowMargin', label: 'Cash after PP&E / revenue', format: 'pct', formula: '(Operating cash flow − |reported PP&E purchases|) / reported revenue × 100', corporate: true, revenue: true },
  { id: 'netMargin', label: 'Net margin', format: 'pct', formula: 'Net income / reported revenue × 100', revenue: true },
];

export function parseRiskPeerRequest(url) {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some(key => !['ticker', 'basis', 'group'].includes(key) || params.getAll(key).length !== 1))
    throw Object.assign(new Error('Choose one company, reporting basis and peer group.'), { status: 400 });
  const ticker = (params.get('ticker') || '').trim().toUpperCase();
  const basis = params.get('basis') || 'ttm', group = params.get('group') || 'industry';
  if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker) || !['ttm', 'annual'].includes(basis) || !['industry', 'model'].includes(group))
    throw Object.assign(new Error('Use a valid ticker, annual or ttm basis, and industry or model peers.'), { status: 400 });
  return { ticker, basis, group };
}

function reportUsable(report, basis, generatedDate) {
  return validFinancialPeriodDates(report) && date(report.filed) && report.filed <= generatedDate
    && (/^(?:10-K|20-F|40-F)$/.test(report.form || '') || (basis === 'ttm' && report.form === '10-Q'));
}
function lens(row) { return riskResearchLens({}, { sic: row.sic }); }
/** The existing compact Market view combines revenue tags from annual and TTM
 * into one label. A rental-only or net-revenue label cannot establish the
 * denominator for either individual basis. Retain the observed company value,
 * but require a provable total-revenue scope before building a distribution.
 * REIT/real-estate scope needs basis-specific provenance even for a total label.
 */
export function preparedRevenueCompatibility(subject, peer, basis) {
  if (!['annual', 'ttm'].includes(basis)) return false;
  const safeScope = row => row && !['reit', 'real_estate'].includes(lens(row).id)
    && row.revenueBasis === 'Reported total revenue';
  return Boolean(safeScope(subject) && (peer == null || safeScope(peer)));
}
function sameModel(a, b) {
  const model = lens(a).id;
  if (model !== lens(b).id) return false;
  // Unclassified operating and diversified financial groups are not a peer
  // population by themselves. Keep their SIC divisions and sectors aligned.
  return !['corporate', 'financial'].includes(model) || (a.sic.slice(0, 2) === b.sic.slice(0, 2) && a.sectorId === b.sectorId);
}
function sourceUrl(row, report) {
  return /^\d{10}-\d{2}-\d{6}$/.test(report?.accession || '')
    ? `https://www.sec.gov/Archives/edgar/data/${Number(row.cik)}/${report.accession.replaceAll('-', '')}/` : null;
}
function publicIssuer(row, basis) {
  const report = row.reports[basis];
  return { ticker: row.ticker, cik: row.cik, name: row.name, sic: row.sic, report, sourceUrl: sourceUrl(row, report) };
}
function sampledPeers(peers) {
  if (peers.length <= RISK_PEER_DOTS) return peers;
  // Preserve extremes and deterministic value-spaced observations. Statistics
  // always use the complete cohort, never this display-only sample.
  return Array.from({ length: RISK_PEER_DOTS }, (_, index) => peers[Math.round(index * (peers.length - 1) / (RISK_PEER_DOTS - 1))]);
}

/** Read-only calculation over the existing scalar Market serving projection. */
export function buildRiskPeers(snapshot, { ticker, basis = 'ttm', group: groupMode = 'industry' }, now = Date.now()) {
  if (!['ttm', 'annual'].includes(basis) || !['industry', 'model'].includes(groupMode)) throw new Error('Invalid peer selection.');
  const generatedAt = snapshot.generatedAt, generatedDate = generatedAt.slice(0, 10);
  const ordered = [...snapshot.companies].filter(row => /^\d{1,10}$/.test(cikKey(row)) && /^\d{4}$/.test(row.sic || ''))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  // Resolve the requested share class before the peer population is reduced to
  // one observation per issuer. Every class of the subject CIK is excluded below.
  const target = ordered.find(row => row.ticker.toUpperCase() === String(ticker).toUpperCase())
    || ordered.find(row => tickerKey(row.ticker) === tickerKey(ticker));
  const companies = [], seen = new Set();
  for (const row of ordered) {
    const id = cikKey(row);
    if (seen.has(id)) continue;
    seen.add(id); companies.push(row);
  }
  const exclusions = { subject: target ? 1 : 0, group: 0, report: 0, date: 0 };
  const response = { version: RISK_PEER_VERSION, ticker, basis, groupMode, generatedAt,
    stale: snapshot.cache?.status === 'stale' || now - Date.parse(generatedAt) > 25 * 3600000,
    status: 'uncovered', subject: target ? publicIssuer(target, basis) : null,
    group: { id: '', label: '', method: '', candidates: 0, eligible: 0, dateWindowDays: basis === 'annual' ? 120 : 100, minPeers: RISK_PEER_MINIMUM },
    metrics: [], exclusions,
    limitations: [
      'Latest prepared SEC reports from the Market research universe. This is a coverage sample, not the whole industry or a point-in-time historical peer set.',
      'Peers exclude the subject and duplicate share classes. Each issuer is equally weighted; missing values are excluded separately for each measure.',
      'Industry peers share a three-digit SEC SIC family and business-model lens. Broader model peers are an explicit alternative; size, geography and business mix can differ.',
      'Annual or TTM flows retain their prepared basis. Report ends can differ within the displayed window; reporting cutoffs and fiscal calendars are not identical.',
      'Percentiles describe position by numeric value, not credit quality, default probability or a rating. High and low values can have different meanings across measures.',
      'Company values belong to this prepared peer snapshot and may differ from the latest Risk profile. Latest-report links do not list every contributing TTM filing; Analysis provides the financial inputs.',
      'Reported cash may be restricted; debt concepts and PP&E coverage can vary. Cash after PP&E purchases is not REIT FFO/AFFO or cash after all investment and distributions.',
      'Revenue-normalized distributions are withheld for REIT/real-estate and net-revenue scopes because the compact snapshot does not establish their revenue definition separately for annual and TTM reports.',
      'Financial-company views withhold corporate liquidity, cash-flow and interest-coverage comparisons. Book equity is not regulatory capital; legal-bank peers use a separate matched-bank dataset.',
      `Charts show at most ${RISK_PEER_DOTS} value-spaced peer dots, including extremes. Statistics use all eligible reporting peers.`,
    ] };
  if (!target) return response;
  const targetReport = target.reports[basis], model = lens(target);
  response.group.id = groupMode === 'industry' ? `sic-${target.sic.slice(0, 3)}:${model.id}` : `model-${model.id}`;
  response.group.label = groupMode === 'industry' ? `SIC ${target.sic.slice(0, 3)} · ${model.label}` : model.label;
  response.group.method = groupMode === 'industry' ? 'Same SIC family and business model' : 'Same business model; SIC/sector alignment for diversified groups';
  if (!reportUsable(targetReport, basis, generatedDate) || !sourceUrl(target, targetReport)) return response;
  const peers = companies.filter(row => {
    if (cikKey(row) === cikKey(target)) return false;
    if (!sameModel(target, row) || groupMode === 'industry' && row.sic.slice(0, 3) !== target.sic.slice(0, 3)) { exclusions.group++; return false; }
    response.group.candidates++;
    const report = row.reports[basis];
    if (!reportUsable(report, basis, generatedDate) || !sourceUrl(row, report)) { exclusions.report++; return false; }
    if (Math.abs(Date.parse(report.end) - Date.parse(targetReport.end)) > response.group.dateWindowDays * DAY) { exclusions.date++; return false; }
    return true;
  });
  response.group.eligible = peers.length;
  const definitions = RISK_PEER_METRICS.filter(metric => !metric.corporate || marketCorporateRiskApplicable(target.sic));
  response.metrics = definitions.map(definition => {
    const compatibleRevenue = !definition.revenue || preparedRevenueCompatibility(target, null, basis);
    const value = target.metrics[basis][definition.id], reporting = peers.filter(row => finite(row.metrics[basis][definition.id])
      && (!definition.revenue || preparedRevenueCompatibility(target, row, basis)));
    const ordered = reporting.map(row => ({ ...publicIssuer(row, basis), value: row.metrics[basis][definition.id] }))
      .sort((a, b) => a.value - b.value || a.ticker.localeCompare(b.ticker));
    const values = ordered.map(row => row.value), available = finite(value) && values.length >= RISK_PEER_MINIMUM
      && compatibleRevenue;
    const dots = sampledPeers(ordered);
    return { ...definition, value: finite(value) ? value : null, available, count: values.length, plottedCount: dots.length,
      median: available ? quantile(values, .5) : null, q1: available ? quantile(values, .25) : null, q3: available ? quantile(values, .75) : null,
      min: available ? values[0] : null, max: available ? values.at(-1) : null,
      percentile: available ? 100 * (values.filter(n => n < value).length + .5 * values.filter(n => n === value).length) / values.length : null,
      reason: available ? null : !finite(value) ? 'Company input unavailable' : !compatibleRevenue ? 'Comparable revenue scope unavailable for this reporting basis'
        : `At least ${RISK_PEER_MINIMUM} reporting peers required; ${values.length} available`,
      peers: dots };
  });
  response.status = response.metrics.some(metric => metric.available) ? 'ready' : 'insufficient';
  return response;
}
