import { normalizeIssuerName } from './globalFundSecurity.js';

// A coverage cohort, never an assertion that a selected manager holds a stock.
export const OWNERSHIP_FUNDS = Object.freeze([
  { id: 'VOO', name: 'Vanguard 500 Index Fund' },
  { id: 'VTI', name: 'Vanguard Total Stock Market Index Fund' },
  { id: 'SPY', name: 'SPDR S&P 500 ETF Trust' },
  { id: 'QQQ', name: 'Invesco QQQ Trust' },
  { id: 'IWM', name: 'iShares Russell 2000 ETF' },
  { id: 'ARKK', name: 'ARK Innovation ETF' },
]);
export const OWNERSHIP_MANAGERS = Object.freeze([
  { id: '0000102909', name: 'Vanguard Group' },
  { id: '0001364742', name: 'BlackRock' },
  { id: '0000093751', name: 'State Street' },
  { id: '0001067983', name: 'Berkshire Hathaway' },
  { id: '0001350694', name: 'Bridgewater Associates' },
  { id: '0001037389', name: 'Renaissance Technologies' },
  { id: '0001747057', name: 'D1 Capital' },
]);
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const number = value => finite(value) !== null && value >= 0 ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const upper = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const issuer = value => normalizeIssuerName(String(value || '').replace(/\s*\/[A-Z]{2,3}\/?\s*$/i, ''));
// Preserve the legal form: Blue Owl Capital Inc and Blue Owl Capital Corp
// are different SEC issuers. Normalize spelling/punctuation, not identity.
const legalIssuer = value => String(value || '').replace(/\s*\/[A-Z]{2,3}\/?\s*$/i, '')
  .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ')
  .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
  .replace(/\bincorporated\b/g, 'inc').replace(/\bcorporation\b/g, 'corp')
  .replace(/\bcompany\b/g, 'co').replace(/\blimited\b/g, 'ltd');
const cikKey = value => String(value || '').padStart(10, '0');

export function ownershipCompanyTarget(ticker, directory) {
  const company = directory[ticker];
  if (!company) return null;
  const name = legalIssuer(company.name), cik = cikKey(company.cik);
  const matchingCiks = new Set(Object.values(directory).filter(row => legalIssuer(row.name) === name).map(row => cikKey(row.cik)));
  return { ...company, aliases: Object.entries(directory).filter(([, row]) => cikKey(row.cik) === cik).map(([symbol]) => upper(symbol)),
    nameMatchAllowed: Boolean(name) && matchingCiks.size === 1 && matchingCiks.has(cik) };
}
const cusip = value => /^(?!000000000)[A-Z0-9*@#]{8}[0-9]$/.test(upper(value)) ? upper(value) : null;
const total = values => values.length && values.every(value => finite(value) !== null) ? values.reduce((sum, value) => sum + value, 0) : null;
const sorted = rows => rows.sort((a, b) => (b.valueUsd ?? -Infinity) - (a.valueUsd ?? -Infinity) || a.name.localeCompare(b.name));
const commonLong = row => upper(row.assetCat) === 'EC' && upper(row.payoffProfile) === 'LONG'
  && (row.balance === null || row.balance >= 0) && (row.value === null || row.value >= 0);
const directMatch = (row, target) => {
  if (!commonLong(row)) return false;
  const reportedName = issuer(row.name), requestedName = issuer(target.name);
  if (!reportedName || !requestedName || reportedName !== requestedName) return false;
  // An explicit ticker must belong to this issuer and remain compatible with
  // its name. Name-only rows require a distinct legal identity in the complete
  // SEC directory; ambiguous legal names cannot seed a CUSIP for 13F matching.
  if (row.tickerSymbol) return target.aliases.includes(upper(row.tickerSymbol));
  return target.nameMatchAllowed === true && legalIssuer(row.name) === legalIssuer(target.name);
};
const fresh = (checkedAt, now) => Number.isFinite(Date.parse(checkedAt)) && now - Date.parse(checkedAt) < 3600000;
const source = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'www.sec.gov'
    && url.pathname.startsWith('/Archives/edgar/data/') && !url.username && !url.password ? value : null; } catch { return null; }
};

