// Public projections read only prepared, validated portfolios. A crawler visit
// never fetches SEC documents, refreshes a portfolio or writes another copy.
import { readPreparedFund } from './fundResearchServer.js';
import { FUND_CATALOG } from './fundResearch.js';
import { create13FCache, THIRTEEN_F_FRESH_MS } from './thirteenFCache.js';
import { PUBLIC_FUND_MANAGERS } from './fundPublicSelectors.js';

const shared13F = create13FCache();
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const CIK = /^(?!0000000000)[0-9]{10}$/;
const ACCESSION = /^[0-9]{10}-[0-9]{2}-[0-9]{6}$/;
const QUARTER = /^[0-9]{4}-(?:03-31|06-30|09-30|12-31)$/;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value, limit = 240) => typeof value === 'string' ? value.slice(0, limit) : '';
const sortValue = (a, b) => (finite(b.valueUsd) ?? -Infinity) - (finite(a.valueUsd) ?? -Infinity);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

function sources(rows) {
  const seen = new Set();
  return rows.filter(row => {
    if (!row?.url || seen.has(row.url)) return false;
    try {
      const url = new URL(row.url);
      if (url.protocol !== 'https:' || !['www.sec.gov', 'data.sec.gov'].includes(url.hostname)
        || url.username || url.password || url.port) return false;
    } catch { return false; }
    seen.add(row.url); return true;
  }).slice(0, 32).map(row => ({ label: text(row.label), url: row.url }));
}
function unavailable(base) {
  return { schemaVersion: 'edgar.public-fund-summary.v1', ...base, status: 'unavailable', stale: false,
    topHoldings: [], sources: [], limitations: [],
    reason: 'A prepared summary is not available for this selection. Open the interactive research tool to check SEC coverage. This does not establish that no filing exists.' };
}
function freshness(checkedAt, now, duration, invalidated = false) {
  const checked = date(checkedAt);
  return { checkedAt: checked, freshUntil: checked ? new Date(Date.parse(checked) + duration).toISOString() : null,
    stale: invalidated || !checked || Date.parse(checked) > now || now - Date.parse(checked) >= duration };
}

