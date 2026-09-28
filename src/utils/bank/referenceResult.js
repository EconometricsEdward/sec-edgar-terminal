const STATUSES = new Set(['queued', 'running', 'retry', 'ready', 'review', 'unavailable']);
const identity = (value, rssd) => String(value) === String(rssd);

/** Public official-reference envelope. Never admit another bank/date or raw XML. */
export function isBankReferenceResult(body, rssd, period) {
  if (!body || body.error || !identity(body.rssd, rssd) || body.period !== period
    || !body.ubpr || !Object.hasOwn(body.ubpr, 'report')
    || body.ubpr.status !== null && !STATUSES.has(body.ubpr.status)) return false;
  const report = body.ubpr.report;
  if (report === null) return true;
  if (!report || !identity(report.id_rssd, rssd) || report.report_date !== period
    || !/^[a-f0-9]{64}$/.test(report.source_sha256 || '')
    || !Number.isFinite(Date.parse(report.retrieved_at))
    || 'raw_xbrl' in report || 'rawXbrl' in report) return false;
  const data = report.data;
  if (data?.stage === 'source_retained') return true;
  return data?.stage === 'validated' && identity(data.rssd, rssd) && data.period === period
    && typeof data.parserVersion === 'string' && Array.isArray(data.metrics)
    && data.metrics.length > 0 && data.metrics.length <= 50
    && new Set(data.metrics.map(metric => metric?.key)).size === data.metrics.length
    && data.metrics.every(metric => metric && typeof metric.key === 'string'
      && typeof metric.code === 'string' && typeof metric.label === 'string'
      && metric.unit === 'percent'
      && (metric.value === null || typeof metric.value === 'number' && Number.isFinite(metric.value)));
}
