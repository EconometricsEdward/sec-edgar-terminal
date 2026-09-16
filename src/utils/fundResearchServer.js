import { getFundTicker, getOperatingTicker } from "./tickerMap.js";
import { KNOWN_ETFS } from "./knownFunds.js";
import { parseNport, parseFundFeed, portfolioSummary, FUND_CATALOG } from "./fundResearch.js";
import { secFetch } from "./secClient.js";
import { validFilingDate } from "./filingsResearch.js";
import { fundResearchCache, normalizeFundRequest, validPreparedFundData, FUND_MAX_BYTES } from "./fundResearchCache.js";

function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason || new DOMException('Request aborted.', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** The prepared reader never resolves a directory or calls a source. */
export const readPreparedFund = (ticker, accession = '', options = {}) => fundResearchCache.readPrepared(ticker, accession, options);

export function createFundLoader({ fundLookup = getFundTicker, operatingLookup = getOperatingTicker, fetchSec = secFetch,
  cache = fundResearchCache, now = Date.now, maxPending = 4, deadlineMs = 50000 } = {}) {
  const inFlight = new Map();
  async function load(tickerInput, accessionInput = '', { signal } = {}) {
    const { ticker, accession } = normalizeFundRequest(tickerInput, accessionInput);
    signal?.throwIfAborted();
    const key = `${ticker}:${accession || 'LATEST'}`;
    if (inFlight.has(key)) return abortable(inFlight.get(key), signal);
    if (inFlight.size >= maxPending) throw new Error('Several fund reports are already loading. Retry shortly.');
    const deadline = AbortSignal.timeout(deadlineMs);
    const work = (async () => {
      const prepared = await cache.readPrepared(ticker, accession, { signal: deadline, allowStale: false });
      if (prepared) return prepared;
      const checkedAt = new Date(now()).toISOString();
      const data = await buildFund(ticker, accession, deadline, checkedAt);
      if (data.status === 'ready') {
        if (!validPreparedFundData(data, ticker, accession, now())) throw new Error('The N-PORT portfolio could not be fully validated. Open the original SEC filing.');
        await cache.publish(data, { latest: !accession, checkedAt, signal: deadline });
      }
      return data;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return abortable(work, signal);
  }
  async function buildFund(ticker, requestedAccession, signal, checkedAt) {
    let totalBytes = 0;
    async function source(url, kind = 'text', maxBytes = 40_000_000) {
      signal.throwIfAborted();
      const response = await fetchSec(url, { signal, timeoutMs: 25000, retries: 1, maxBytes, cache: 'no-store',
        headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com' } });
      if (!response.ok) throw new Error(`SEC data is temporarily unavailable (HTTP ${response.status}). Please retry.`);
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) { await response.body?.cancel(); throw new Error('This SEC fund document exceeds the supported size. Open the original filing.'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('SEC returned an empty fund document. Retry this request.');
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await abortable(reader.read(), signal);
          if (next.done) break;
          bytes += next.value.byteLength; totalBytes += next.value.byteLength;
          if (bytes > maxBytes || totalBytes > 64 * 1024 * 1024) throw new Error('This SEC fund report exceeds the supported size. Open the original filing.');
          chunks.push(Buffer.from(next.value));
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks, bytes).toString('utf8');
      return kind === 'json' ? JSON.parse(raw) : raw;
    }
    // A trust CIK may contain many portfolios. Preserve SEC series/class identity.
    const fund = await abortable(fundLookup(ticker), signal);
    const lookup = fund || (await abortable(operatingLookup(ticker), signal));
    if (!lookup)
      return {
        ticker,
        isFund: false,
        status: "unavailable",
        reason:
          "Ticker not found in the SEC ticker directories. Try another ticker.",
        holdings: [],
      };
    signal.throwIfAborted();
    const cik = String(lookup.cik || '').padStart(10, '0');
    if (!/^(?!0000000000)\d{10}$/.test(cik) || fund && (!/^S\d{9}$/.test(fund.seriesId) || !/^C\d{9}$/.test(fund.classId)))
      throw new Error('The SEC fund identity could not be verified. Retry this request.');
    const submissions = await source(`https://data.sec.gov/submissions/CIK${cik}.json`, 'json', 16 * 1024 * 1024);
    if (String(submissions.cik || '').padStart(10, '0') !== cik || typeof submissions.name !== 'string'
      || !Array.isArray(submissions.filings?.recent?.form) || !Array.isArray(submissions.filings?.recent?.accessionNumber)
      || !Array.isArray(submissions.filings?.recent?.filingDate)) throw new Error('SEC returned incomplete fund filing metadata. Retry this request.');
    const recent = submissions.filings?.recent || {};
    const filings = (recent.form || []).map((form, i) => ({
      form,
      accession: recent.accessionNumber[i],
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate?.[i],
      primaryDoc: recent.primaryDocument?.[i],
    })).filter(f => /^\d{10}-\d{2}-\d{6}$/.test(f.accession || '') && validFilingDate(f.filingDate));
    const nports = filings.filter((f) => /^NPORT-P(?:\/A)?$/.test(f.form));
    const isFund = Boolean(fund || KNOWN_ETFS.has(ticker) || nports.length);
    const catalog = FUND_CATALOG.find((f) => f.ticker === ticker);
    const base = {
      ticker,
      cik,
      seriesId: fund?.seriesId || null,
      classId: fund?.classId || null,
      isFund,
      name: catalog?.name || submissions.name,
      registrant: submissions.name,
      family: catalog?.family || null,
      status: "unavailable",
      holdings: [],
      secUrl: `https://www.sec.gov/edgar/browse/?CIK=${fund?.seriesId || cik}&owner=exclude`,
    };
    // SEC's series-filtered feed narrows candidates; XML identity is independently checked.
    let candidates = nports;
    if (fund?.seriesId) {
      const feed = await source(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${fund.seriesId}&type=NPORT-P&count=40&output=atom`, 'text', 2 * 1024 * 1024);
      candidates = parseFundFeed(feed).map((f) => ({
        ...f,
        ...nports.find((n) => n.accession === f.accession),
      })).filter(f => validFilingDate(f.filingDate));
    }
    if (!candidates.length)
      return {
        ...base,
        reason:
          "No public N-PORT portfolio is available in the recent SEC records checked. This does not establish that the ticker is an operating company. Other fund structures and report types may have different coverage.",
      };
    // Recent submissions supply report dates; sort by portfolio period, then amendment date.
    candidates.sort(
      (a, b) =>
        (b.reportDate || "").localeCompare(a.reportDate || "") ||
        b.filingDate.localeCompare(a.filingDate) ||
        b.accession.localeCompare(a.accession),
    );
    const selected = requestedAccession
      ? candidates.find((f) => f.accession === requestedAccession)
      : candidates[0];
    if (!selected)
      throw new Error(
        "That filing is outside the recent report list for this fund. Open the latest portfolio.",
      );
    const root = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${selected.accession.replaceAll("-", "")}`;
    const prior = await cache.readPrepared(ticker, selected.accession, { signal });
    const reusable = prior && prior.cik === cik && prior.seriesId === (fund?.seriesId || prior.seriesId)
      && prior.classId === (fund?.classId || null) && prior.form === selected.form && prior.filingDate === selected.filingDate
      && (!selected.reportDate || prior.asOf === selected.reportDate)
      && (!selected.primaryDoc || prior.sourceUrl.endsWith(`/${selected.primaryDoc.split('/').pop()}`));
    let filename = selected.primaryDoc?.split("/").pop();
    if (reusable) filename = prior.sourceUrl.slice(root.length + 1);
    if (!filename?.endsWith(".xml")) {
      const index = await source(`${root}/index.json`, 'json', 2 * 1024 * 1024);
      const names = (index.directory?.item || []).map((i) => i.name);
      filename =
        names.find((n) => n === "primary_doc.xml") ||
        names.find((n) => /nport.*\.xml$/i.test(n));
    }
    if (!filename || !/^[\w][\w.-]{0,239}\.xml$/i.test(filename) || filename.includes('..'))
      throw new Error(
        "The N-PORT XML document could not be located. Open the SEC filing to review it.",
      );
    const sourceUrl = `${root}/${filename}`;
    const portfolio = reusable ? { name: prior.name, registrant: prior.registrant, seriesId: prior.seriesId, cik,
      asOf: prior.asOf, fundInfo: prior.fundInfo, holdings: prior.holdings }
      : parseNport(await source(sourceUrl), { cik, seriesId: fund?.seriesId });
    signal.throwIfAborted();
    const data = {
      ...base,
      ...portfolio,
      status: "ready",
      accession: selected.accession,
      filingDate: selected.filingDate,
      form: selected.form,
      sourceUrl,
      filingUrl: `${root}/${selected.accession}-index.html`,
      retrievedAt: reusable ? prior.retrievedAt : checkedAt,
      identity: fund?.seriesId ? "SEC series matched" : "SEC registrant matched",
      reports: candidates
        .slice(0, 20)
        .map((f) => ({
          accession: f.accession,
          filingDate: f.filingDate,
          reportDate:
            f.accession === selected.accession
              ? portfolio.asOf
              : f.reportDate || null,
          form: f.form,
        })),
      filings: filings
        .filter((f) => /^(N-|NPORT|485|497)/.test(f.form))
        .slice(0, 12)
        .map((f) => ({
          ...f,
          url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accession.replaceAll("-", "")}/${f.accession}-index.html`,
        })),
    };
    if (!data.reports.some(report => report.accession === data.accession)) data.reports.push({ accession: data.accession,
      filingDate: data.filingDate, reportDate: data.asOf, form: data.form });
    data.summary = portfolioSummary(data);
    if (Buffer.byteLength(JSON.stringify(data)) > FUND_MAX_BYTES - 2048) throw new Error('This fund portfolio exceeds the supported size. Open the original SEC filing.');
    return data;
  }
  return load;
}

export const loadFund = createFundLoader();
