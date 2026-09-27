const quarter = value => typeof value === 'string' && /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(value);
const rssd = value => /^[1-9]\d{0,9}$/.test(String(value));
const list = (value, max, check) => Array.isArray(value) && value.length <= max && value.every(check);
const unique = values => new Set(values).size === values.length;
const JOB_STATUSES = new Set(['queued', 'running', 'retry', 'ready', 'review', 'unavailable']);
const PENDING = new Set(['queued', 'running', 'retry']);

/** Ordered selection is part of the identity: the first bank remains the selected bank. */
export function bankReadSelection(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => key !== 'rssds')
    || !list(payload.rssds, 4, rssd) || !payload.rssds.length) return null;
  const ids = payload.rssds.map(Number);
  return unique(ids) ? ids : null;
}

/** Validate the public read envelope and its bank/period/source identities before reuse. */
export function isBankReadResult(data, ids) {
  if (!data || data.error || data.code || data.unavailable
    || !list(data.periods, 4, quarter) || !unique(data.periods)) return false;
  const belongs = row => row && ids.includes(Number(row.id_rssd));
  const inPeriod = row => belongs(row) && data.periods.includes(row.report_date);
  if (!list(data.banks, ids.length, bank => belongs(bank)
    && typeof bank.legal_name === 'string' && bank.legal_name.trim().length > 0
    && list(bank.available_periods, 4, period => data.periods.includes(period)))
    || !unique(data.banks.map(bank => Number(bank.id_rssd)))) return false;
  if (!list(data.reports, ids.length * 4, report => inPeriod(report)
    && data.banks.some(bank => Number(bank.id_rssd) === Number(report.id_rssd))
    && /^[a-f0-9]{64}$/.test(report.source_sha256 || '')
    && typeof report.validation?.passed === 'boolean'
    && Number.isFinite(Date.parse(report.retrieved_at))
    && list(report.metrics, 100, metric => metric && typeof metric.key === 'string'
      && Number(metric.rssd) === Number(report.id_rssd) && metric.reportDate === report.report_date
      && (metric.value === null || typeof metric.value === 'number' && Number.isFinite(metric.value))))) return false;
  if (!unique(data.reports.map(report => `${report.id_rssd}:${report.report_date}`))) return false;
  return list(data.jobs, ids.length * 4, job => inPeriod(job) && JOB_STATUSES.has(job.status))
    && unique(data.jobs.map(job => `${job.id_rssd}:${job.report_date}`));
}

export function bankReadTtl(data, ids) {
  // Unprepared/missing banks and changing queue states need a quick fresh read,
  // including when a preparation request lands on another server instance.
  const ready = data.banks.length === ids.length && data.banks.every(bank => bank.available_periods.length > 0
    && bank.available_periods.every(period => data.reports.some(report => Number(report.id_rssd) === Number(bank.id_rssd)
      && report.report_date === period && report.validation.passed)));
  return ready && !data.jobs.some(job => PENDING.has(job.status)) ? 30000 : 3000;
}
