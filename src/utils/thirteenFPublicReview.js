import { thirteenFMarketBenchmark } from './thirteenFMarketConnections.js';
import { publicManagerSelection } from './fundPublicSelectors.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 20000;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = (value, length = 240) => typeof value === 'string' ? value.slice(0, length) : '';
const share = value => finite(value) && value >= 0 && value <= 100.000001 ? value : null;

/** A citation must identify the original issuer accession, not just an SEC hostname. */
export function publicReviewSource(source, issuerCik, checkedAt) {
  if (!/^\d{10}$/.test(issuerCik || '') || Number(issuerCik) <= 0
    || !/^\d{10}-\d{2}-\d{6}$/.test(source?.accession || '')
    || !['10-K', '20-F', '40-F', '10-Q'].includes(source.form)
    || !date(source.filed) || !date(source.reportDate) || source.reportDate > source.filed
    || !timestamp(checkedAt) || source.filed > checkedAt.slice(0, 10)) return null;
  const prefix = `https://www.sec.gov/Archives/edgar/data/${Number(issuerCik)}/${source.accession.replaceAll('-', '')}/`;
  if (typeof source.url !== 'string' || !source.url.startsWith(prefix)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:htm|html|txt)$/i.test(source.url.slice(prefix.length))) return null;
  return { url: source.url, accession: source.accession, form: source.form, filed: source.filed, reportDate: source.reportDate };
}

/** A bounded presentation of the exact published aggregates. No recalculation of
 * coverage from the first page, no upstream requests and no inferred exposures. */
export function public13FReview(snapshot, { cik, period = '', now = Date.now() }) {
  const job = snapshot?.job, report = snapshot?.report, coverage = snapshot?.coverage;
  if (!job || !report || !coverage || job.cik !== cik || report.cik !== cik || job.period !== report.period
    || !/^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(report.period || '') || !date(report.period)
    || report.period > new Date(now).toISOString().slice(0, 10) || period && report.period !== period
    || !count(coverage.total) || coverage.total !== job.total || !count(coverage.checked) || coverage.checked > coverage.total
    || !count(coverage.linked) || coverage.linked > coverage.checked
    || !Array.isArray(snapshot.markets) || snapshot.markets.length > 40
    || !Array.isArray(snapshot.rows) || snapshot.rows.length > 50
    || !timestamp(snapshot.publishedAt) || Date.parse(snapshot.publishedAt) > now + 60000) return null;
  const denominator = report.complete === true && job.portfolioComplete === true
    && job.coverage?.selectedPeriodComplete === true && finite(job.denominatorUsd) && job.denominatorUsd > 0
    && job.denominatorUsd === report.totalValueUsd ? job.denominatorUsd : null;
  const marketKeys = new Set();
  const markets = snapshot.markets.flatMap(market => {
    const benchmark = thirteenFMarketBenchmark(market);
    if (!benchmark || market.key !== `${benchmark.family}:${benchmark.contract}:${benchmark.group}`
      || marketKeys.has(market.key) || !count(market.holdingCount) || market.holdingCount > coverage.linked) return [];
    marketKeys.add(market.key);
    return [{ key: market.key, label: benchmark.label, count: market.holdingCount,
      sharePct: denominator === null ? null : share(market.sharePct) }];
  });
  const examples = snapshot.rows.flatMap(row => {
    if (!['linked', 'partial'].includes(row?.status) || !row.checked || !Array.isArray(row.markets)
      || !timestamp(row.checkedAt) || Date.parse(row.checkedAt) > now + 60000) return [];
    const rowMarkets = row.markets.filter(market => marketKeys.has(market.key) && thirteenFMarketBenchmark(market))
      .map(market => ({ label: market.label, fit: market.fit === 'named-reference' ? 'Named reference' : 'Research proxy' }));
    const urls = new Set();
    const sources = (Array.isArray(row.sources) ? row.sources.slice(0, 3) : []).flatMap(source => {
      const verified = publicReviewSource(source, row.issuer?.cik, row.checkedAt);
      if (!verified || urls.has(verified.url)) return [];
      urls.add(verified.url); return [verified];
    });
    if (!sources.length || !rowMarkets.length) return [];
    return [{ key: text(row.holding?.key, 80), name: text(row.issuer?.name || row.holding?.issuer),
      markets: rowMarkets.slice(0, 4), sources, checkedAt: row.checkedAt,
      stale: row.stale === true || row.preservedPrevious === true }];
  }).slice(0, 3);
  const coverageCount = key => count(coverage[key]) && coverage[key] <= coverage.total ? coverage[key] : null;
  return {
    cik, period: report.period, managerName: text(report.managerName),
    publicationVersion: text(snapshot.publicationVersion, 100), publishedAt: snapshot.publishedAt,
    observedAt: timestamp(report.observedAt) ? report.observedAt : null,
    checkedAt: timestamp(job.reportCheckedAt) ? job.reportCheckedAt : null,
    state: text(job.state, 40), denominatorUsd: denominator,
    coverage: { total: coverage.total, checked: coverage.checked, linked: coverage.linked,
      reviewed: coverageCount('reviewed'), available: coverageCount('available'), unchecked: coverageCount('unchecked'),
      unresolved: coverageCount('unresolved'), unavailable: coverageCount('unavailable'), partial: coverageCount('partial'),
      stale: coverageCount('stale'), linkedSharePct: denominator === null ? null : share(coverage.linkedSharePct) },
    markets, examples,
    interactiveUrl: `/fund?view=13f&managerCik=${cik}&managerPeriod=${report.period}&managerView=markets`,
    jsonUrl: `/api/fund-13f/market-review?cik=${cik}&view=snapshot&period=${report.period}`,
  };
}

/** Small process cache of the display projection, never every saved holding.
 * Entries, bytes and concurrent reads are bounded independently of URL variety. */
export function createPublic13FReviewReader({ read = async (_selection, _options) => null, now = Date.now, maxEntries = 16,
  maxBytes = 256 * 1024, budgetMs = 2000, ttlMs = 60000 } = {}) {
  const entries = new Map(), pending = new Map();
  let bytes = 0;
  function remove(key) { const entry = entries.get(key); if (entry) bytes -= entry.bytes; entries.delete(key); }
  return async function readReview(cik, period = '') {
    const selected = publicManagerSelection(cik, period, now());
    if (!selected || selected.cik !== cik) return null;
    const key = `${cik}:${period}`;
    for (const [name, entry] of entries) if (entry.expires <= now()) remove(name);
    const hit = entries.get(key);
    if (hit) { entries.delete(key); entries.set(key, hit); return hit.model; }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxEntries) return null;
    const task = (async () => {
      const controller = new AbortController(); let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, budgetMs); });
      try {
        const saved = await Promise.race([deadline, Promise.resolve().then(() => read({ cik, period: period || null }, {
          signal: controller.signal, timeoutMs: budgetMs,
        })).catch(() => null)]);
        if (controller.signal.aborted) return null;
        const model = public13FReview(saved, { cik, period, now: now() });
        if (!model) return null;
        const size = new TextEncoder().encode(JSON.stringify(model)).byteLength;
        if (size <= maxBytes) {
          while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes)) remove(entries.keys().next().value);
          entries.set(key, { model, bytes: size, expires: now() + ttlMs }); bytes += size;
        }
        return model;
      } finally { clearTimeout(timer); }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}
