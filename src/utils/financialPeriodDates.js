const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Historical financial observations cannot end after the filing that reports them.
 * Fiscal-year labels may differ from calendar years; compare actual dates only. */
export function validFinancialPeriodDates(period) {
  return Boolean(period && day(period.end)
    && (period.start == null || day(period.start) && period.start <= period.end)
    && (period.filed == null || day(period.filed) && period.end <= period.filed));
}
