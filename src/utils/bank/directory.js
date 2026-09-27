/** Shared shape check for a public directory snapshot, independent of its cache or transport. */
export function isBankDirectory(data) {
  return !!data && !data.unavailable
    && Number.isSafeInteger(data.bankCount) && data.bankCount >= 0
    && Array.isArray(data.periods) && data.periods.length <= 4
    && data.periods.every(period => typeof period === 'string' && /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(period))
    && Array.isArray(data.banks) && data.banks.length <= 25 && data.banks.length <= data.bankCount
    && data.banks.every(bank => bank && /^[1-9]\d{0,9}$/.test(String(bank.id_rssd))
      && typeof bank.legal_name === 'string' && bank.legal_name.trim().length > 0
      && [bank.city, bank.state].every(value => value == null || typeof value === 'string')
      && Number.isSafeInteger(bank.prepared_quarters) && bank.prepared_quarters >= 0 && bank.prepared_quarters <= 4);
}