export function normalizeOwnershipRequest(tickerInput, asOfInput = '', now = Date.now()) {
  const ticker = String(tickerInput || '').trim().toUpperCase(), asOf = String(asOfInput || '').trim();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)) throw new RangeError('Select one valid company ticker.');
  if (asOf && (!date(asOf) || asOf > new Date(now).toISOString().slice(0, 10))) throw new RangeError('Select a valid SEC filing cutoff.');
  return { ticker, asOf };
}

/** Only complete portfolios reach this projection. Missing input never becomes
 * a zero; separate managers and SEC fund series are never summed together. */
export function projectCompanyOwnership({ ticker, target, funds = [], managers = [], asOf = '', now = Date.now() }) {
  const cutoff = asOf || new Date(now).toISOString().slice(0, 10);
  const eligibleFunds = funds.filter(item => item.data?.status === 'ready' && item.data.ticker === item.id
    && date(item.data.asOf) && date(item.data.filingDate) && item.data.filingDate <= cutoff && item.data.asOf <= cutoff
    && Array.isArray(item.data.holdings) && source(item.data.sourceUrl));
  // SEC fund series can have multiple ticker aliases. Only one report survives.
  const series = new Map();
  for (const item of eligibleFunds) {
    const key = `${item.data.cik}:${item.data.seriesId || item.data.ticker}`;
    const prior = series.get(key);
    if (!prior || item.data.asOf > prior.data.asOf || item.data.asOf === prior.data.asOf && item.data.filingDate > prior.data.filingDate) series.set(key, item);
  }
  const preparedFunds = [...series.values()];
  const identifiers = new Set(preparedFunds.flatMap(item => item.data.holdings.filter(row => directMatch(row, target)).map(row => cusip(row.cusip)).filter(Boolean)));
  const matchFund = row => directMatch(row, target) || commonLong(row) && identifiers.has(cusip(row.cusip))
    && (!row.tickerSymbol || target.aliases.includes(upper(row.tickerSymbol)));
  const fundRows = preparedFunds.flatMap(({ data }) => {
    const holdings = data.holdings.filter(matchFund);
    if (!holdings.length) return [];
    const checkedAt = data.cache?.checkedAt || data.retrievedAt;
    const positions = holdings.map(row => ({ cusip: cusip(row.cusip) || '', name: row.name, classTitle: row.title || 'Common equity',
      shares: upper(row.units) === 'NS' ? number(row.balance) : null, valueUsd: number(row.value) }));
    const valueUsd = total(positions.map(row => row.valueUsd)), nav = number(data.fundInfo?.netAssets);
    // Preserve reported NAV percentages. A complete sum is only available when
    // every included stock position has a supported weight.
    const weightPct = total(holdings.map(row => finite(row.pctOfNav)));
    return [{ id: `${data.cik}:${data.seriesId || data.ticker}`, kind: 'fund', name: data.name, ticker: data.ticker,
      cik: data.cik, seriesId: data.seriesId, reportDate: data.asOf, filingDate: data.filingDate, checkedAt,
      stale: data.cache?.stale === true || !fresh(checkedAt, now), valueUsd, shares: total(positions.map(row => row.shares)), weightPct,
      denominatorUsd: nav, denominatorLabel: 'fund net assets', sourceUrl: data.sourceUrl,
      researchUrl: `/fund/${encodeURIComponent(data.ticker)}?accession=${data.accession}`, positions }];
  });
  const eligibleManagers = managers.filter(item => item.saved?.data?.status === 'ready' && item.saved.data.manager?.cik === item.id
    && item.saved.data.portfolio?.complete === true && item.saved.data.coverage?.selectedPeriodComplete === true
    && date(item.saved.data.portfolio.period) && item.saved.data.portfolio.period <= cutoff
    && item.saved.data.portfolio.filings?.length && item.saved.data.portfolio.filings.every(row => date(row.filingDate) && row.filingDate <= cutoff && source(row.indexUrl)));
  const managerRows = eligibleManagers.flatMap(({ saved }) => {
    const { portfolio: p, manager } = saved.data;
    // The exact CUSIP comes from reported long common equity in N-PORT. Options,
    // preferred shares, notes and all principal-amount records stay outside it.
    const holdings = p.holdings.filter(row => identifiers.has(cusip(row.cusip)) && row.putCall === null && row.quantityType === 'SH');
    if (!holdings.length) return [];
    const positions = holdings.map(row => ({ cusip: row.cusip, name: row.issuer, classTitle: row.classTitle,
      shares: number(row.quantity), valueUsd: number(row.valueUsd) }));
    const valueUsd = total(positions.map(row => row.valueUsd)), denominator = number(p.totalValueUsd);
    const filing = [...p.filings].sort((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
    return [{ id: manager.cik, kind: 'manager', name: manager.name, cik: manager.cik, reportDate: p.period,
      filingDate: filing.filingDate, checkedAt: saved.checkedAt,
      stale: Boolean(saved.invalidatedAt) || !fresh(saved.checkedAt, now), valueUsd, shares: total(positions.map(row => row.shares)),
      weightPct: valueUsd !== null && denominator > 0 ? valueUsd / denominator * 100 : null,
      denominatorUsd: denominator, denominatorLabel: 'reported 13F holdings', sourceUrl: filing.indexUrl,
      researchUrl: `/fund?view=13f&managerCik=${manager.cik}&managerPeriod=${p.period}&managerView=holdings`, positions,
      sources: p.filings.map(row => ({ url: row.indexUrl, filed: row.filingDate, form: row.form })),
      confidentialOmitted: p.confidentialOmitted, reportType: p.reportType }];
  });
  const missing = (items, available, kind) => items.filter(item => !available.includes(item)).map(item => ({ kind, id: item.id, name: item.name,
    url: kind === 'fund' ? `/fund/${item.id}` : `/fund?view=13f&managerCik=${item.id}` }));
  const checkedDates = [...preparedFunds.map(item => item.data.cache?.checkedAt || item.data.retrievedAt), ...eligibleManagers.map(item => item.saved.checkedAt)].filter(Boolean).sort();
  return {
    schemaVersion: 'edgar.company-ownership.v1', ticker, companyName: target.name || ticker, asOf: asOf || null,
    checkedAt: checkedDates[0] || null,
    identity: { status: identifiers.size ? 'reported-match' : 'unavailable', cusips: [...identifiers].sort(),
      note: 'Company-wide common equity matched by a compatible reported ticker or an unambiguous SEC legal name. Exact reported CUSIPs link 13F positions. Share classes remain visible in the evidence.' },
    funds: sorted(fundRows), managers: sorted(managerRows),
    coverage: { fundsChecked: funds.length, fundsAvailable: preparedFunds.length, managersChecked: managers.length, managersAvailable: eligibleManagers.length,
      notPrepared: [...missing(funds, eligibleFunds, 'fund'), ...missing(managers, eligibleManagers, 'manager')],
      excludedAfterCutoff: funds.filter(item => item.data?.filingDate > cutoff).length
        + managers.filter(item => item.saved?.data?.portfolio?.filings?.some(row => row.filingDate > cutoff)).length },
    limitations: [
      'A selected sample of prepared SEC reports, not a complete shareholder register or beneficial-ownership ranking. A missing match does not establish zero ownership.',
      'N-PORT identifies a fund portfolio covering all share classes in its SEC series. Form 13F identifies an investment manager exercising investment discretion, not an individual investment fund.',
      'Weights use each fund’s net assets or each manager’s complete reported 13F value. They are not percentages of the company owned, AUM or investment performance.',
      'Only directly reported long common equity is included. Options, preferred shares, debt and indirect fund holdings are excluded. No look-through or totals across managers and funds; positions can overlap.',
      'Reporting dates differ. Holdings are historical; 13F excludes many assets and can omit confidential positions. Original report check times and stale status are retained.',
      ...(asOf ? ['The cutoff excludes filings published later. Only saved eligible reports are searched; this does not reconstruct the entire shareholder register as known on that date.'] : []),
    ],
  };
}
