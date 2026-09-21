import { createTickerDirectoryCache } from './tickerMap.js';
import { createReportSearch } from './reportSearchServer.js';
import { buildCompanyReport } from './companyReport.js';
import { buildNportReport, buildThirteenFReport } from './fundReport.js';
import { normalizeReportRequest, reportMatchesSelection } from './reportRequest.js';
import { enrichCompanyReportCftc, createReportCompanyExposureDiscovery } from './companyReportCftc.js';
import { createMarketReportLoader } from './marketReport.js';

const ORIGIN = 'https://secedgarterminal.com';
const MAX_BYTES = 40 * 1024 * 1024;
const fail = (message, status = 502) => Object.assign(new Error(message), { status, code: 'REPORT_PREVIEW_SOURCE' });

/** A preview is an ordinary anonymous reader of existing public GET routes.
 * It never acquires database credentials, alters datastore deployment policy,
 * forwards request headers or calls the shared outbound SEC gate directly. */
export function usesPublicReportSources(env = process.env) {
  return env.VERCEL_ENV === 'preview';
}

/** Translate only the SEC documents needed by reports into the existing public
 * SEC reader. No arbitrary URL, endpoint, redirect or query is accepted. */
export function reportPreviewSecUrl(input) {
  const source = new URL(input);
  if (source.protocol !== 'https:' || !['www.sec.gov', 'data.sec.gov'].includes(source.hostname)
    || source.username || source.password || source.port || source.hash || /%|\\|\.\./.test(source.pathname))
    throw fail('This report source is outside the public preview allowlist.', 400);
  let path = source.pathname;
  const plain = !source.search && (source.hostname === 'www.sec.gov'
    ? /^\/files\/company_tickers(?:_mf)?\.json$/.test(path)
      || /^\/Archives\/edgar\/data\/[1-9]\d{0,9}\/\d{18}\/[\w][\w.-]{0,239}\.(?:xml|json|htm|html|txt)$/i.test(path)
    : /^\/submissions\/CIK(?!0000000000)\d{10}(?:-submissions-\d+)?\.json$/.test(path)
      || /^\/api\/xbrl\/companyfacts\/CIK(?!0000000000)\d{10}\.json$/.test(path));
  if (!plain) {
    const p = source.searchParams;
    if (source.hostname !== 'www.sec.gov' || path !== '/cgi-bin/browse-edgar'
      || [...p.keys()].some(key => !['action', 'CIK', 'scname', 'view', 'scd', 'count', 'type', 'output'].includes(key))
      || [...p.keys()].some(key => p.getAll(key).length !== 1) || p.get('action') !== 'getcompany')
      throw fail('This report source is outside the public preview allowlist.', 400);
    const identity = p.get('CIK');
    const validIdentity = /^(?:(?!0000000000)\d{10}|[SC]\d{9})$/.test(identity || '');
    const nameSearch = p.get('view') === 'mutual-fund' && p.get('scd') === 'series' && p.get('count') === '100'
      && !p.has('type') && !p.has('output') && (validIdentity && !p.has('scname') || !p.has('CIK') && /^[A-Za-z0-9.-]{1,160}$/.test(p.get('scname') || ''));
    const seriesFeed = /^S\d{9}$/.test(identity || '') && p.get('type') === 'NPORT-P' && p.get('count') === '40'
      && p.get('output') === 'atom' && !['view', 'scd', 'scname'].some(key => p.has(key));
    if (!nameSearch && !seriesFeed) throw fail('This report source query is outside the public preview allowlist.', 400);
    path += source.search;
  }
  const url = new URL('/api/sec', ORIGIN);
  url.search = new URLSearchParams({ host: source.hostname === 'www.sec.gov' ? 'www' : 'data', path }).toString();
  return url;
}

async function boundedResponse(response, maxBytes, signal) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw fail('This public preview source exceeds the supported size.', 413);
  }
  const reader = response.body?.getReader();
  if (!reader) throw fail('The public preview source was empty. Retry this report.');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw fail('This public preview source exceeds the supported size.', 413);
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return new Response(Buffer.concat(chunks, bytes), { status: response.status, headers: response.headers });
}

