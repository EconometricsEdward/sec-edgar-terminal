import { filerCik } from './secFilerSearch.js';
import { matchesCompanyCftcHistory } from './companyCftcEvidence.js';

export const BROKER_DEALER_PEER_CANDIDATES = [
  { cik: '0001690976', name: 'ASL CAPITAL MARKETS INC.' },
  { cik: '0000845194', name: 'BREAN CAPITAL, LLC' },
  { cik: '0001650209', name: 'BETHESDA SECURITIES, LLC' },
];
export const BROKER_PEER_COLUMNS = [
  { id: 'totalAssets', label: 'Assets', kind: 'metric', format: 'currency' },
  { id: 'totalEquity', label: 'Equity', kind: 'metric', format: 'currency' },
  { id: 'netCapital', label: 'Net capital', kind: 'metric', format: 'currency' },
  { id: 'assetsToEquity', label: 'Assets / equity', kind: 'ratio', format: 'multiple' },
  { id: 'netCapitalToRequired', label: 'Net capital / minimum', kind: 'ratio', format: 'multiple' },
];

const finite = value => typeof value === 'number' && Number.isFinite(value);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const REPORT_LABELS = { 'annual-report': 'Annual report', 'periodic-focus': 'Periodic FOCUS', unknown: 'Report type not established' };
const AUDIT_LABELS = { 'auditor-report-present': 'Auditor report identified', 'explicitly-unaudited': 'Explicitly unaudited', 'not-established': 'Audit status not established' };
const COMPONENT_LABELS = { 'financial-condition': 'Financial condition', income: 'Income statement', 'cash-flows': 'Cash flows', 'changes-in-equity': 'Changes in equity', notes: 'Financial statement notes', 'net-capital': 'Net capital', 'reserve-requirements': 'Reserve requirements', 'auditor-report': 'Auditor report', 'operational-schedules': 'Operational schedules' };

/** Document evidence takes precedence over the filing's discovery metadata. */
export function brokerReportIdentity(value) {
  const classification = value?.classification || value?.analysis?.classification || value?.brokerDealerAnalysis?.classification || value?.filing?.classification || {};
  const family = Object.hasOwn(REPORT_LABELS, classification.family) ? classification.family : 'unknown';
  const parts = [...new Set((classification.parts || []).filter(part => ['Part III', 'Part II', 'Part IIA', 'Schedule I'].includes(part)))].sort();
  const auditStatus = Object.hasOwn(AUDIT_LABELS, classification.audit?.status) ? classification.audit.status : 'not-established';
  const frequency = ['annual', 'quarterly', 'monthly', 'other'].includes(classification.period?.frequency) ? classification.period.frequency : 'unknown';
  return { classification, family, label: REPORT_LABELS[family], parts, auditStatus, auditLabel: AUDIT_LABELS[auditStatus],
    auditScope: classification.audit?.scope === 'financial-condition' ? 'Financial condition only' : classification.audit?.scope === 'financial-statements' ? 'Financial statements' : null,
    frequency, periodStart: classification.period?.start || null, periodEnd: classification.period?.end || null,
    components: (classification.components || []).filter(component => Object.hasOwn(COMPONENT_LABELS, component)).map(component => ({ id: component, label: COMPONENT_LABELS[component] })) };
}

/** Unknown reports remain readable individually, never an implied comparison cohort. */
export function brokerComparisonFit(baseline, candidate) {
  const base = brokerReportIdentity(baseline), peer = brokerReportIdentity(candidate);
  if (base.family === 'unknown' || peer.family === 'unknown') return { compatible: false, label: 'Report type not established' };
  if (base.family !== peer.family) return { compatible: false, label: 'Different report types' };
  if (base.frequency !== 'unknown' && peer.frequency !== 'unknown' && base.frequency !== peer.frequency) return { compatible: false, label: 'Different reporting frequency' };
  if ([base.periodStart, base.periodEnd, peer.periodStart, peer.periodEnd].every(validDate)) {
    const baseDays = (Date.parse(base.periodEnd) - Date.parse(base.periodStart)) / 86400000;
    const peerDays = (Date.parse(peer.periodEnd) - Date.parse(peer.periodStart)) / 86400000;
    if (baseDays < 0 || peerDays < 0 || Math.abs(baseDays - peerDays) > 7) return { compatible: false, label: 'Different reporting durations' };
  }
  if (base.family === 'periodic-focus') {
    if (!base.parts.length || !peer.parts.length || base.parts.join('|') !== peer.parts.join('|')) return { compatible: false, label: 'Different or unconfirmed FOCUS parts' };
    if (['unknown', 'other'].includes(base.frequency) || base.frequency !== peer.frequency) return { compatible: false, label: 'Different or unconfirmed reporting frequency' };
  }
  return { compatible: true, label: 'Compatible report type' };
}

/** A Part II, Part IIA and Schedule I on one date are distinct observations. */
export function brokerReportPeriodKey(value) {
  const identity = brokerReportIdentity(value), filing = value?.filing || value || {};
  const accession = filing.accession || filing.accessionNumber || value?.accession || '';
  const end = identity.periodEnd || filing.reportDate || value?.periodEnd;
  if (identity.family === 'unknown' || !end || identity.family === 'periodic-focus' && (!identity.parts.length || !identity.periodStart || ['unknown', 'other'].includes(identity.frequency))) return `accession:${accession}`;
  return [identity.family, identity.parts.join('+'), identity.frequency, identity.periodStart || '', end].join(':');
}

