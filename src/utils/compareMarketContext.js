import { CFTC_FAMILIES, CFTC_LAUNCH_CATALOG, cftcDate } from './cftc.js';
import { companyCftcEvidence } from './companyCftcEvidence.js';

const validDate = value => typeof value === 'string' && cftcDate(value) === value;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const identity = company => String(company?.cik || '').padStart(10, '0');

/** The same issuer cannot increase the apparent overlap through share classes. */
export function compareMarketCompanies(companies = []) {
  const seen = new Set();
  return companies.slice(0, 12).flatMap(company => {
    const cik = identity(company);
    if (!/^\d{10}$/.test(cik) || Number(cik) === 0 || seen.has(cik)
      || typeof company.ticker !== 'string' || !/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(company.ticker)) return [];
    seen.add(cik);
    return [{ ticker: company.ticker, cik, companyName: String(company.companyName || company.name || company.ticker), secIdentity: company.secIdentity || null, companyType: ['brokerdealer', 'broker-dealer'].includes(company.companyType) || ['brokerdealer', 'broker-dealer'].includes(company.businessModel) ? 'broker' : company.companyType || 'corporate' }];
  });
}

/** Resolve punctuation only through a verified directory entry whose issuer
 * matches the already loaded financial response. Exact SEC symbols take priority. */
export function compareMarketIdentity(company, directory = null) {
  const cik = identity(company), ticker = company?.ticker;
  if (!/^\d{10}$/.test(cik) || Number(cik) === 0 || typeof ticker !== 'string') return null;
  const candidate = directory
    ? directory[ticker] || (ticker.includes('.') ? directory[ticker.replaceAll('.', '-')] : null)
    : company.secIdentity;
  if (candidate) {
    if (identity(candidate) !== cik || candidate.isFund === true
      || ![ticker, ...(ticker.includes('.') ? [ticker.replaceAll('.', '-')] : [])].includes(candidate.ticker)) return null;
    return { ticker: candidate.ticker, cik };
  }
  return ticker.includes('.') ? null : { ticker, cik };
}

function verifiedPassage(evidence, cik, asOf, today) {
  if (!validDate(evidence.filed) || evidence.filed > (asOf || today)
    || !validDate(evidence.reportDate) || evidence.reportDate > evidence.filed
    || !/^\d{10}-\d{2}-\d{6}$/.test(evidence.accession || '')) return false;
  const sourceCik = evidence.sourceCik || cik;
  if (!/^\d{10}$/.test(sourceCik)) return false;
  const prefix = `https://www.sec.gov/Archives/edgar/data/${Number(sourceCik)}/${evidence.accession.replaceAll('-', '')}/`;
  return typeof evidence.url === 'string' && evidence.url.startsWith(prefix)
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(evidence.url.slice(prefix.length));
}

/** Combine evidence, not estimated financial exposures. Negative qualifications
 * remain visible and never count as an unqualified shared connection. */
