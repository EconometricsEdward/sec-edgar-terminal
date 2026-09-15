import { compare13FPortfolios, summarize13FPortfolio } from './thirteenF.js';

// Browser history contains quarter summaries and explicitly requested positions,
// never a dense matrix of every security a large manager has ever reported.
export const MAX_13F_HISTORY_QUARTERS = 12;
export const MAX_13F_HISTORY_KEYS = 32;
const QUARTER_ENDS = ['03-31', '06-30', '09-30', '12-31'];
const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const invalid = (message) => { throw new Error(`Invalid SEC 13F history: ${message}`); };
const managerCik = (value) => /^\d{1,10}$/.test(String(value ?? '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const holdingKey = (value) => typeof value === 'string' && /^[A-Z0-9*@#]{9}\|(?:SECURITY|PUT|CALL)\|(?:SH|PRN)$/.test(value);

function quarterIndex(period) {
  if (typeof period !== 'string' || !/^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(period) || Number(period.slice(0, 4)) < 1) return null;
  return Number(period.slice(0, 4)) * 4 + QUARTER_ENDS.indexOf(period.slice(5));
}

function periodAt(index) {
  return `${String(Math.floor(index / 4)).padStart(4, '0')}-${QUARTER_ENDS[index % 4]}`;
}

export function calendarPeriods13F(endPeriod, count = 8) {
  const end = quarterIndex(endPeriod);
  if (end === null || !Number.isInteger(count) || count < 1 || count > MAX_13F_HISTORY_QUARTERS || end - count + 1 < 4) invalid('invalid calendar window');
  return Array.from({ length: count }, (_, index) => periodAt(end - count + index + 1));
}

function selectedKeys(keys) {
  if (!Array.isArray(keys) || keys.length > MAX_13F_HISTORY_KEYS || keys.some((key) => !holdingKey(key))) invalid('invalid or excessive tracked position keys');
  return [...new Set(keys)];
}

function positionProjection(holding, totalValueUsd) {
  const valueUsd = known(holding.valueUsd) ? holding.valueUsd : null;
  return {
    key: holding.key, cusip: holding.cusip, issuer: holding.issuer, classTitle: holding.classTitle,
    putCall: holding.putCall ?? null, quantityType: holding.quantityType,
    quantity: known(holding.quantity) ? holding.quantity : null, valueUsd,
    weightPct: totalValueUsd > 0 && valueUsd !== null ? valueUsd / totalValueUsd * 100 : null,
  };
}

/** Project an assembled, reconciled quarter without changing its reporting scope. */
export function project13FHistoryQuarter(portfolio, keys = []) {
  const cik = managerCik(portfolio?.cik);
  if (!cik || quarterIndex(portfolio?.period) === null || !Array.isArray(portfolio?.holdings) || portfolio.holdings.length > 100000) invalid('invalid portfolio identity or holdings');
  const trackedKeys = selectedKeys(keys);
  const selected = new Set(trackedKeys);
  const seen = new Set();
  const positions = Object.fromEntries(trackedKeys.map((key) => [key, null]));
  const summary = summarize13FPortfolio(portfolio);
  const complete = portfolio.complete === true;
  const totalValueUsd = complete && known(summary.totalValueUsd) ? summary.totalValueUsd : null;
  for (const holding of portfolio.holdings) {
    if (!holdingKey(holding?.key) || seen.has(holding.key)) invalid('invalid or duplicate assembled position key');
    seen.add(holding.key);
    if (selected.has(holding.key)) positions[holding.key] = positionProjection(holding, totalValueUsd);
  }
  const comparable = complete && portfolio.comparable === true && portfolio.confidentialOmitted !== true && portfolio.reportType === '13F HOLDINGS REPORT';
  return {
    cik, period: portfolio.period, complete, comparable,
    confidentialOmitted: portfolio.confidentialOmitted === true, reportType: portfolio.reportType,
    totalValueUsd, positionCount: complete ? summary.positionCount : null,
    observedPositionCount: summary.positionCount, entryCount: portfolio.entryCount ?? null,
    top5Pct: complete && known(summary.top5Pct) ? summary.top5Pct : null,
    top10Pct: complete && known(summary.top10Pct) ? summary.top10Pct : null,
    largestWeightPct: totalValueUsd > 0 && known(summary.largestPosition?.valueUsd) ? summary.largestPosition.valueUsd / totalValueUsd * 100 : null,
    amendmentCount: portfolio.amendmentCount ?? 0,
    filings: (portfolio.filings ?? []).map((filing) => ({ ...filing, tableUrls: [...(filing.tableUrls ?? [])] })),
    issues: [...(portfolio.issues ?? [])], trackedKeys, positions,
  };
}

function emptyQuarter(period, slot) {
  const loading = slot?.status === 'loading' || slot?.status === 'pending';
  return {
    period, status: loading ? 'loading' : 'unavailable', complete: false, comparable: false,
    confidentialOmitted: false, reportType: null, totalValueUsd: null, positionCount: null,
    observedPositionCount: null, entryCount: null, top5Pct: null, top10Pct: null, largestWeightPct: null,
    amendmentCount: 0, filings: [], issues: [], trackedKeys: [], positions: {},
    reason: slot?.reason || (loading ? 'This quarter is still loading.' : 'A public holdings report is unavailable for this quarter.'),
  };
}

/**
 * Normalize chronological calendar slots. Missing quarters stay explicit gaps.
 * A complete combination/confidential report still supports public value and
 * concentration summaries, but cannot establish absence or quantity changes.
 * @param {Array<any>} slots
 * @param {{ cik?: string, maxQuarters?: number }} [options]
 */
export function summarize13FHistory(slots, { cik: expectedCik, maxQuarters = MAX_13F_HISTORY_QUARTERS } = {}) {
  if (!Array.isArray(slots) || slots.length > 40 || !Number.isInteger(maxQuarters) || maxQuarters < 1 || maxQuarters > MAX_13F_HISTORY_QUARTERS) invalid('invalid or excessive quarter slots');
  let cik = expectedCik === undefined ? null : managerCik(expectedCik);
  if (expectedCik !== undefined && !cik) invalid('invalid manager CIK');
  const byPeriod = new Map();
  for (const slot of slots) {
    if (quarterIndex(slot?.period) === null || byPeriod.has(slot.period)) invalid('invalid or duplicate report quarter');
    if (slot.projection) {
      const projectionCik = managerCik(slot.projection.cik);
      if (!projectionCik || (cik && cik !== projectionCik) || slot.projection.period !== slot.period) invalid('projection belongs to another manager or quarter');
      cik ??= projectionCik;
      const keys = selectedKeys(slot.projection.trackedKeys);
      for (const key of keys) {
        if (!Object.hasOwn(slot.projection.positions ?? {}, key)) invalid('tracked position observation is missing');
        const position = slot.projection.positions[key];
        if (position !== null && (typeof position !== 'object' || position.key !== key)) invalid('tracked position identity does not match');
      }
    }
    byPeriod.set(slot.period, slot);
  }
  const inputPeriods = [...byPeriod.keys()].sort();
  const end = inputPeriods.at(-1);
  const firstIndex = inputPeriods.length ? quarterIndex(inputPeriods[0]) : null;
  const lastIndex = end ? quarterIndex(end) : null;
  const periods = end ? calendarPeriods13F(end, Math.min(maxQuarters, lastIndex - firstIndex + 1)) : [];
  const quarters = periods.map((period) => {
    const slot = byPeriod.get(period);
    const projection = slot?.projection;
    // A stale projection on a failed or unfinished request cannot count as a
    // successfully observed quarter.
    if (!projection || (slot.status !== 'ready' && slot.status !== 'incomplete')) return emptyQuarter(period, slot);
    const complete = projection.complete === true;
    const comparable = complete && projection.comparable === true && projection.confidentialOmitted !== true && projection.reportType === '13F HOLDINGS REPORT';
    return {
      ...projection, cik, complete, comparable, status: complete ? 'ready' : 'incomplete',
      totalValueUsd: complete && known(projection.totalValueUsd) ? projection.totalValueUsd : null,
      positionCount: complete && known(projection.positionCount) ? projection.positionCount : null,
      top5Pct: complete && known(projection.top5Pct) ? projection.top5Pct : null,
      top10Pct: complete && known(projection.top10Pct) ? projection.top10Pct : null,
      largestWeightPct: complete && known(projection.largestWeightPct) ? projection.largestWeightPct : null,
      reason: complete ? null : slot.reason || 'This quarter’s public holdings have not fully reconciled.',
    };
  });
  const completeQuarters = quarters.filter((quarter) => quarter.complete).length;
  const comparableQuarters = quarters.filter((quarter) => quarter.comparable).length;
  return {
    cik, quarters,
    coverage: {
      requestedQuarters: periods.length, loadedQuarters: quarters.filter((quarter) => ['ready', 'incomplete'].includes(quarter.status)).length,
      completeQuarters, comparableQuarters,
      unavailableQuarters: quarters.filter((quarter) => quarter.status === 'unavailable').length,
      incompleteQuarters: quarters.filter((quarter) => quarter.status === 'incomplete').length,
      loadingQuarters: quarters.filter((quarter) => quarter.status === 'loading').length,
      firstPeriod: periods[0] ?? null, lastPeriod: periods.at(-1) ?? null,
      historyTruncated: periods.length > 0 && firstIndex < quarterIndex(periods[0]),
    },
    notes: [
      'Values and concentration describe disclosed quarter-end 13F positions, not total assets, investment returns, or a current portfolio.',
      'Position history is limited to the loaded calendar window. Missing quarters remain gaps; amendments are included in each quarter’s current public filing sequence.',
    ],
  };
}

function observationFor(quarter, key) {
  const tracked = quarter.trackedKeys.includes(key);
  const position = tracked ? quarter.positions[key] : null;
  const base = { period: quarter.period, complete: quarter.complete, comparable: quarter.comparable, changeStatus: 'unavailable', quantityChange: null, quantityChangePct: null };
  if (position) return { ...base, status: 'reported', quantity: known(position.quantity) ? position.quantity : null, valueUsd: known(position.valueUsd) ? position.valueUsd : null, weightPct: quarter.complete && known(position.weightPct) ? position.weightPct : null, reason: quarter.complete ? null : quarter.reason };
  if (tracked && quarter.complete && quarter.comparable) return { ...base, status: 'not-reported', quantity: 0, valueUsd: 0, weightPct: quarter.totalValueUsd > 0 ? 0 : null, reason: 'This security was not in the complete public holdings table for this quarter.' };
  const reason = quarter.reason || (!tracked ? 'This position was not requested for this quarter.' : quarter.confidentialOmitted ? 'Confidential holdings were omitted, so absence cannot be established.' : !quarter.comparable ? 'The reporting scope cannot establish whether this position was absent.' : 'The position observation is unavailable.');
  return { ...base, status: 'unknown', quantity: null, valueUsd: null, weightPct: null, reason };
}

function comparisonPortfolio(quarter, key) {
  const position = quarter.positions[key];
  return { ...quarter, holdings: position ? [position] : [] };
}

/** Select one position. Actual absence is distinct from an unrequested row. */
export function get13FHoldingHistory(history, key) {
  if (!holdingKey(key) || !Array.isArray(history?.quarters) || history.quarters.length > MAX_13F_HISTORY_QUARTERS) invalid('invalid position history request');
  const quarters = history.quarters;
  const observations = quarters.map((quarter) => observationFor(quarter, key));
  const quantityChanges = { increased: 0, decreased: 0, unchanged: 0, newlyReported: 0, noLongerReported: 0, comparablePairs: 0, increaseStreak: 0, decreaseStreak: 0 };
  for (let index = 1; index < quarters.length; index += 1) {
    const previous = quarters[index - 1];
    const current = quarters[index];
    if (!previous.trackedKeys.includes(key) || !current.trackedKeys.includes(key)) continue;
    const comparison = compare13FPortfolios(comparisonPortfolio(previous, key), comparisonPortfolio(current, key));
    if (!comparison.available) continue;
    const change = comparison.changes.find((item) => item.key === key);
    const observation = observations[index];
    if (!change) { observation.changeStatus = 'not-reported'; continue; }
    if (change.status === 'unavailable') continue;
    observation.changeStatus = change.status;
    observation.quantityChange = change.quantityChange;
    observation.quantityChangePct = change.quantityChangePct;
    quantityChanges.comparablePairs += 1;
    const countKey = { 'newly-reported': 'newlyReported', 'no-longer-reported': 'noLongerReported' }[change.status] ?? change.status;
    quantityChanges[countKey] += 1;
  }
  const reported = observations.filter((observation) => observation.status === 'reported');
  let consecutiveObservedQuarters = 0;
  for (let index = observations.length - 1; index >= 0 && observations[index].status === 'reported'; index -= 1) consecutiveObservedQuarters += 1;
  for (let index = observations.length - 1; index >= 1 && observations[index].changeStatus === 'increased'; index -= 1) quantityChanges.increaseStreak += 1;
  for (let index = observations.length - 1; index >= 1 && observations[index].changeStatus === 'decreased'; index -= 1) quantityChanges.decreaseStreak += 1;
  const latestPosition = [...quarters].reverse().find((quarter) => quarter.trackedKeys.includes(key) && quarter.positions[key])?.positions[key];
  const identity = latestPosition ? { key, cusip: latestPosition.cusip, issuer: latestPosition.issuer, classTitle: latestPosition.classTitle, putCall: latestPosition.putCall, quantityType: latestPosition.quantityType } : null;
  return {
    key, identity, observations,
    persistence: {
      firstObservedPeriod: reported[0]?.period ?? null, lastObservedPeriod: reported.at(-1)?.period ?? null,
      observedQuarters: reported.length, consecutiveObservedQuarters,
      observedAtWindowStart: observations[0]?.status === 'reported',
    },
    quantityChanges,
    notes: [
      'First observed and consecutive observations describe this loaded window; they do not establish when the manager first acquired a position.',
      'Quantity changes use only adjacent, comparable public reports. Corporate actions, reporting scope, and confidential treatment can affect quantities; changes do not establish purchases or sales.',
    ],
  };
}
