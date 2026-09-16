import { calendarPeriods13F, get13FHoldingHistory, MAX_13F_HISTORY_QUARTERS } from './thirteenFHistory.js';

const QUARTER_METRICS = ['top5Pct', 'top10Pct', 'positionCount', 'totalValueUsd'];
const HOLDING_METRICS = ['quantity', 'valueUsd', 'weightPct'];
const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const managerCik = (value) => /^\d{1,10}$/.test(String(value ?? '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const emptyDeltas = (metrics) => Object.fromEntries(metrics.map((metric) => [metric, { change: null, changePct: null }]));

function quartersOf(history) {
  if (!Array.isArray(history?.quarters) || history.quarters.length > MAX_13F_HISTORY_QUARTERS) throw new Error('Invalid SEC 13F history insights: invalid quarter history');
  const seen = new Set();
  for (const quarter of history.quarters) {
    calendarPeriods13F(quarter?.period, 1);
    if (seen.has(quarter.period)) throw new Error('Invalid SEC 13F history insights: duplicate report quarter');
    seen.add(quarter.period);
  }
  return history.quarters;
}

function metricDelta(current, baseline) {
  if (!known(current) || !known(baseline)) return { change: null, changePct: null };
  const change = current - baseline;
  const relative = baseline > 0 ? change / baseline * 100 : null;
  return { change, changePct: Number.isFinite(relative) ? relative : null };
}

/**
 * Compare the selected quarter only with its immediately preceding calendar
 * quarter. Missing, partial, or different reporting scopes never become a
 * comparison against the next available observation. Percentage metric changes
 * are percentage points; changePct is the relative change, not a return.
 */
export function get13FQuarterComparison(history, period) {
  const quarters = quartersOf(history);
  const baselinePeriod = calendarPeriods13F(period, 2)[0];
  const current = quarters.find((quarter) => quarter.period === period) ?? null;
  const baseline = quarters.find((quarter) => quarter.period === baselinePeriod) ?? null;
  const result = { status: 'unavailable', available: false, period, baselinePeriod, current, baseline, reason: null, deltas: emptyDeltas(QUARTER_METRICS) };
  if (!current) result.reason = 'The selected quarter is outside the loaded history.';
  else if (!baseline) result.reason = 'The immediately preceding quarter is outside the loaded history.';
  else if (current.status !== 'ready' || baseline.status !== 'ready' || current.complete !== true || baseline.complete !== true) result.reason = 'Complete public snapshots are needed for this quarter and the immediately preceding quarter.';
  else if (!managerCik(history.cik) || managerCik(current.cik) !== managerCik(history.cik) || managerCik(baseline.cik) !== managerCik(history.cik)) result.reason = 'The snapshots do not have the same verified manager identity.';
  else if (current.confidentialOmitted || baseline.confidentialOmitted) result.reason = 'Confidential holdings were omitted, so these quarters cannot be compared reliably.';
  else if (current.comparable !== true || baseline.comparable !== true || current.reportType !== '13F HOLDINGS REPORT' || baseline.reportType !== '13F HOLDINGS REPORT') result.reason = 'The reporting scope prevents a complete comparison between these quarters.';
  if (result.reason) return result;
  return { ...result, status: 'available', available: true, deltas: Object.fromEntries(QUARTER_METRICS.map((metric) => [metric, metricDelta(current[metric], baseline[metric])])) };
}

/** Selected-position changes preserve security identity and explicit absence. */
export function get13FHoldingQuarterComparison(history, key, period) {
  const comparison = get13FQuarterComparison(history, period);
  const observations = get13FHoldingHistory(history, key).observations;
  const current = observations.find((observation) => observation.period === period) ?? null;
  const baseline = observations.find((observation) => observation.period === comparison.baselinePeriod) ?? null;
  const result = { ...comparison, current, baseline, changeStatus: 'unavailable', deltas: emptyDeltas(HOLDING_METRICS) };
  if (!comparison.available) return result;
  if (!current || !baseline || current.status === 'unknown' || baseline.status === 'unknown') return { ...result, status: 'unavailable', available: false, reason: 'A verified observation of this security is needed in both adjacent quarters.' };
  // Derive classification from this exact pair rather than the order of the
  // input array. A genuine zero quantity is still a reported position.
  const quantity = metricDelta(current.quantity, baseline.quantity);
  const changeStatus = current.status === 'not-reported' && baseline.status === 'not-reported' ? 'not-reported'
    : baseline.status === 'not-reported' ? 'newly-reported'
      : current.status === 'not-reported' ? 'no-longer-reported'
        : quantity.change === null ? 'unavailable' : quantity.change > 0 ? 'increased' : quantity.change < 0 ? 'decreased' : 'unchanged';
  return { ...result, changeStatus, deltas: Object.fromEntries(HOLDING_METRICS.map((metric) => [metric, metricDelta(current[metric], baseline[metric])])) };
}

function secUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && ['sec.gov', 'www.sec.gov', 'data.sec.gov'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  // Quoting alone does not stop a spreadsheet from executing imported formulas.
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * One row per loaded calendar quarter, including gaps. Full USD values and
 * percentage levels are exported without display rounding. Incomplete report
 * totals stay blank; observed rows and source coverage remain explicit.
 */
export function create13FHistoryCsv(history) {
  const quarters = [...quartersOf(history)].sort((left, right) => left.period.localeCompare(right.period));
  if (quarters.some((quarter) => ['ready', 'incomplete'].includes(quarter.status) && (!managerCik(history.cik) || managerCik(quarter.cik) !== managerCik(history.cik)))) throw new Error('Invalid SEC 13F history insights: snapshots belong to another manager');
  const headings = [
    'manager_cik', 'quarter_end', 'snapshot_status', 'complete_public_snapshot', 'comparable_public_scope', 'report_type', 'confidential_holdings_omitted',
    'checked_at', 'observed_at', 'stale',
    'reported_positions', 'observed_positions', 'total_reported_value_usd', 'top_5_share_pct', 'top_10_share_pct', 'largest_position_share_pct', 'amendment_count',
    'comparison_baseline_quarter', 'comparison_status', 'position_count_change', 'total_reported_value_change_usd', 'top_5_share_change_percentage_points', 'top_10_share_change_percentage_points',
    'source_accessions', 'source_filing_dates', 'source_urls', 'coverage_note', 'comparison_note',
  ];
  const rows = quarters.map((quarter) => {
    const comparison = get13FQuarterComparison(history, quarter.period);
    const filings = Array.isArray(quarter.filings) ? quarter.filings : [];
    const sourceUrls = [...new Set(filings.flatMap((filing) => [filing.filingUrl, filing.indexUrl, filing.primaryUrl, filing.url, ...(Array.isArray(filing.tableUrls) ? filing.tableUrls : [])]).map(secUrl).filter(Boolean))];
    const complete = quarter.status === 'ready' && quarter.complete === true;
    const value = (metric) => complete && known(quarter[metric]) ? quarter[metric] : null;
    return [
      managerCik(history.cik), quarter.period, quarter.status, complete, complete && quarter.comparable === true && !quarter.confidentialOmitted && quarter.reportType === '13F HOLDINGS REPORT', quarter.reportType, quarter.confidentialOmitted === true,
      quarter.checkedAt, quarter.observedAt, typeof quarter.stale === 'boolean' ? quarter.stale : null,
      value('positionCount'), known(quarter.observedPositionCount) ? quarter.observedPositionCount : null, value('totalValueUsd'), value('top5Pct'), value('top10Pct'), value('largestWeightPct'), known(quarter.amendmentCount) ? quarter.amendmentCount : null,
      comparison.baselinePeriod, comparison.status, comparison.deltas.positionCount.change, comparison.deltas.totalValueUsd.change, comparison.deltas.top5Pct.change, comparison.deltas.top10Pct.change,
      filings.map((filing) => filing.accessionNumber || filing.accession).filter(Boolean).join(' | '), filings.map((filing) => filing.filingDate).filter(Boolean).join(' | '), sourceUrls.join(' | '), quarter.reason || (quarter.issues || []).join(' | '), comparison.reason,
    ];
  });
  return [headings, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
