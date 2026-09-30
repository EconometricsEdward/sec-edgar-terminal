// A client-only contract check; no issuer requests or financial calculations.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nullableNumber = value => value === null || finite(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const cik = value => typeof value === 'string' && /^\d{1,10}$/.test(value) && Number(value) > 0;
const sameCik = (a, b) => cik(a) && cik(b) && Number(a) === Number(b);
const tickerKey = value => typeof value === 'string' ? value.toUpperCase().replaceAll('.', '-') : null;

function source(value) {
  if (value === null) return true;
  if (!text(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.sec.gov', 'sec.gov'].includes(url.hostname)
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

function report(value, required = false) {
  if (value === null) return !required;
  return record(value) && date(value.end) && (value.filed === null || date(value.filed))
    && (value.form === null || text(value.form, 20)) && (value.accession === null || text(value.accession, 40))
    && (!required || date(value.filed) && value.filed >= value.end && text(value.form, 20) && text(value.accession, 40));
}

function issuer(value, requireReport = false) {
  return record(value) && text(value.ticker, 32) && cik(value.cik) && text(value.name, 300)
    && report(value.report, requireReport) && source(value.sourceUrl)
    && (!requireReport || value.sourceUrl !== null);
}

/** Prevent stale issuer/basis data or malformed missing values from reaching peer charts. */
export function matchesRiskPeerResponse(body, ticker, basis = 'ttm', group = 'industry', expectedCik) {
  try {
    if (!record(body) || body.version !== 'risk-peers-v1' || body.ticker !== ticker || body.basis !== basis
      || body.groupMode !== group || !['ttm', 'annual'].includes(basis) || !['industry', 'model'].includes(group)
      || !['ready', 'uncovered', 'insufficient'].includes(body.status) || typeof body.stale !== 'boolean'
      || !text(body.generatedAt, 40) || !Number.isFinite(Date.parse(body.generatedAt))
      || !record(body.group)
      || ![['id', 100], ['label', 300], ['method', 2_000]].every(([key, max]) => text(body.group[key], max)
        || body.status === 'uncovered' && body.group[key] === '')
      || !['candidates', 'eligible', 'dateWindowDays', 'minPeers'].every(key => count(body.group[key]))
      || body.group.minPeers < 1 || !Array.isArray(body.metrics) || body.metrics.length > 8
      || !record(body.exclusions) || !Object.values(body.exclusions).every(count)
      || !Array.isArray(body.limitations) || !body.limitations.every(item => text(item, 2_000))) return false;
    if (body.subject !== null && (!issuer(body.subject) || tickerKey(body.subject.ticker) !== tickerKey(ticker)
      || expectedCik !== undefined && !sameCik(body.subject.cik, expectedCik))) return false;
    if (body.status === 'uncovered') return body.metrics.length === 0;
    if (!issuer(body.subject, true) || body.metrics.length === 0) return false;
    const ids = new Set();
    for (const metric of body.metrics) {
      if (!record(metric) || !text(metric.id, 100) || ids.has(metric.id) || !text(metric.label, 200)
        || !['pct', 'ratio'].includes(metric.format) || !text(metric.formula, 2_000)
        || !nullableNumber(metric.value) || !count(metric.count) || typeof metric.available !== 'boolean'
        || metric.reason !== null && !text(metric.reason, 1_000)
        || !['min', 'q1', 'median', 'q3', 'max', 'percentile'].every(key => nullableNumber(metric[key]))
        || !Array.isArray(metric.peers) || metric.peers.length > 60 || metric.peers.length > metric.count
        || metric.plottedCount !== undefined && (!count(metric.plottedCount) || metric.plottedCount !== metric.peers.length)) return false;
      ids.add(metric.id);
      if (metric.available) {
        if (!finite(metric.value) || metric.count < body.group.minPeers
          || !['min', 'q1', 'median', 'q3', 'max', 'percentile'].every(key => finite(metric[key]))
          || metric.min > metric.q1 || metric.q1 > metric.median || metric.median > metric.q3 || metric.q3 > metric.max
          || metric.percentile < 0 || metric.percentile > 100 || metric.peers.length === 0) return false;
      } else if (!['min', 'q1', 'median', 'q3', 'max', 'percentile'].every(key => metric[key] === null)) return false;
      const peerCiks = new Set();
      for (const peer of metric.peers) {
        if (!issuer(peer, true) || !finite(peer.value) || sameCik(peer.cik, body.subject.cik)
          || peerCiks.has(Number(peer.cik))
          || Math.abs(Date.parse(peer.report.end) - Date.parse(body.subject.report.end)) / 86_400_000 > body.group.dateWindowDays) return false;
        peerCiks.add(Number(peer.cik));
      }
    }
    return body.status === 'ready' ? body.metrics.some(metric => metric.available) : body.metrics.every(metric => !metric.available);
  } catch { return false; }
}
