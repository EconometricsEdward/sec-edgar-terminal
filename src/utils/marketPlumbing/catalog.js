/** Curated public feeds. DTCC downloads are deliberately NOT ingestion sources:
 * https://www.dtcc.com/terms requires written extraction/redistribution permission. */
export const PLUMBING_VERSION = '1';
export const NYFED_TERMS = 'https://www.newyorkfed.org/privacy/termsofuse';
export function fundingNotice(year) { return `© ${year} Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at ${NYFED_TERMS}. The reference-rate data are subject to those Terms of Use. The New York Fed is not responsible for publication of the reference-rate data by EDGAR Terminal, does not endorse any particular republication, and has no liability for your use.`; }
export const SWAPS_HOME = 'https://www.cftc.gov/MarketReports/SwapsReports/index.htm';
export const SWAPS_NOTES = 'https://www.cftc.gov/MarketReports/SwapsReports/ExplanatoryNotes/index.htm';
export const ASSETS = { rates: 'Interest rate swaps', credit: 'Credit default swaps', fx: 'FX & cross-currency swaps' };
export const MEASURES = { volume: 'Weekly notional traded', outstanding: 'Notional outstanding', tickets: 'Weekly trade count' };
export const TENORS = ['0-3', '3-6', '6-12', '12-24', '24-60', '60+'];
export const SWAP_REPORTS = [
  ['rates', 'outstanding', 'L2IRSGrossExp'], ['rates', 'volume', 'L1INtRatesTransDolVol'], ['rates', 'tickets', 'L2IRSAct'],
  ['credit', 'outstanding', 'L2CDSGrossExp'], ['credit', 'volume', 'L1CreditTransDolVol'], ['credit', 'tickets', 'L2CDSAct'],
  ['fx', 'outstanding', 'L2FXGrossExp'], ['fx', 'volume', 'L1FXDolVol'], ['fx', 'tickets', 'L2FXAct'],
].map(([asset, measure, page]) => ({ asset, measure, url: `https://www.cftc.gov/MarketReports/SwapsReports/${page}.html` }));
export const SWAP_HISTORY_REPORTS = [['outstanding', 'L1GrossExpCS'], ['volume', 'L1TransDollarVolCS'], ['tickets', 'L1ActVolCS']]
  .map(([measure, page]) => ({ measure, url: `https://www.cftc.gov/MarketReports/SwapsReports/${page}.html` }));
export const FUNDING_SOURCES = {
  rates: 'https://markets.newyorkfed.org/api/rates/secured/all/search.json',
  fails: 'https://markets.newyorkfed.org/api/pd/get/SBN2024/timeseries/PDFTD-USTET_PDFTD-UST_PDFTR-USTET_PDFTR-UST.json',
};
export const DTCC_LINKS = [
  { label: 'FICC government securities clearing', detail: '12 months of GSD volume', href: 'https://www.dtcc.com/market-index-data/charts/previous-12-months-volume-for-gsd' },
  { label: 'DTCC GCF Repo Index', detail: 'Treasury & agency MBS repo', href: 'https://www.dtcc.com/market-index-data/charts/dtcc-gcf-repo-index' },
  { label: 'DTCC Treasury trade fails', detail: 'Daily settlement data', href: 'https://www.dtcc.com/market-index-data/charts/daily-total-us-treasury-trade-fails' },
];
export function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function allowedSource(value) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.hash || u.protocol !== 'https:') return false;
    if (u.origin === 'https://markets.newyorkfed.org') return u.href === FUNDING_SOURCES.fails || (u.pathname === new URL(FUNDING_SOURCES.rates).pathname && [...u.searchParams.keys()].every(k => ['startDate','endDate'].includes(k) && u.searchParams.getAll(k).length === 1 && isoDate(u.searchParams.get(k))));
    return [...SWAP_REPORTS, ...SWAP_HISTORY_REPORTS].some(report => report.url === u.href);
  } catch { return false; }
}
export function fundingUrls(now = new Date()) {
  const start = new Date(now); start.setUTCFullYear(start.getUTCFullYear() - 1);
  return { rates: `${FUNDING_SOURCES.rates}?startDate=${start.toISOString().slice(0, 10)}&endDate=${now.toISOString().slice(0, 10)}`, fails: FUNDING_SOURCES.fails };
}
