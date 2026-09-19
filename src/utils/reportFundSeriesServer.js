import { createFundLoader } from './fundResearchServer.js';
import { createFundResearchCache } from './fundResearchCache.js';
import { parseReportFundSearch } from './reportSearchServer.js';
import { secFetch } from './secClient.js';

const SERIES = /^S\d{9}$/;
const fail = (message, status = 422) => Object.assign(new Error(message), { status, code: 'NPORT_SERIES_UNAVAILABLE' });

/** Dedicated preview cache: series IDs never become aliases in the ordinary
 * ticker cache. Reuse the same bounded body/hash/identity validation locally. */
export function createReportSeriesFundLoader({ fetchSec = secFetch, now = Date.now,
  cache = createFundResearchCache({ enabled: () => false, maxLocalBytes: 32 * 1024 * 1024, maxLocalEntries: 24, now }) } = {}) {
  async function fundLookup(seriesId) {
    if (!SERIES.test(seriesId)) throw fail('Enter an exact SEC fund series ID, such as S000006027.', 400);
    const url = new URL('https://www.sec.gov/cgi-bin/browse-edgar');
    url.search = new URLSearchParams({ action: 'getcompany', CIK: seriesId, view: 'mutual-fund', scd: 'series', count: '100' }).toString();
    const response = await fetchSec(url.href, { signal: AbortSignal.timeout(20000), timeoutMs: 18000, retries: 1,
      maxBytes: 2 * 1024 * 1024, cache: 'no-store',
      headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com' } });
    if (!response.ok) throw fail(`SEC fund-series lookup is temporarily unavailable (HTTP ${response.status}). Retry the report.`, 502);
    const parsed = parseReportFundSearch(await response.text());
    const exact = parsed.series.filter(item => item.seriesId === seriesId);
    if (exact.length !== 1) throw fail('This SEC series could not be matched to one registrant. Select another fund or retry the exact series.');
    return { cik: exact[0].cik, seriesId, classId: null };
  }
  const load = createFundLoader({ fundLookup, operatingLookup: async () => null, fetchSec, cache, now,
    allowSeriesIdentity: true, maxPending: 2, deadlineMs: 70000 });
  return async (seriesId, accession = '', options = {}) => {
    const normalized = typeof seriesId === 'string' ? seriesId.trim().toUpperCase() : '';
    if (!SERIES.test(normalized)) throw fail('Choose an exact SEC fund series ID.', 400);
    return load(normalized, accession, options);
  };
}

export const loadReportSeriesFund = createReportSeriesFundLoader();