export function buildCompareMarketContext(companies, responses = {}, { basis = 'annual', asOf = '', now = new Date() } = {}) {
  const issuers = compareMarketCompanies(companies), markets = new Map(), states = {};
  const today = new Date(now).toISOString().slice(0, 10);
  const coverage = { total: issuers.length, checked: 0, failed: 0, partial: 0, pending: 0, unmapped: 0 };
  for (const company of issuers) {
    const result = responses[company.ticker];
    if (!result) { coverage.pending++; states[company.ticker] = 'pending'; continue; }
    if (result.error) { coverage.failed++; states[company.ticker] = 'failed'; continue; }
    let selected;
    try {
      const sourceIdentity = compareMarketIdentity({ ...company, secIdentity: result.secIdentity || company.secIdentity });
      if (!sourceIdentity) throw new Error('SEC ticker identity is unresolved.');
      selected = companyCftcEvidence(result.body, { ...company, ...sourceIdentity, basis, asOf });
    }
    catch { coverage.failed++; states[company.ticker] = 'failed'; continue; }
    if (selected.rows.some(row => row.evidence.some(item => !verifiedPassage(item, company.cik, asOf, today)))) {
      coverage.failed++; states[company.ticker] = 'failed'; continue;
    }
    states[company.ticker] = result.body.status === 'partial' ? 'partial' : 'ready';
    coverage.checked++;
    if (result.body.status === 'partial') coverage.partial++;
    for (const row of selected.rows) {
      if (!row.benchmark) { coverage.unmapped++; continue; }
      const key = `${row.family}:${row.contract}:${row.group}`;
      const catalog = CFTC_LAUNCH_CATALOG.find(item => item.family === row.family && item.code === row.contract);
      if (!catalog) continue;
      if (!markets.has(key)) markets.set(key, { key, family: row.family, contract: row.contract, group: row.group, label: catalog.label, groupLabel: CFTC_FAMILIES[row.family].groups.find(item => item.id === row.group)?.label, members: [] });
      const market = markets.get(key);
      let member = market.members.find(item => item.cik === company.cik);
      if (!member) { member = { ...company, named: false, qualified: false, channels: [], evidence: [] }; market.members.push(member); }
      member.named ||= row.fit === 'named-reference';
      member.qualified ||= row.evidence.some(item => item.disclosureDirection === 'qualifying-or-negative');
      if (!member.channels.includes(row.categoryLabel)) member.channels.push(row.categoryLabel);
      for (const item of row.evidence) if (!member.evidence.some(prior => prior.id === item.id)) member.evidence.push(item);
    }
  }
  const rows = [...markets.values()].map(market => ({ ...market, count: market.members.filter(member => !member.qualified).length }));
  rows.sort((a, b) => b.count - a.count || b.members.length - a.members.length || a.label.localeCompare(b.label));
  return { companies: issuers, states, rows: rows.slice(0, 4), totalMarkets: rows.length, shared: rows.filter(row => row.count >= 2).length, coverage };
}

function officialCftcSource(value, family) {
  try {
    const source = new URL(value);
    return source.protocol === 'https:' && source.hostname === 'publicreporting.cftc.gov'
      && !source.port && !source.username && !source.password && !source.hash
      && source.pathname === `/resource/${CFTC_FAMILIES[family]?.datasetId}.json`;
  } catch { return false; }
}

/** This is the compact, already source-validated prepared response. Bind it
 * again to the displayed contract/group, reject future dates and unsafe links,
 * and require an exact seven-day pair for a weekly change. */
export function compareMarketObservation(entry, market, now = new Date()) {
  const value = entry?.status === 'ready' ? entry.summary : null;
  const today = new Date(now).toISOString().slice(0, 10);
  if (!value || value.key !== market.key || value.family !== market.family || value.contract !== market.contract
    || value.group !== market.group || !validDate(value.reportDate) || value.reportDate > today
    || !officialCftcSource(value.sourceUrl, market.family)
    || !finite(value.netPctOi) || Math.abs(value.netPctOi) > 100) return null;
  const weeklyValid = validDate(value.priorDate) && Date.parse(value.reportDate) - Date.parse(value.priorDate) === 7 * 86400000
    && finite(value.weeklyChangePp) && Math.abs(value.weeklyChangePp) <= 200;
  const ageDays = Math.floor((Date.parse(today) - Date.parse(value.reportDate)) / 86400000);
  return {
    reportDate: value.reportDate, netPctOi: value.netPctOi, weeklyChangePp: weeklyValid ? value.weeklyChangePp : null,
    stale: value.stale === true || ageDays > 14, incomplete: value.incomplete === true,
    sourceUrl: value.sourceUrl,
    marketPath: `/market?${new URLSearchParams({ tab: 'positioning', family: market.family, contract: market.contract, group: market.group, date: value.reportDate, history: '1y', display: 'net-oi' })}`,
  };
}