/** Bind every displayed amount to the exact SEC legal entity and accession. */
export function brokerSourceUrl(source, cik, accession = '') {
  if (!filerCik(cik) || !source?.url) return null;
  try {
    const url = new URL(source.url);
    const path = url.pathname.match(/^\/Archives\/edgar\/data\/(\d{1,10})\/(\d{18})\/[^/]+$/);
    if (url.protocol !== 'https:' || !['www.sec.gov', 'sec.gov', 'archives.sec.gov'].includes(url.hostname)
      || url.username || url.password || url.port || !path || filerCik(path[1]) !== filerCik(cik)
      || accession && path[2] !== accession.replaceAll('-', '')) return null;
    if (Number.isInteger(source.page) && source.page > 0) url.hash = `page=${source.page}`;
    return url.href;
  } catch { return null; }
}

export function validateBrokerPeer(value, requestedCik) {
  const cik = filerCik(requestedCik);
  const analysis = value?.analysis;
  if (!cik || value?.status !== 'available' || filerCik(value.company?.cik) !== cik || filerCik(analysis?.cik) !== cik
    || !['ready', 'partial'].includes(analysis?.status)
    || typeof value.company?.name !== 'string' || !value.company.name.trim()
    || !/^\d{10}-\d{2}-\d{6}$/.test(value.filing?.accession || '')
    || analysis.accession !== value.filing.accession
    || !validDate(analysis.periodEnd) || !Array.isArray(analysis.metrics) || !Array.isArray(analysis.ratios)) {
    throw new Error('The report does not match this broker-dealer. Choose an exact SEC registrant with public X-17A-5 statements.');
  }
  return value;
}

export function brokerPeerRow(research, expectedCik) {
  const analysis = research?.analysis || research || {};
  const cik = filerCik(expectedCik), returnedCik = filerCik(analysis.cik || research?.company?.cik);
  if (!cik || returnedCik !== cik) return null;
  const accession = analysis.accession || research?.filing?.accession || '';
  const periodEnd = analysis.periodEnd || research?.filing?.reportDate;
  const name = analysis.name || research?.company?.name || `CIK ${cik}`;
  if (!validDate(periodEnd) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) return null;
  const measures = {};
  for (const column of BROKER_PEER_COLUMNS) {
    const amount = (column.kind === 'ratio' ? analysis.ratios : analysis.metrics)?.find(item => item.id === column.id);
    const sources = amount?.sources?.length ? amount.sources : amount?.source ? [amount.source] : [];
    if (!finite(amount?.value) || amount.periodEnd !== periodEnd || !sources.length
      || !sources.every(source => brokerSourceUrl(source, cik, accession))
      || column.kind === 'metric' && amount.unit !== 'USD') continue;
    measures[column.id] = { ...amount, sourceUrl: brokerSourceUrl(sources[0], cik, accession) };
  }
  return { cik, name, periodEnd, accession, status: analysis.status, measures, classification: brokerReportIdentity(research).classification, url: `/analysis/${cik}?accession=${accession}` };
}

export function compareBrokerPeriods(baseline, peer) {
  if (!validDate(baseline) || !validDate(peer)) return { aligned: false, days: null, label: 'Period unavailable' };
  const days = Math.round(Math.abs(Date.parse(baseline) - Date.parse(peer)) / 86400000);
  return { aligned: days === 0, days, label: days === 0 ? 'Same reporting date' : `${days} days ${peer < baseline ? 'earlier' : 'later'}` };
}

/** Separate each group's gaps and reject a returned market/period mismatch. */
export function brokerCftcSeries(histories, { contract, window = '1y' }) {
  const rows = new Map();
  const groups = {};
  for (const [group, history] of Object.entries(histories || {})) {
    if (!['dealer', 'leveraged-funds'].includes(group)
      || !matchesCompanyCftcHistory(history, { family: 'tff', contract, group, window })) {
      throw new Error('The CFTC series does not match the selected contract, trader category and history window.');
    }
    groups[group] = history;
    for (const point of history.history) {
      const row = rows.get(point.reportDate) || { date: point.reportDate, dealer: null, 'leveraged-funds': null };
      row[group] = finite(point.netPctOi) ? point.netPctOi : null;
      rows.set(point.reportDate, row);
    }
  }
  const observations = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  const chartRows = [];
  for (const row of observations) {
    const time = Date.parse(`${row.date}T00:00:00Z`), previous = chartRows.at(-1);
    if (previous && time - previous.time > 7 * 86400000) {
      chartRows.push({ time: previous.time + 7 * 86400000, date: '', dealer: null, 'leveraged-funds': null, gap: true });
    }
    chartRows.push({ ...row, time });
  }
  return { rows: observations, chartRows, groups };
}

/** Reuse verified extracts within a session; never retain retryable responses. */
export function createBrokerPeerClient({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  const cache = new Map();
  return async (input, { signal } = {}) => {
    const cik = filerCik(input);
    if (!cik) throw new Error('Enter a valid SEC CIK.');
    signal?.throwIfAborted();
    const cached = cache.get(cik);
    if (cached?.expiresAt > now()) return cached.data;
    const response = await fetchImpl(`/api/broker-dealer/report?cik=${cik}`, { signal, headers: { Accept: 'application/json' } });
    const body = await response.json();
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(body.reason || body.error || 'This broker-dealer report is temporarily unavailable.');
    const data = validateBrokerPeer(body, cik);
    if (!String(response.headers?.get('cache-control') || '').includes('no-store')) {
      while (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(cik, { data, expiresAt: now() + 300_000 });
    }
    return data;
  };
}
export const fetchBrokerPeer = createBrokerPeerClient();