export function createPublicReportSources({ fetchPublic = fetch, now = Date.now } = {}) {
  async function request(url, { signal, maxBytes = MAX_BYTES, timeoutMs = 85000 } = {}) {
    if (url.origin !== ORIGIN || !['/api/sec', '/api/sec-filers', '/api/analysis-research', '/api/fund-13f', '/api/reports/prepare',
      '/api/market-research', '/api/v1/cftc/markets', '/api/v1/cftc/company-exposures', '/api/v1/cftc/history'].includes(url.pathname))
      throw fail('This report endpoint is outside the public preview allowlist.', 400);
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.min(timeoutMs, url.pathname === '/api/reports/prepare' ? 280000 : 90000))]);
    deadline.throwIfAborted();
    const response = await fetchPublic(url.href, { method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { Accept: 'application/json, text/plain, text/html, application/xml' }, cache: 'no-store', signal: deadline });
    if (!response.ok) {
      await response.body?.cancel();
      throw fail(`The public research source is temporarily unavailable (HTTP ${response.status}). Retry this report.`,
        [404, 429, 503].includes(response.status) ? response.status : 502);
    }
    return boundedResponse(response, Math.min(maxBytes, MAX_BYTES), deadline);
  }
  const endpoint = (path, params) => {
    const url = new URL(path, ORIGIN); url.search = new URLSearchParams(params).toString(); return url;
  };
  const fetchSec = (url, options = {}) => request(reportPreviewSecUrl(url), options);
  const directories = createTickerDirectoryCache({ fetchSec, read: async () => null, write: async () => {}, now });
  const search = createReportSearch({ operatingDirectory: () => directories.get('operating'), fundDirectory: () => directories.get('funds'), now,
    filerSearch: async query => (await request(endpoint('/api/sec-filers', { query }), { timeoutMs: 25000 })).json(),
    fetchSec: (input, options) => {
      const url = new URL(input), query = url.searchParams.get('scname');
      // The existing public reader's path syntax cannot encode spaces. Search
      // one distinctive word, then preserve the ordinary all-word name filter.
      if (query && !/^[A-Za-z0-9.-]+$/.test(query)) {
        const words = query.normalize('NFKD').replace(/\p{M}/gu, '').match(/[A-Za-z0-9]+/g) || [];
        const word = words.sort((a, b) => b.length - a.length)[0];
        if (!word) throw fail('For this preview, use the fund ticker or exact SEC series ID.', 400);
        url.searchParams.set('scname', word);
      }
      return fetchSec(url.href, options);
    } });

  async function searchReports(input) {
    const result = await search(input);
    if (input.kind === 'nport' && !/^[A-Za-z0-9.-]+$/.test(input.query)) {
      const warning = 'Preview name search scans the SEC results for one distinctive word, then matches the full name. Refine the name or use the ticker/series ID if a fund is missing.';
      return { ...result, warning: [result.warning, warning].filter(Boolean).join(' '), warnings: [...(result.warnings || []), warning] };
    }
    return result;
  }

  async function prepareReport(input, signal) {
    const selection = normalizeReportRequest(new URLSearchParams(input));
    const { kind, id, basis } = selection;
    const clocks = [];
    const trackedSec = async (url, options) => {
      const response = await fetchSec(url, { ...options, signal: AbortSignal.any([...(signal ? [signal] : []), ...(options?.signal ? [options.signal] : [])]) });
      clocks.push(response.headers); return response;
    };
    let report, preparedPublicCompany = false;
    if (kind === 'market') {
      const load = createMarketReportLoader({ now,
        loadOverview: async ({ signal: s }) => (await request(endpoint('/api/market-research', {}), { signal: s, timeoutMs: 45000 })).json(),
        loadCftcMarkets: async ({ family, signal: s }) => (await request(endpoint('/api/v1/cftc/markets', { family }), { signal: s, timeoutMs: 45000 })).json(),
      });
      report = await load({ basis }, signal);
    } else if (kind === 'company' && !/^\d+$/.test(id)) {
      const response = await request(endpoint('/api/analysis-research', { ticker: id, basis }), { signal });
      const analysis = await response.json();
      if (analysis?.ticker !== id || analysis?.basis !== basis) throw fail('The public financial model did not match this company and reporting basis.');
      report = buildCompanyReport(analysis, { generatedAt: new Date(now()).toISOString(), sourceSnapshot: {
        metadata: { fetchedAt: response.headers.get('X-Data-Fetched-At'), revalidatedAt: response.headers.get('X-Data-Revalidated-At') },
        stale: response.headers.get('X-Data-Stale') === 'true' } });
    } else if (kind === 'company') {
      // The public production preparation route owns exact-CIK discovery and
      // both XBRL and PDF-only annual-report analysis. Preview remains an
      // anonymous reader and cannot silently force a PDF filer through XBRL.
      report = await (await request(endpoint('/api/reports/prepare', { kind, id, basis }), { signal, timeoutMs: 280000 })).json();
      if (!reportMatchesSelection(report, selection) || String(report.entity.cik).padStart(10, '0') !== id.padStart(10, '0'))
        throw fail('The public company report did not match the selected SEC registrant and reporting basis.');
      preparedPublicCompany = true;
    } else if (kind === '13f') {
      const data = await (await request(endpoint('/api/fund-13f', { cik: id, delivery: 'full' }), { signal })).json();
      if (data?.manager?.cik !== id) throw fail('The public holdings response did not match the selected manager.');
      const { valid13FDelivery } = await import('./thirteenFDelivery.js');
      if (data.status === 'ready' && !valid13FDelivery(data, { mode: 'full' })) throw fail('The public manager response did not include its complete holdings.');
      report = buildThirteenFReport(data, { generatedAt: new Date(now()).toISOString() });
    } else {
      const { createFundResearchCache } = await import('./fundResearchCache.js');
      const cache = createFundResearchCache({ enabled: () => false, now, maxLocalBytes: 32 * 1024 * 1024, maxLocalEntries: 2 });
      let load;
      if (/^S\d{9}$/.test(id)) {
        const { createReportSeriesFundLoader } = await import('./reportFundSeriesServer.js');
        load = createReportSeriesFundLoader({ fetchSec: trackedSec, cache, now });
      } else {
        const { createFundLoader } = await import('./fundResearchServer.js');
        load = createFundLoader({ fetchSec: trackedSec, cache, now, deadlineMs: 85000,
          fundLookup: async ticker => (await directories.get('funds'))[ticker] || null,
          operatingLookup: async ticker => (await directories.get('operating'))[ticker] || null });
      }
      report = buildNportReport(await load(id, '', { signal }), { generatedAt: new Date(now()).toISOString() });
    }
    if (kind === 'company' && !preparedPublicCompany) report = await enrichCompanyReportCftc(report, { signal, now,
      loadContext: async ({ cik }, { signal: s }) => {
        const ticker = report.entity.ticker && !/^\d+$/.test(report.entity.ticker) ? report.entity.ticker
          : Object.entries(await directories.get('operating')).find(([, entry]) => String(entry.cik).padStart(10, '0') === cik)?.[0];
        if (!ticker) return createReportCompanyExposureDiscovery({ fetchSec: trackedSec, now })({ cik, asOf: null }, { signal: s });
        return (await request(endpoint('/api/v1/cftc/company-exposures', { ticker }), { signal: s, timeoutMs: 22000 })).json();
      },
      loadHistory: async ({ family, code, group, reportDate, window, signal: s }) =>
        (await request(endpoint('/api/v1/cftc/history', { family, contract: code, group, date: reportDate, window }), { signal: s, timeoutMs: 22000 })).json(),
    });
    if (!reportMatchesSelection(report, selection)) throw fail('The public report did not match the selected entity.');
    if (clocks.some(headers => headers.get('X-Data-Stale') === 'true')) {
      report.coverage.status = 'partial';
      report.notes.push('A public source was marked stale. The retained figures may not include the newest filing or amendment.');
    }
    report.notes.push('Preview source delivery: existing public EDGAR Terminal research endpoints. Public cache delivery time does not establish when the underlying records were last revalidated. Original public source links remain in the PDF report.');
    return report;
  }
  return { searchReports, prepareReport };
}

const preview = createPublicReportSources();
export const searchPublicReportSources = preview.searchReports;
export const preparePublicReportSources = preview.prepareReport;
