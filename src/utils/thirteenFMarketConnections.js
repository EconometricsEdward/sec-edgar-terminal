import { CFTC_LAUNCH_CATALOG } from './cftc.js';

export const THIRTEEN_F_MARKET_SCHEMA = 'edgar.13f-market-connections.v1';
export const THIRTEEN_F_MARKET_CATEGORIES = Object.freeze({ rates: 'Interest rates', currencies: 'Currencies', energy: 'Energy', metals: 'Metals', agriculture: 'Agriculture', other: 'Other markets' });
const KEY = /^[A-Z0-9*@#]{9}\|(SECURITY|PUT|CALL)\|(SH|PRN)$/;
const CIK = /^\d{10}$/;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const unique = values => [...new Set(values)];
const sameHolding = (a, b) => ['key', 'cusip', 'issuer', 'classTitle', 'putCall', 'quantity', 'quantityType', 'valueUsd'].every(key => (a?.[key] ?? null) === (b?.[key] ?? null));
const marketKey = benchmark => `${benchmark.family}:${benchmark.contract}:${benchmark.group}`;

export function thirteenFMarketHoldings(data) {
  const seen = new Set();
  return (Array.isArray(data?.portfolio?.holdings) ? data.portfolio.holdings : []).filter(holding => {
    if (!holding || !KEY.test(holding.key) || [holding.cusip, holding.putCall || 'SECURITY', holding.quantityType].join('|') !== holding.key || seen.has(holding.key)) return false;
    seen.add(holding.key); return true;
  }).sort((a, b) => (finite(b.valueUsd) ? b.valueUsd : -1) - (finite(a.valueUsd) ? a.valueUsd : -1) || String(a.issuer).localeCompare(String(b.issuer)) || a.key.localeCompare(b.key));
}

function documentMatches(url, cik, accession) {
  if (typeof url !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(accession || '')) return false;
  const prefix = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/`;
  return url.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(url.slice(prefix.length));
}
export function thirteenFMarketBenchmark(value) {
  if (!value || !['named-reference', 'proxy'].includes(value.fit)) return null;
  const match = CFTC_LAUNCH_CATALOG.find(item => item.family === value.family && item.code === value.contract && item.label === value.label);
  if (!match || value.group !== (match.family === 'tff' ? 'leveraged-funds' : 'managed-money') || typeof value.basisLimit !== 'string' || value.basisLimit.length > 1200) return null;
  return { family: match.family, contract: match.code, label: match.label, group: value.group, fit: value.fit, basisLimit: value.basisLimit };
}

/** Validate the actual security, issuer, and each passage's original document.
 * Row-level benchmark labels cannot confer a link on an unrelated passage. */
export function is13FMarketConnectionResult(value, { cik, period, holding, now = Date.now() }) {
  if (value?.schemaVersion !== THIRTEEN_F_MARKET_SCHEMA || value.manager?.cik !== cik || value.selectedPeriod !== period || !sameHolding(value.holding, holding)
    || !['ready', 'unresolved', 'unavailable'].includes(value.status) || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > now + 1000) return false;
  const identity = value.identity;
  if (!identity || identity.cusip !== holding.cusip || !['resolved', 'unresolved'].includes(identity.status)) return false;
  if (value.status === 'unresolved') return identity.status === 'unresolved' && value.discovery === null;
  if (identity.status !== 'resolved' || !CIK.test(identity.issuer?.cik || '') || Number(identity.issuer.cik) <= 0
    || !Array.isArray(identity.evidence) || !identity.evidence.length || identity.evidence.length > 4
    || identity.evidence.some(source => source.cik !== identity.issuer.cik || !source.cusips?.includes(holding.cusip))) return false;
  const discovery = value.discovery;
  if (!discovery || discovery.schemaVersion !== 'edgar.company-exposure-map.v1' || discovery.cik !== identity.issuer.cik
    || !['ready', 'partial', 'no_matches', 'no_filing', 'unavailable'].includes(discovery.status)
    || !Number.isFinite(Date.parse(discovery.checkedAt)) || Date.parse(discovery.checkedAt) > now + 1000
    || !Array.isArray(discovery.sources) || discovery.sources.length > 2 || !Array.isArray(discovery.rows) || discovery.rows.length > 50) return false;
  if ((value.status === 'unavailable') !== (discovery.status === 'unavailable')) return false;
  if (['no_matches', 'no_filing', 'unavailable'].includes(discovery.status) && discovery.rows.length) return false;
  return discovery.rows.every(row => typeof row.id === 'string' && row.id.length <= 120 && typeof row.marketId === 'string' && row.marketId.length <= 80
    && typeof row.marketLabel === 'string' && row.marketLabel.length <= 200 && typeof row.categoryLabel === 'string' && row.categoryLabel.length <= 100
    && Array.isArray(row.evidence) && row.evidence.length > 0 && row.evidence.length <= 4 && row.evidence.every(evidence => {
      const source = discovery.sources.find(source => source.accession === evidence.accession && source.status === 'ready');
      return source && ['url', 'accession', 'form', 'filed', 'reportDate', 'role'].every(key => (evidence[key] ?? null) === (source[key] ?? null))
        && ['10-K', '20-F', '40-F', '10-Q'].includes(evidence.form) && validDate(evidence.filed) && evidence.filed <= discovery.checkedAt.slice(0, 10)
        && validDate(evidence.reportDate) && evidence.reportDate <= evidence.filed && documentMatches(evidence.url, discovery.cik, evidence.accession)
        && typeof evidence.id === 'string' && evidence.id.length <= 120 && typeof evidence.text === 'string' && evidence.text.length >= 35 && evidence.text.length <= 1800
        && ['connection', 'qualifying-or-negative'].includes(evidence.disclosureDirection)
        && (evidence.benchmark === null || !!thirteenFMarketBenchmark(evidence.benchmark))
        && (evidence.disclosureDirection !== 'qualifying-or-negative' || evidence.benchmark === null);
    }));
}

function categoryFor(id, benchmark) {
  if (benchmark?.family === 'tff') return ['134741', '042601', '043602'].includes(benchmark.contract) ? 'rates' : ['099741', '097741', '096742'].includes(benchmark.contract) ? 'currencies' : 'other';
  if (/sofr|treasury|interest-rate/.test(id)) return 'rates';
  if (/euro|yen|sterling|currenc/.test(id)) return 'currencies';
  if (/crude|brent|gas|lng|fuel|diesel|electricity/.test(id)) return 'energy';
  if (/gold|silver|copper|aluminum|lithium|nickel|zinc|steel|iron|palladium|platinum/.test(id)) return 'metals';
  if (/corn|wheat|soy|cattle|coffee|cocoa|cotton|sugar|rice|rubber/.test(id)) return 'agriculture';
  return 'other';
}

/** Percentages retain the complete disclosed portfolio denominator, even when
 * only some companies have been scanned. Sets prevent double counting across
 * business channels, duplicate passages, classes, and overlapping markets. */
export function buildThirteenFMarketConnections(data, results = [], { now = Date.now() } = {}) {
  const holdings = thirteenFMarketHoldings(data), portfolio = data?.portfolio;
  const denominatorUsd = portfolio?.complete === true && data?.coverage?.selectedPeriodComplete === true && finite(portfolio.totalValueUsd) && portfolio.totalValueUsd > 0 ? portfolio.totalValueUsd : null;
  const percentagesAvailable = denominatorUsd !== null;
  const share = value => percentagesAvailable && finite(value) ? value / denominatorUsd * 100 : null;
  const byKey = new Map(results.map(result => [result?.holding?.key || result?.key, result]));
  const markets = new Map(), unmapped = new Map();
  const coverage = { total: holdings.length, attempted: 0, checked: 0, linked: 0, disclosureOnly: 0, unresolved: 0, unavailable: 0, partial: 0, noMatches: 0, noFiling: 0, unchecked: 0, checkedSharePct: percentagesAvailable ? 0 : null, linkedSharePct: percentagesAvailable ? 0 : null };
  const makeMember = (holding, result) => ({ key: holding.key, cusip: holding.cusip, name: holding.issuer, classTitle: holding.classTitle, putCall: holding.putCall, valueUsd: holding.valueUsd, sharePct: share(holding.valueUsd), holding, issuer: result.identity.issuer, identityEvidence: result.identity.evidence, evidence: [], qualifierCount: 0 });
  function add(map, group, holding, result, evidence) {
    if (!map.has(group.key)) map.set(group.key, { ...group, members: new Map() });
    const target = map.get(group.key);
    if (!target.members.has(holding.key)) target.members.set(holding.key, makeMember(holding, result));
    const member = target.members.get(holding.key);
    for (const item of evidence) {
      // Preserve one passage per business channel, without inflating holdings.
      if (!member.evidence.some(previous => previous.id === item.id && previous.categoryLabel === item.categoryLabel && previous.marketId === item.marketId)) member.evidence.push(item);
    }
  }
  const positions = holdings.map(holding => {
    const result = byKey.get(holding.key), position = { holding, status: 'unchecked', issuer: null, message: 'This holding has not been checked.', marketKeys: [], unmappedKeys: [] };
    if (!result) { coverage.unchecked++; return position; }
    coverage.attempted++;
    if (!is13FMarketConnectionResult(result, { cik: data.manager.cik, period: data.selectedPeriod, holding, now })) {
      coverage.unavailable++; return { ...position, status: 'unavailable', message: result.message || 'The holding’s SEC evidence could not be verified. Retry this holding.' };
    }
    if (result.status === 'unresolved') {
      coverage.unresolved++; return { ...position, status: 'unresolved', message: result.identity.reason || 'A verified operating-company identity is unavailable.' };
    }
    position.issuer = result.identity.issuer;
    const discovery = result.discovery;
    if (discovery.status === 'unavailable') { coverage.unavailable++; return { ...position, status: 'unavailable', message: discovery.message || 'Issuer filing evidence is temporarily unavailable.' }; }
    if (discovery.status === 'no_filing') { coverage.noFiling++; return { ...position, status: 'no_filing', message: discovery.message || 'No eligible complete annual or quarterly filing was found.' }; }
    coverage.checked++;
    if (percentagesAvailable && finite(holding.valueUsd)) coverage.checkedSharePct += share(holding.valueUsd);
    const partial = discovery.status === 'partial' || discovery.coverage?.searchComplete === false;
    if (partial) coverage.partial++;
    for (const row of discovery.rows) {
      const evidence = row.evidence.map(item => ({ ...item, categoryLabel: row.categoryLabel, marketId: row.marketId, channelExplanation: row.channelExplanation }));
      const benchmarks = new Map(evidence.filter(item => item.disclosureDirection === 'connection' && item.benchmark).map(item => [marketKey(item.benchmark), thirteenFMarketBenchmark(item.benchmark)]));
      for (const [key, benchmark] of benchmarks) {
        const supporting = evidence.filter(item => item.disclosureDirection === 'qualifying-or-negative' || (item.benchmark && marketKey(item.benchmark) === key));
        add(markets, { ...benchmark, key, category: categoryFor(row.marketId, benchmark), groupLabel: benchmark.family === 'tff' ? 'Leveraged funds' : 'Managed money' }, holding, result, supporting);
        position.marketKeys.push(key);
      }
      if (!benchmarks.size) {
        const key = `unmapped:${row.marketId}`;
        add(unmapped, { key, category: categoryFor(row.marketId), label: row.marketLabel, reason: row.benchmarkUnavailableReason || 'These passages do not establish a supported CFTC benchmark.', basisLimit: row.benchmarkUnavailableReason || 'No supported CFTC benchmark is assigned.' }, holding, result, evidence);
        position.unmappedKeys.push(key);
      }
    }
    position.marketKeys = unique(position.marketKeys); position.unmappedKeys = unique(position.unmappedKeys);
    if (position.marketKeys.length) {
      coverage.linked++; if (percentagesAvailable && finite(holding.valueUsd)) coverage.linkedSharePct += share(holding.valueUsd);
      position.status = partial ? 'partial' : 'linked'; position.message = partial ? 'Some issuer filings were unavailable. Connections use the sources that could be read.' : 'SEC passages support the displayed market research connections.';
    } else if (position.unmappedKeys.length) { coverage.disclosureOnly++; position.status = partial ? 'partial' : 'disclosure_only'; position.message = 'SEC market drivers were found, with no supported futures benchmark assigned.'; }
    else { coverage.noMatches++; position.status = partial ? 'partial' : 'no_matches'; position.message = partial ? 'The filing search was incomplete; no connection is assumed.' : 'No qualifying passage was found in the bounded filing scan. This does not establish zero exposure.'; }
    if (discovery.coverage?.extractionLimited) position.message += ' The bounded extraction may omit additional passages.';
    return position;
  });
  const finish = map => [...map.values()].map(group => {
    const members = [...group.members.values()].map(member => ({ ...member, qualifierCount: unique(member.evidence.filter(item => item.disclosureDirection === 'qualifying-or-negative').map(item => item.id)).length,
      evidence: member.evidence.sort((a, b) => b.filed.localeCompare(a.filed) || (a.disclosureDirection === 'qualifying-or-negative' ? -1 : 1)) }));
    const valueUsd = members.every(member => finite(member.valueUsd)) ? members.reduce((sum, member) => sum + member.valueUsd, 0) : null;
    return { ...group, members, count: members.length, issuerCount: unique(members.map(member => member.issuer.cik)).length, valueUsd, sharePct: share(valueUsd) };
  }).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0) || b.count - a.count || a.label.localeCompare(b.label));
  return { holdings, positions, markets: finish(markets), unmapped: finish(unmapped), coverage, percentagesAvailable, denominatorUsd, quarter: data?.selectedPeriod || null };
}
