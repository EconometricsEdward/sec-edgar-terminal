import { BankDataError } from './errors.js';
export const PILOT_BANKS = Object.freeze([
  { key: 'jpmorgan', name: 'JPMorgan Chase Bank, National Association' },
  { key: 'bank-of-america', name: 'Bank of America, National Association' },
  { key: 'wells-fargo', name: 'Wells Fargo Bank, National Association' },
]);
const normalizedName = value => String(value || '').toUpperCase().replace(/\bN\.?\s*A\.?$/i, 'NATIONAL ASSOCIATION').replace(/[^A-Z0-9]/g, '');
export function verifyPanel(panel, reportDate) {
  if (!Array.isArray(panel)) throw new BankDataError('parsing_failure');
  return PILOT_BANKS.map(bank => {
    const matches = panel.filter(row => normalizedName(row.Name) === normalizedName(bank.name));
    if (!matches.length) throw new BankDataError('institution_not_found');
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].ID_RSSD) || matches[0].ID_RSSD <= 0) throw new BankDataError('institution_identity_ambiguous');
    const row = matches[0];
    if (String(row.FilingType).padStart(3, '0') !== '031') throw new BankDataError('unsupported_call_report_form');
    return { key: bank.key, rssd: row.ID_RSSD, legalName: row.Name, fdicCertificate: row.FDICCertNumber || null,
      charter: row.OCCChartNumber || null, status: 'listed_in_call_report_panel', reportDate,
      filed: row.HasFiledForReportingPeriod === true, verifiedAt: new Date().toISOString(), source: row };
  });
}
export function isoDate(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const iso = m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : String(value);
  if (!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(iso)) throw new BankDataError('reporting_period_unavailable');
  return iso;
}
export function apiDate(iso) { return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`; }
export function latestPeriods(response, now = new Date()) {
  if (!Array.isArray(response)) throw new BankDataError('parsing_failure');
  const periods = [...new Set(response.map(isoDate))].filter(p => p <= now.toISOString().slice(0, 10)).sort().reverse().slice(0, 4);
  if (!periods.length) throw new BankDataError('reporting_period_unavailable'); return periods;
}
