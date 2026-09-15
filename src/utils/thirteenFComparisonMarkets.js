import { is13FMarketConnectionResult, thirteenFMarketBenchmark } from './thirteenFMarketConnections.js';

export const COMPARISON_MARKET_LIMIT = 10;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const marketKey = value => `${value.family}:${value.contract}:${value.group}`;

/** A bounded sample of actual common shares, with the original manager report
 * binding intact. A matching CUSIP never licenses ETF look-through or options. */
export function comparisonMarketScope(comparison) {
  const managers = Array.isArray(comparison?.managers) ? comparison.managers : [];
  const eligible = (Array.isArray(comparison?.sharedHoldings) ? comparison.sharedHoldings : []).filter(row => {
    const anchor = row?.anchorHolding;
    return row?.managerCount >= 2 && /^[A-Z0-9*@#]{9}\|SECURITY\|SH$/.test(row?.key || '')
      && anchor?.key === row.key && anchor.cusip === row.cusip && !anchor.putCall && anchor.quantityType === 'SH'
      && /^\d{10}$/.test(row.anchorCik || '') && managers.some(manager => manager.cik === row.anchorCik && manager.complete)
      && !/\b(?:ETF|ETN|ISHARES|SPDR|VANGUARD|INVESCO|PROSHARES|DIREXION|INDEX\s+FUND|UNIT\s+TRUST|MUTUAL\s+FUND)\b/i.test(`${anchor.issuer} ${anchor.classTitle}`);
  }).sort((a, b) => (b.aggregateReportedValueUsd || 0) - (a.aggregateReportedValueUsd || 0) || a.key.localeCompare(b.key));
  const rows = eligible.slice(0, COMPARISON_MARKET_LIMIT);
  const signature = JSON.stringify([comparison?.period, managers.map(manager => [manager.cik, manager.observedAt, manager.totalValueUsd]), rows.map(row => [row.anchorCik, row.anchorHolding])]);
  return { period: comparison?.period || '', rows, eligibleCount: eligible.length, signature };
}

/** Every passage is validated against its original manager/quarter/security.
 * Each unique shared security contributes its already-reconciled value once
 * per manager; no percentages are rescaled to this deliberately bounded scan. */
export function buildComparisonMarkets(comparison, results = [], { now = Date.now() } = {}) {
  const scope = comparisonMarketScope(comparison), byKey = new Map(results.map(result => [result?.holding?.key || result?.key, result]));
  const markets = new Map(), drivers = new Map();
  const coverage = { total: scope.rows.length, attempted: 0, linked: 0, unavailable: 0, unresolved: 0, noMatches: 0, noFiling: 0, partial: 0, disclosureOnly: 0 };
  function add(map, group, row, result, evidence) {
    if (!map.has(group.key)) map.set(group.key, { ...group, members: new Map() });
    const target = map.get(group.key);
    if (!target.members.has(row.key)) target.members.set(row.key, { ...row, issuer: result.identity.issuer, identityEvidence: result.identity.evidence, evidence: [], partial: result.discovery.status === 'partial' || result.discovery.coverage?.searchComplete === false });
    const member = target.members.get(row.key);
    for (const passage of evidence) if (!member.evidence.some(previous => previous.id === passage.id && previous.accession === passage.accession)) member.evidence.push(passage);
  }
  const positions = scope.rows.map(row => {
    const result = byKey.get(row.key), base = { key: row.key, name: row.anchorHolding.issuer, status: 'unchecked', message: 'Waiting to be checked.' };
    if (!result) return base;
    coverage.attempted++;
    if (!is13FMarketConnectionResult(result, { cik: row.anchorCik, period: scope.period, holding: row.anchorHolding, now })) {
      coverage.unavailable++; return { ...base, status: 'unavailable', message: result.message || 'SEC evidence could not be verified for this exact holding.' };
    }
    if (result.status === 'unresolved') { coverage.unresolved++; return { ...base, status: 'unresolved', message: result.identity.reason || 'An operating-company identity was not verified.' }; }
    const discovery = result.discovery;
    if (discovery.status === 'unavailable') { coverage.unavailable++; return { ...base, status: 'unavailable', message: discovery.message || 'SEC filing evidence is temporarily unavailable.' }; }
    if (discovery.status === 'no_filing') { coverage.noFiling++; return { ...base, status: 'no_filing', message: 'No eligible company filing was found.' }; }
    const partial = discovery.status === 'partial' || discovery.coverage?.searchComplete === false;
    if (partial) coverage.partial++;
    let linked = false, disclosureOnly = false;
    for (const channel of discovery.rows) {
      const evidence = channel.evidence.map(passage => ({ ...passage, categoryLabel: channel.categoryLabel, marketId: channel.marketId }));
      const benchmarks = new Map(evidence.filter(passage => passage.disclosureDirection === 'connection' && passage.benchmark).map(passage => [marketKey(passage.benchmark), thirteenFMarketBenchmark(passage.benchmark)]));
      for (const [key, benchmark] of benchmarks) {
        add(markets, { ...benchmark, key, categoryLabel: channel.categoryLabel }, row, result, evidence.filter(passage => passage.disclosureDirection === 'qualifying-or-negative' || passage.benchmark && marketKey(passage.benchmark) === key));
        linked = true;
      }
      if (!benchmarks.size) { add(drivers, { key: `driver:${channel.marketId}`, label: channel.marketLabel, categoryLabel: channel.categoryLabel, reason: channel.benchmarkUnavailableReason || 'The passage does not establish a supported futures benchmark.' }, row, result, evidence); disclosureOnly = true; }
    }
    if (linked) coverage.linked++; else if (disclosureOnly) coverage.disclosureOnly++; else coverage.noMatches++;
    return { ...base, status: partial ? 'partial' : linked ? 'linked' : disclosureOnly ? 'disclosure_only' : 'no_matches', message: partial ? 'Some company filings could not be reviewed.' : linked ? 'SEC passages support the market connection.' : disclosureOnly ? 'Business driver disclosed; no supported CFTC chart.' : 'No qualifying passage found in the bounded filing scan.' };
  });
  function finish(map) {
    return [...map.values()].map(group => {
      const members = [...group.members.values()].map(member => ({ ...member, evidence: member.evidence.sort((a, b) => b.filed.localeCompare(a.filed) || a.id.localeCompare(b.id)) }));
      const managers = comparison.managers.map(manager => {
        const cells = members.map(member => member.cells.find(cell => cell.cik === manager.cik));
        const reported = cells.filter(cell => cell?.status === 'reported');
        const knownCells = cells.every(cell => cell && cell.status !== 'unknown' && finite(cell.valueUsd));
        const valueUsd = knownCells ? cells.reduce((sum, cell) => sum + cell.valueUsd, 0) : null;
        const sharePct = manager.percentagesAvailable === true && finite(valueUsd) && manager.totalValueUsd > 0 ? valueUsd / manager.totalValueUsd * 100 : null;
        return { cik: manager.cik, name: manager.name, count: reported.length, unknown: !knownCells, valueUsd, sharePct };
      });
      return { ...group, members, count: members.length, managers };
    }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }
  return { scope, coverage, positions, markets: finish(markets), drivers: finish(drivers) };
}