/** Fixture injection isolates the cache-only boundary from SEC acquisition. */
export function createPublicFundReaders({ readFund = readPreparedFund,
  readManager = (cik, period, signal) => shared13F.readSnapshot(cik, period, signal), now = Date.now } = {}) {
  /** @param {string} tickerInput @param {string} accession @param {{signal?: AbortSignal}} options */
  async function readPublicFundSummary(tickerInput, accession = '', { signal } = {}) {
    const ticker = String(tickerInput).trim().toUpperCase();
    if (!TICKER.test(ticker) || accession && !ACCESSION.test(accession)) throw new RangeError('Invalid fund selection');
    const selector = accession ? `?accession=${accession}` : '';
    const base = unavailable({ kind: 'nport', ticker, name: FUND_CATALOG.find(fund => fund.ticker === ticker)?.name || ticker,
      valueLabel: 'Net assets', interactiveUrl: `/fund/${ticker}${selector}#fund-workspace`, summaryUrl: `/api/v1/funds/${ticker}${selector}` });
    const deadline = AbortSignal.timeout(8000);
    let data;
    try { data = await readFund(ticker, accession, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, allowStale: true }); }
    catch { return base; }
    if (data?.status !== 'ready' || data.ticker !== ticker || accession && data.accession !== accession) return base;
    const holdings = data.holdings || [];
    const checkedAt = data.cache?.checkedAt || data.retrievedAt;
    return { ...base, status: 'ready', reason: undefined, name: text(data.name), cik: data.cik,
      seriesId: data.seriesId, classId: data.classId, accession: data.accession,
      reportDate: data.asOf, filingDate: data.filingDate, retrievedAt: data.retrievedAt,
      ...freshness(checkedAt, now(), 3600000, data.cache?.stale === true),
      positionCount: holdings.length, valuedCount: data.summary?.valuedCount ?? 0, weightCount: data.summary?.weightCount ?? 0,
      totalValueUsd: finite(data.fundInfo?.netAssets), valueBasis: data.fundInfo?.netAssetsSource,
      top10WeightPct: finite(data.summary?.top10Weight), weightBasis: 'Percentage of portfolio net assets; never rescaled to the ten displayed positions.',
      topHoldings: holdings.map(holding => ({ name: text(holding.name), identifier: text(holding.isin || holding.cusip || holding.tickerSymbol, 40),
        valueUsd: finite(holding.value), weightPct: finite(holding.pctOfNav), weightSource: holding.weightSource,
        assetCategory: holding.assetCat, payoffProfile: holding.payoffProfile })).sort(sortValue).slice(0, 10),
      sources: sources([{ label: `${data.form} filing · ${data.filingDate}`, url: data.filingUrl },
        { label: 'Original N-PORT portfolio XML', url: data.sourceUrl }, { label: 'SEC fund filing history', url: data.secUrl }]),
      limitations: ['Historical reported portfolio, not current holdings or investment performance.',
        `${holdings.length} reported positions; ${data.summary?.valuedCount ?? 0} have USD values and ${data.summary?.weightCount ?? 0} have known net-asset weights. Missing figures are not zero.`,
        `Net assets: ${data.fundInfo?.netAssetsSource || 'unavailable'}. Weights can be reported or calculated from value divided by net assets; negative positions and derivatives are retained.`,
        ...(accession ? ['This summary is pinned to the selected accession; it does not incorporate later filings or amendments.'] : [])] };
  }
  /** @param {string} cikInput @param {string} period @param {{signal?: AbortSignal}} options */
  async function readPublicManagerSummary(cikInput, period = '', { signal } = {}) {
    const cik = String(cikInput).padStart(10, '0');
    if (!CIK.test(cik) || period && !QUARTER.test(period)) throw new RangeError('Invalid manager selection');
    const selector = period ? `?period=${period}` : '';
    const base = unavailable({ kind: '13f', cik, name: PUBLIC_FUND_MANAGERS.find(manager => manager.cik === cik)?.name || `Institutional manager CIK ${cik}`, valueLabel: 'Reported 13F holdings value',
      interactiveUrl: `/fund?view=13f&managerCik=${cik}${period ? `&managerPeriod=${period}` : ''}`,
      summaryUrl: `/api/v1/managers/${cik}${selector}` });
    const deadline = AbortSignal.timeout(8000);
    let saved;
    try { saved = await readManager(cik, period, signal ? AbortSignal.any([signal, deadline]) : deadline); }
    catch { return base; }
    const data = saved?.data, portfolio = data?.portfolio;
    if (data?.status !== 'ready' || data.manager?.cik !== cik || !portfolio?.complete
      || !data.coverage?.selectedPeriodComplete || period && portfolio.period !== period) return base;
    return { ...base, status: 'ready', reason: undefined, name: text(data.manager.name),
      reportDate: portfolio.period, filingDate: portfolio.filings.map(filing => filing.filingDate).sort().at(-1), retrievedAt: data.observedAt,
      ...freshness(saved.checkedAt, now(), THIRTEEN_F_FRESH_MS, Boolean(saved.invalidatedAt)),
      positionCount: portfolio.positionCount, totalValueUsd: finite(portfolio.totalValueUsd),
      top10WeightPct: finite(data.summary?.top10Pct),
      weightBasis: 'Percentage of all reported 13F holdings value; not manager assets under management or net assets.',
      confidentialOmitted: portfolio.confidentialOmitted, comparable: portfolio.comparable,
      topHoldings: portfolio.holdings.map(holding => ({ name: text(`${holding.issuer} · ${holding.classTitle}`), identifier: holding.cusip,
        valueUsd: finite(holding.valueUsd), weightPct: finite(holding.weightPct), putCall: holding.putCall, quantityType: holding.quantityType })).sort(sortValue).slice(0, 10),
      sources: sources(portfolio.filings.flatMap(filing => [
        { label: `${filing.form} · ${filing.filingDate}${filing.superseded ? ' · superseded' : ''}`, url: filing.indexUrl },
        { label: `Original cover · ${filing.accession}`, url: filing.primaryUrl } ])),
      limitations: ['Quarter-end public reportable holdings. Reported value is not assets under management, net assets, cash flow or performance.',
        'The full portfolio determines weights. Options remain distinct from ordinary shares; their reported underlying value is not option premium.',
        portfolio.confidentialOmitted ? 'This report explicitly omits confidential holdings; coverage and comparisons are limited.'
          : 'Cash, short positions, non-reportable securities and any non-public holdings are outside this summary.',
        ...(data.coverage.note ? [text(data.coverage.note, 800)] : []),
        ...(saved.invalidatedAt ? ['Newer incomplete evidence was found. These are the last complete prepared results; refresh is required.'] : [])] };
  }
  return { readPublicFundSummary, readPublicManagerSummary };
}
export const { readPublicFundSummary, readPublicManagerSummary } = createPublicFundReaders();
