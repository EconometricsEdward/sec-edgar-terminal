import { summarize13FPortfolio } from './thirteenF.js';

export const THIRTEEN_F_COMPARISON_SCHEMA = 'edgar.13f-comparison.v1';
export const MAX_13F_COMPARISON_MANAGERS = 4;
const MAX_HOLDINGS = 20000;
const KEY = /^[A-Z0-9*@#]{9}\|(?:SECURITY|PUT|CALL)\|(?:SH|PRN)$/;
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const cikOf = value => /^\d{1,10}$/.test(String(value ?? '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const quarter = value => typeof value === 'string' && /^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(value) && Number(value.slice(0, 4)) > 0;
const invalid = message => { throw new Error(`Invalid SEC 13F comparison: ${message}`); };
const sum = values => {
  let total = 0;
  for (const value of values) { if (!known(value) || !known(total + value)) return null; total += value; }
  return total;
};
const pct = (value, denominator) => known(value) && denominator > 0 ? value / denominator * 100 : null;
const text = value => typeof value === 'string' ? value : '';
const numberText = value => value.toLocaleString('en-US', { maximumFractionDigits: 0 });
const percentText = value => `${value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

function sourceProjection(filing) {
  return {
    accession: filing.accession ?? null, form: filing.form ?? null, filingDate: filing.filingDate ?? null,
    indexUrl: filing.indexUrl ?? null, primaryUrl: filing.primaryUrl ?? null,
    tableUrls: [...(filing.tableUrls ?? [])], isAmendment: filing.isAmendment === true,
    amendmentType: filing.amendmentType ?? null, amendmentNumber: filing.amendmentNumber ?? null,
    superseded: filing.superseded === true,
  };
}

function normalizeManager(input, period, now) {
  const slot = input?.data !== undefined || input?.cik !== undefined ? input : { data: input, status: input?.status };
  const data = slot.data;
  const cik = cikOf(slot.cik ?? data?.manager?.cik);
  if (!cik || (data && cikOf(data.manager?.cik) !== cik)) invalid('invalid or mismatched manager identity');
  if (data && data.selectedPeriod !== period && !(data.status === 'unavailable' && data.selectedPeriod == null && !data.portfolio)) invalid('all reports must use the explicitly selected quarter');
  const portfolio = data?.portfolio;
  if (portfolio && (cikOf(portfolio.cik) !== cik || portfolio.period !== period)) invalid('portfolio identity does not match the requested manager and quarter');
  const observedAt = data?.observedAt ?? null;
  if (observedAt !== null && (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > now + 1000)) invalid('invalid or future snapshot timestamp');
  const requestedStatus = slot.status ?? data?.status ?? 'unavailable';
  const loaded = data?.status === 'ready' && ['ready', 'incomplete'].includes(requestedStatus) && !!portfolio;
  const status = ['loading', 'pending'].includes(requestedStatus) ? 'loading' : loaded ? 'ready' : 'unavailable';
  const base = {
    cik, name: text(data?.manager?.name) || text(slot.name) || `CIK ${cik}`, period, status,
    observedAt, complete: false, percentagesAvailable: false, absenceKnown: false,
    publicScopeLimited: false, reportType: portfolio?.reportType ?? null, confidentialOmitted: portfolio?.confidentialOmitted === true,
    totalValueUsd: null, observedValueUsd: null, positionCount: null, observedPositionCount: null,
    top5Pct: null, top10Pct: null, largestWeightPct: null, largestPosition: null,
    ordinarySharePct: null, putSharePct: null, callSharePct: null, principalSharePct: null,
    amendmentCount: Number.isInteger(portfolio?.amendmentCount) && portfolio.amendmentCount >= 0 ? portfolio.amendmentCount : 0,
    filings: [], issues: [], reason: slot.reason || data?.reason || null,
    scopeNote: null, positions: new Map(),
  };
  if (!loaded) return { ...base, reason: base.reason || (status === 'loading' ? 'This manager’s selected quarter is still loading.' : 'A public holdings report is unavailable for this manager and quarter.') };
  if (!Array.isArray(portfolio.holdings) || portfolio.holdings.length > MAX_HOLDINGS || !Array.isArray(portfolio.filings ?? []) || (portfolio.filings?.length ?? 0) > 100) invalid('invalid or excessive holdings or source filings');
  for (const holding of portfolio.holdings) {
    if (!KEY.test(holding?.key ?? '') || [holding.cusip, holding.putCall || 'SECURITY', holding.quantityType].join('|') !== holding.key || base.positions.has(holding.key)) invalid('invalid or duplicate assembled security key');
    base.positions.set(holding.key, {
      key: holding.key, cusip: holding.cusip, issuer: text(holding.issuer), classTitle: text(holding.classTitle),
      putCall: holding.putCall || null, quantityType: holding.quantityType,
      quantity: known(holding.quantity) ? holding.quantity : null, valueUsd: known(holding.valueUsd) ? holding.valueUsd : null,
    });
  }
  const observedValueUsd = sum([...base.positions.values()].map(position => position.valueUsd));
  // A precomputed summary or client-supplied weight never changes the full
  // reconciled denominator. Missing rows/values withhold every percentage.
  const reconciled = known(portfolio.totalValueUsd) && observedValueUsd !== null && Math.abs(observedValueUsd - portfolio.totalValueUsd) <= 0.001;
  const complete = portfolio.complete === true && data.coverage?.selectedPeriodComplete === true && reconciled && portfolio.reportType !== '13F NOTICE';
  const percentagesAvailable = complete && portfolio.totalValueUsd > 0;
  const publicScopeLimited = portfolio.confidentialOmitted === true || portfolio.reportType !== '13F HOLDINGS REPORT' || portfolio.comparable !== true;
  const summary = summarize13FPortfolio({ ...portfolio, complete, holdings: [...base.positions.values()] });
  return {
    ...base, status: complete ? 'ready' : 'incomplete', complete, percentagesAvailable,
    absenceKnown: complete && !publicScopeLimited, publicScopeLimited,
    totalValueUsd: complete ? portfolio.totalValueUsd : null, observedValueUsd,
    positionCount: complete ? base.positions.size : null, observedPositionCount: base.positions.size,
    top5Pct: percentagesAvailable ? summary.top5Pct : null, top10Pct: percentagesAvailable ? summary.top10Pct : null,
    largestWeightPct: percentagesAvailable ? pct(summary.largestPosition?.valueUsd, portfolio.totalValueUsd) : null,
    largestPosition: summary.largestPosition ? { ...summary.largestPosition } : null,
    ordinarySharePct: percentagesAvailable ? pct(summary.ordinaryValueUsd, portfolio.totalValueUsd) : null,
    putSharePct: percentagesAvailable ? pct(summary.putValueUsd, portfolio.totalValueUsd) : null,
    callSharePct: percentagesAvailable ? pct(summary.callValueUsd, portfolio.totalValueUsd) : null,
    principalSharePct: percentagesAvailable ? pct(summary.principalValueUsd, portfolio.totalValueUsd) : null,
    filings: (portfolio.filings ?? []).map(sourceProjection), issues: [...(portfolio.issues ?? [])],
    reason: complete ? null : base.reason || (!reconciled ? 'The observed holdings do not reconcile to a complete reported-value denominator.' : 'The selected quarter’s public filing sequence or holdings table is incomplete.'),
    scopeNote: publicScopeLimited ? 'The comparison covers this manager’s disclosed table only. Confidential treatment or a limited reporting scope may leave other holdings undisclosed.' : null,
  };
}

function cellFor(manager, key) {
  const position = manager.positions.get(key);
  if (position) return {
    cik: manager.cik, status: 'reported', issuer: position.issuer, classTitle: position.classTitle,
    quantity: position.quantity, valueUsd: position.valueUsd,
    sharePct: manager.percentagesAvailable ? pct(position.valueUsd, manager.totalValueUsd) : null,
  };
  return {
    cik: manager.cik, status: manager.absenceKnown ? 'not-reported' : 'unknown', issuer: null, classTitle: null,
    quantity: manager.absenceKnown ? 0 : null, valueUsd: manager.absenceKnown ? 0 : null,
    sharePct: manager.absenceKnown && manager.percentagesAvailable ? 0 : null,
  };
}

function comparePair(left, right) {
  const shared = [];
  const smaller = left.positions.size <= right.positions.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const key of smaller.positions.keys()) if (larger.positions.has(key)) shared.push(key);
  const complete = left.complete && right.complete;
  const percentagesAvailable = left.percentagesAvailable && right.percentagesAvailable;
  const observedSharedCount = left.observedPositionCount !== null && right.observedPositionCount !== null ? shared.length : null;
  const leftCommonValueUsd = observedSharedCount === null ? null : sum(shared.map(key => left.positions.get(key).valueUsd));
  const rightCommonValueUsd = observedSharedCount === null ? null : sum(shared.map(key => right.positions.get(key).valueUsd));
  const unionCount = complete ? left.positions.size + right.positions.size - shared.length : null;
  let overlapPct = null;
  let largestContributor = null;
  if (percentagesAvailable) {
    overlapPct = 0;
    for (const key of shared) {
      const contributionPct = Math.min(pct(left.positions.get(key).valueUsd, left.totalValueUsd), pct(right.positions.get(key).valueUsd, right.totalValueUsd));
      overlapPct += contributionPct;
      if (contributionPct > 0 && (!largestContributor || contributionPct > largestContributor.contributionPct || (contributionPct === largestContributor.contributionPct && key < largestContributor.key))) {
        const position = left.positions.get(key);
        largestContributor = { key, cusip: position.cusip, issuer: position.issuer, classTitle: position.classTitle, putCall: position.putCall, contributionPct };
      }
    }
    overlapPct = Math.min(100, overlapPct); // Rounding at the 100% boundary only.
  }
  return {
    key: [left.cik, right.cik].sort().join(':'), leftCik: left.cik, rightCik: right.cik,
    complete, percentagesAvailable, publicScopeLimited: left.publicScopeLimited || right.publicScopeLimited,
    sharedCount: complete ? shared.length : null, observedSharedCount, unionCount,
    jaccardPct: complete && unionCount > 0 ? shared.length / unionCount * 100 : null,
    overlapPct,
    leftCommonValueUsd: complete ? leftCommonValueUsd : null, rightCommonValueUsd: complete ? rightCommonValueUsd : null,
    observedLeftCommonValueUsd: leftCommonValueUsd, observedRightCommonValueUsd: rightCommonValueUsd,
    leftCommonSharePct: percentagesAvailable ? pct(leftCommonValueUsd, left.totalValueUsd) : null,
    rightCommonSharePct: percentagesAvailable ? pct(rightCommonValueUsd, right.totalValueUsd) : null,
    largestContributor,
    reason: !complete ? 'Both managers need complete, reconciled public tables for this quarter. Observed matches are retained as partial evidence.'
      : !percentagesAvailable ? 'A zero reported-value total has no meaningful weight denominator.' : null,
  };
}

function findingsFor(managers, pairs, sharedHoldings, coverage) {
  const names = new Map(managers.map(manager => [manager.cik, manager.name]));
  const findings = [];
  const weighted = pairs.filter(pair => pair.percentagesAvailable).sort((a, b) => b.overlapPct - a.overlapPct || a.key.localeCompare(b.key));
  if (weighted.length) {
    const pair = weighted[0];
    findings.push({
      id: 'largest-overlap', kind: 'overlap', title: weighted.length > 1 ? coverage.allComplete ? 'The closest disclosed allocations' : 'Closest among complete reports' : 'How much the disclosed allocations overlap',
      text: `${names.get(pair.leftCik)} and ${names.get(pair.rightCik)} share ${numberText(pair.sharedCount)} reported positions. Their weighted overlap is ${percentText(pair.overlapPct)}, calculated from the smaller reported-value share for each matching security.`,
      managerCiks: [pair.leftCik, pair.rightCik], pairKey: pair.key, metric: { name: 'Weighted overlap', value: pair.overlapPct, unit: '%' },
    });
  }
  const concentrated = managers.filter(manager => manager.top10Pct !== null).sort((a, b) => b.top10Pct - a.top10Pct || a.cik.localeCompare(b.cik));
  if (concentrated.length > 1) {
    const high = concentrated[0], low = concentrated.at(-1);
    findings.push({
      id: 'concentration-range', kind: 'concentration', title: high.top10Pct === low.top10Pct ? 'A similar top-ten footprint' : 'Different levels of concentration',
      text: `${high.name} reports ${percentText(high.top10Pct)} of disclosed value in its ten largest positions; ${low.name} reports ${percentText(low.top10Pct)}. These percentages describe the public 13F tables.`,
      managerCiks: [high.cik, low.cik], metric: { name: 'Top-ten share difference', value: high.top10Pct - low.top10Pct, unit: 'percentage points' },
    });
  }
  const shared = sharedHoldings[0];
  if (shared) findings.push({
    id: 'shared-security', kind: 'holding', title: shared.managerCount === managers.length ? 'Reported by every selected manager' : 'A shared position to examine',
    text: `${shared.issuer || shared.cusip}${shared.putCall ? ` (${shared.putCall.toLowerCase()})` : ''} appears in ${shared.managerCount} of the ${managers.length} selected public tables. Compare each manager’s reported-value share in the holdings matrix.`,
    managerCiks: shared.cells.filter(cell => cell.status === 'reported').map(cell => cell.cik), holdingKey: shared.key,
    metric: { name: 'Managers reporting this security', value: shared.managerCount, unit: 'managers' },
  });
  if (coverage.completeManagers < managers.length) findings.push({
    id: 'coverage-gap', kind: 'coverage', title: 'Some comparisons are still incomplete',
    text: `${coverage.completeManagers} of ${managers.length} managers have complete public tables for the selected quarter. Missing or incomplete reports stay visible; they are not treated as zero holdings.`,
    managerCiks: managers.filter(manager => !manager.complete).map(manager => manager.cik),
    metric: { name: 'Complete public tables', value: coverage.completeManagers, unit: 'managers' },
  });
  return findings;
}

/**
 * Compare 2–4 actual manager reports for one explicit report quarter. Each slot
 * is { cik, name?, status?, data?, reason? }; a direct report is also accepted.
 * The model performs no source requests or company-name/ticker inference.
 * Weights always use the complete disclosed table, including option rows and
 * securities that are not shared. Options are separate, never netted/deltaized.
 * @param {Array<any>} slots
 * @param {{ period: string, maxSharedHoldings?: number, now?: number }} options
 */
export function buildThirteenFComparison(slots, { period, maxSharedHoldings = 60, now = Date.now() } = {}) {
  if (!Array.isArray(slots) || slots.length < 2 || slots.length > MAX_13F_COMPARISON_MANAGERS) invalid('select between two and four managers');
  if (!Number.isFinite(now) || !quarter(period) || period > new Date(now).toISOString().slice(0, 10)) invalid('select a valid, non-future report quarter');
  if (!Number.isInteger(maxSharedHoldings) || maxSharedHoldings < 1 || maxSharedHoldings > 200) invalid('invalid shared-holdings display limit');
  const normalized = slots.map(slot => normalizeManager(slot, period, now));
  if (new Set(normalized.map(manager => manager.cik)).size !== normalized.length) invalid('a manager cannot be compared with itself');
  const pairs = [];
  for (let left = 0; left < normalized.length; left++) for (let right = left + 1; right < normalized.length; right++) pairs.push(comparePair(normalized[left], normalized[right]));
  const securities = new Map();
  for (const manager of normalized) for (const position of manager.positions.values()) {
    const entry = securities.get(position.key);
    if (entry) entry.managerCount++;
    else securities.set(position.key, { ...position, managerCount: 1 });
  }
  const allShared = [];
  for (const security of securities.values()) {
    if (security.managerCount < 2) continue;
    const cells = normalized.map(manager => cellFor(manager, security.key));
    const reportedCells = cells.filter(cell => cell.status === 'reported');
    const aggregateReportedValueUsd = sum(reportedCells.map(cell => cell.valueUsd));
    const summedSharePct = reportedCells.every(cell => cell.sharePct !== null) ? reportedCells.reduce((total, cell) => total + cell.sharePct, 0) : null;
    const anchor = normalized.find(manager => manager.complete && manager.positions.has(security.key));
    allShared.push({
      key: security.key, cusip: security.cusip, issuer: security.issuer, classTitle: security.classTitle,
      putCall: security.putCall, quantityType: security.quantityType, managerCount: security.managerCount,
      cells, aggregateReportedValueUsd,
      // Keep an actual complete report's security identity for a later,
      // explicitly requested SEC/CFTC lookup. Never synthesize a portfolio.
      anchorCik: anchor?.cik ?? null, anchorHolding: anchor ? { ...anchor.positions.get(security.key) } : null,
      // Sorting aid only: this adds different managers' allocations and is not
      // a combined-portfolio weight, ownership stake, or economic exposure.
      summedSharePct,
    });
  }
  allShared.sort((a, b) => b.managerCount - a.managerCount || (b.summedSharePct ?? -1) - (a.summedSharePct ?? -1) || (b.aggregateReportedValueUsd ?? -1) - (a.aggregateReportedValueUsd ?? -1) || a.key.localeCompare(b.key));
  for (const pair of pairs) {
    const leftIndex = normalized.findIndex(manager => manager.cik === pair.leftCik);
    const rightIndex = normalized.findIndex(manager => manager.cik === pair.rightCik);
    const forPair = allShared.filter(row => row.cells[leftIndex].status === 'reported' && row.cells[rightIndex].status === 'reported');
    const minimumShare = row => {
      const left = row.cells[leftIndex].sharePct, right = row.cells[rightIndex].sharePct;
      return left !== null && right !== null ? Math.min(left, right) : -1;
    };
    const combinedValue = row => sum([row.cells[leftIndex].valueUsd, row.cells[rightIndex].valueUsd]) ?? -1;
    forPair.sort((a, b) => minimumShare(b) - minimumShare(a) || combinedValue(b) - combinedValue(a) || a.key.localeCompare(b.key));
    // Build from all matches, before the global display limit. A pair must not
    // appear to have no shared securities because other managers dominate it.
    pair.sharedHoldings = forPair.slice(0, 20);
    pair.sharedHoldingsTruncated = forPair.length > 20;
  }
  const sharedHoldings = allShared.slice(0, maxSharedHoldings);
  const managers = normalized.map(({ positions: _positions, ...manager }) => manager);
  const coverage = {
    requestedManagers: managers.length, loadedManagers: managers.filter(manager => ['ready', 'incomplete'].includes(manager.status)).length,
    completeManagers: managers.filter(manager => manager.complete).length,
    incompleteManagers: managers.filter(manager => manager.status === 'incomplete').length,
    loadingManagers: managers.filter(manager => manager.status === 'loading').length,
    unavailableManagers: managers.filter(manager => manager.status === 'unavailable').length,
    weightedPairs: pairs.filter(pair => pair.percentagesAvailable).length, totalPairs: pairs.length,
    publicScopeLimitedManagers: managers.filter(manager => manager.publicScopeLimited).length,
    allComplete: managers.every(manager => manager.complete),
  };
  const observed = managers.map(manager => manager.observedAt).filter(Boolean).sort();
  return {
    schemaVersion: THIRTEEN_F_COMPARISON_SCHEMA, period, managers, pairs, sharedHoldings,
    totalSharedHoldings: allShared.length, sharedHoldingsTruncated: allShared.length > maxSharedHoldings,
    coverage, findings: findingsFor(managers, pairs, sharedHoldings, coverage),
    snapshot: {
      period, earliestObservedAt: observed[0] ?? null, latestObservedAt: observed.at(-1) ?? null,
      observations: managers.map(manager => ({ cik: manager.cik, observedAt: manager.observedAt, amendmentCount: manager.amendmentCount, accessions: manager.filings.map(filing => filing.accession), activeAccessions: manager.filings.filter(filing => !filing.superseded).map(filing => filing.accession) })),
      basis: 'Each manager uses the selected report quarter and the public amendment sequence observed at its displayed check time. Later filings can revise this comparison.',
    },
    notes: [
      'Matches use the same CUSIP, put/call designation, and share or principal units. Distinct securities, share classes, and options stay separate; fund holdings are not expanded into underlying securities.',
      'Weighted overlap adds the smaller disclosed-value percentage for each matching position. Every percentage uses its manager’s complete reconciled public table, including positions that are not shared.',
      'These are reported quarter-end holdings, not current portfolios, total assets, investment performance, or measured economic exposure. Option values represent the reported underlying securities and are not netted against shares.',
      'A shared holding is a research connection. SEC disclosure links and CFTC aggregate positioning provide separate context; neither establishes a manager’s derivatives, hedges, or sensitivity.',
    ],
  };
}
