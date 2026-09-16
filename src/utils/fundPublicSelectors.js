/** Pure selectors shared by public HTML and read-only JSON endpoints. */
export const PUBLIC_FUND_MANAGERS = Object.freeze([
  { cik: '0001350694', name: 'Bridgewater Associates' },
  { cik: '0001067983', name: 'Berkshire Hathaway' },
  { cik: '0001037389', name: 'Renaissance Technologies' },
  { cik: '0001747057', name: 'D1 Capital' },
]);

export function publicFundSelection(ticker, accession = '') {
  if (typeof ticker !== 'string' || typeof accession !== 'string') return null;
  const normalized = ticker.toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(normalized)
    || accession && !/^\d{10}-\d{2}-\d{6}$/.test(accession)) return null;
  return { ticker: normalized, accession };
}

export function publicManagerSelection(cik, period = '', now = Date.now()) {
  if (typeof cik !== 'string' || !/^\d{1,10}$/.test(cik) || Number(cik) <= 0
    || typeof period !== 'string' || period && (!/^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(period)
      || Number(period.slice(0, 4)) <= 0 || period > new Date(now).toISOString().slice(0, 10))) return null;
  return { cik: cik.padStart(10, '0'), period };
}
