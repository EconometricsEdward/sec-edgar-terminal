// Pure N-PORT parsing and portfolio math. Each holding is retained before sorting.
export const ASSET_LABELS = { EC: 'Common equity', EP: 'Preferred equity', DBT: 'Debt', LON: 'Loans', STIV: 'Short-term investments', RA: 'Repurchase agreements', RE: 'Real estate', SN: 'Structured notes', DIR: 'Interest-rate derivatives', DCR: 'Credit derivatives', DFE: 'FX derivatives', DE: 'Equity derivatives', DCO: 'Commodity derivatives', DO: 'Other derivatives', OTH: 'Other' };
export const FUND_CATALOG = [
  ['SPY', 'SPDR S&P 500 ETF Trust', 'State Street', 'US equity', 'S&P 500'],
  ['VOO', 'Vanguard S&P 500 ETF', 'Vanguard', 'US equity', 'S&P 500'],
  ['VTI', 'Vanguard Total Stock Market ETF', 'Vanguard', 'US equity', 'Total US market'],
  ['QQQ', 'Invesco QQQ', 'Invesco', 'US equity', 'Nasdaq-100'],
  ['IWM', 'iShares Russell 2000 ETF', 'iShares', 'US equity', 'Small-cap'],
  ['ARKK', 'ARK Innovation ETF', 'ARK Invest', 'US equity', 'Active / thematic'],
  ['VXUS', 'Vanguard Total International Stock ETF', 'Vanguard', 'International', 'Ex-US equities'],
  ['VEA', 'Vanguard FTSE Developed Markets ETF', 'Vanguard', 'International', 'Developed markets'],
  ['VWO', 'Vanguard FTSE Emerging Markets ETF', 'Vanguard', 'International', 'Emerging markets'],
  ['BND', 'Vanguard Total Bond Market ETF', 'Vanguard', 'Fixed income', 'US investment-grade bonds'],
  ['AGG', 'iShares Core US Aggregate Bond ETF', 'iShares', 'Fixed income', 'US aggregate bonds'],
  ['TLT', 'iShares 20+ Year Treasury Bond ETF', 'iShares', 'Fixed income', 'Long-term US Treasuries'],
].map(([ticker, name, family, category, focus]) => ({ ticker, name, family, category, focus }));
const NS = '(?:[\\w.-]+:)?';
export function xmlBlocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${NS}${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${NS}${tag}\\s*>`, 'g'))].map(m => m[1]);
}
export function xmlText(xml, tag) {
  const value = xmlBlocks(xml, tag)[0];
  return value == null ? null : decodeXml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
}
function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) => {
    if (code[0] === '#') { const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[code.toLowerCase()];
  });
}
function attr(xml, tag, name) {
  const tagMatch = xml.match(new RegExp(`<${NS}${tag}\\b([^>]*)\\/?>`));
  return tagMatch?.[1].match(new RegExp(`\\b${name}=["']([^"']*)["']`))?.[1] || null;
}
function numeric(xml, tag) {
  const text = xmlText(xml, tag);
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const n = Number(text); return Number.isFinite(n) ? n : null;
}
export function parseNport(xml, expected = {}) {
  const gen = xmlBlocks(xml, 'genInfo')[0];
  const info = xmlBlocks(xml, 'fundInfo')[0];
  if (!gen || !info) throw new Error('The filing does not contain a readable N-PORT portfolio.');
  const seriesId = xmlText(gen, 'seriesId');
  const cik = String(xmlText(gen, 'regCik') || '').padStart(10, '0');
  if (expected.seriesId && seriesId !== expected.seriesId) throw new Error('The filing series does not match the requested fund.');
  if (expected.cik && cik !== String(expected.cik).padStart(10, '0')) throw new Error('The filing registrant does not match the requested fund.');
  const asOf = xmlText(gen, 'repPdDate');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf || '')) throw new Error('The portfolio reporting date is unavailable.');
  const totAssets = numeric(info, 'totAssets'), totLiabs = numeric(info, 'totLiabs');
  const reportedNetAssets = numeric(info, 'netAssets');
  const netAssets = reportedNetAssets ?? (totAssets != null && totLiabs != null ? totAssets - totLiabs : null);
  const holdingBlocks = xmlBlocks(xml, 'invstOrSec');
  const holdings = holdingBlocks.map((block, i) => {
    const value = numeric(block, 'valUSD');
    const reportedWeight = numeric(block, 'pctVal');
    return {
      id: i + 1, name: xmlText(block, 'name') || xmlText(block, 'title') || 'Unnamed position',
      title: xmlText(block, 'title'), cusip: xmlText(block, 'cusip'),
      isin: attr(block, 'isin', 'value') || xmlText(block, 'isin'),
      tickerSymbol: attr(block, 'ticker', 'value') || xmlText(block, 'ticker'),
      balance: numeric(block, 'balance'), units: xmlText(block, 'units'), value,
      pctOfNav: reportedWeight ?? (value != null && netAssets > 0 ? value / netAssets * 100 : null),
      weightSource: reportedWeight != null ? 'reported' : value != null && netAssets > 0 ? 'calculated' : 'unavailable',
      assetCat: xmlText(block, 'assetCat') || attr(block, 'assetConditional', 'assetCat') || 'OTH',
      invCountry: xmlText(block, 'invCountry') || 'Unknown', payoffProfile: xmlText(block, 'payoffProfile'),
    };
  });
  holdings.sort((a, b) => compareNullable(a.value, b.value, 'desc'));
  const seriesName = xmlText(gen, 'seriesName');
  return { name: seriesName && !/^(N\/?A|NONE)$/i.test(seriesName) ? seriesName : xmlText(gen, 'regName'), registrant: xmlText(gen, 'regName'), seriesId, cik, asOf, fundInfo: { totAssets, totLiabs, netAssets, netAssetsSource: reportedNetAssets != null ? 'reported' : netAssets != null ? 'assets less liabilities' : 'unavailable', cash: numeric(info, 'cshNotRptdInCorD') }, holdings };
}
export function parseFundFeed(xml) {
  return xmlBlocks(xml, 'entry').map(block => ({ accession: xmlText(block, 'accession-number'), filingDate: xmlText(block, 'filing-date'), form: xmlText(block, 'filing-type') })).filter(f => /^\d{10}-\d{2}-\d{6}$/.test(f.accession || '') && /^NPORT-P(?:\/A)?$/.test(f.form || ''));
}
export function compareNullable(a, b, direction = 'desc') {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  const result = typeof a === 'string' ? a.localeCompare(b) : a - b;
  return direction === 'asc' ? result : -result;
}
export function portfolioSummary(portfolio) {
  const holdings = portfolio.holdings, nav = portfolio.fundInfo.netAssets;
  const valued = holdings.filter(h => h.value != null);
  const weightKnown = holdings.filter(h => h.pctOfNav != null);
  const sum = (rows, key) => rows.reduce((n, h) => n + h[key], 0);
  const group = key => {
    const groups = new Map();
    holdings.forEach(h => { const label = h[key]; const g = groups.get(label) || { key: label, count: 0, value: 0, valued: 0 }; g.count++; if (h.value != null) { g.value += h.value; g.valued++; } groups.set(label, g); });
    return [...groups.values()].map(g => ({ ...g, value: g.valued ? g.value : null, pctOfNav: g.valued && nav > 0 ? g.value / nav * 100 : null })).sort((a, b) => compareNullable(a.value, b.value));
  };
  const positive = weightKnown.filter(h => h.pctOfNav > 0).sort((a, b) => b.pctOfNav - a.pctOfNav);
  return { count: holdings.length, valuedCount: valued.length, weightCount: weightKnown.length, value: valued.length ? sum(valued, 'value') : null,
    weightTotal: weightKnown.length ? sum(weightKnown, 'pctOfNav') : null,
    top10Weight: positive.length ? sum(positive.slice(0, 10), 'pctOfNav') : null,
    largest: positive[0] || null, assets: group('assetCat'), countries: group('invCountry'),
    derivativeCount: holdings.filter(h => /^D(IR|CR|FE|E|CO|O)$/.test(h.assetCat)).length };
}
export function filterHoldings(holdings, { query = '', asset = '', country = '', sort = 'value', direction = 'desc' } = {}) {
  const q = query.trim().toLowerCase().slice(0, 100);
  const key = ['value', 'pctOfNav', 'name', 'balance'].includes(sort) ? sort : 'value';
  return holdings.filter(h => (!q || [h.name, h.title, h.cusip, h.isin, h.tickerSymbol].some(s => s?.toLowerCase().includes(q))) && (!asset || h.assetCat === asset) && (!country || h.invCountry === country)).sort((a, b) => compareNullable(a[key], b[key], direction));
}
const validId = id => id && !/^(N\/?A|NONE|0+|UNKNOWN|NOT AVAILABLE)$/i.test(id.trim());
// Security-level overlap: stable identifiers only, positive long non-derivative NAV weights.
function matchingPositions(portfolio) {
  const map = new Map(); let eligibleWeight = 0, excludedCount = 0;
  for (const h of portfolio.holdings) {
    const key = validId(h.cusip) ? `CUSIP:${h.cusip.toUpperCase()}` : validId(h.isin) ? `ISIN:${h.isin.toUpperCase()}` : null;
    if (!key || h.pctOfNav == null || h.pctOfNav <= 0 || h.payoffProfile?.toLowerCase() === 'short' || /^D(IR|CR|FE|E|CO|O)$/.test(h.assetCat)) { excludedCount++; continue; }
    const prior = map.get(key) || { name: h.name, weight: 0, key }; prior.weight += h.pctOfNav; map.set(key, prior); eligibleWeight += h.pctOfNav;
  }
  return { map, eligibleWeight, excludedCount };
}
export function portfolioOverlap(left, right) {
  const a = matchingPositions(left), b = matchingPositions(right), rows = [];
  for (const [key, position] of a.map) { const other = b.map.get(key); if (other) rows.push({ key, name: position.name, leftWeight: position.weight, rightWeight: other.weight, overlap: Math.min(position.weight, other.weight) }); }
  rows.sort((x, y) => y.overlap - x.overlap);
  return { left: left.ticker, right: right.ticker, leftAsOf: left.asOf, rightAsOf: right.asOf, samePeriod: left.asOf === right.asOf, samePortfolio: left.cik === right.cik && left.seriesId === right.seriesId,
    overlap: rows.reduce((n, r) => n + r.overlap, 0), count: rows.length, leftEligibleWeight: a.eligibleWeight, rightEligibleWeight: b.eligibleWeight, leftExcludedCount: a.excludedCount, rightExcludedCount: b.excludedCount, rows: rows.slice(0, 30) };
}
export function holdingsCsv(portfolio, rows = portfolio.holdings) {
  const headers = ['Fund ticker', 'Series ID', 'Portfolio date', 'Filed date', 'Accession', 'Holding', 'CUSIP', 'ISIN', 'Ticker', 'Asset category', 'Country', 'Balance', 'Units', 'USD value', 'Percent of net assets', 'Weight source', 'SEC source'];
  const escape = value => { let s = value == null ? '' : String(value); if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  return [headers, ...rows.map(h => [portfolio.ticker, portfolio.seriesId, portfolio.asOf, portfolio.filingDate, portfolio.accession, h.name, h.cusip, h.isin, h.tickerSymbol, h.assetCat, h.invCountry, h.balance, h.units, h.value, h.pctOfNav, h.weightSource, portfolio.sourceUrl])].map(row => row.map(escape).join(',')).join('\r\n');
}
