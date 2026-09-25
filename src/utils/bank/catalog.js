import { BankDataError } from './errors.js';
export const CALL_FORMS = new Set(['031', '041', '051']);
export const SCOPE_MAPPING_VERSION = 'ffiec-bankscope-v1';
export function normalizeBankPanel(panel, reportDate, submissions = [], now = new Date().toISOString()) {
  if (!Array.isArray(panel) || panel.length > 15000 || !Array.isArray(submissions)) throw new BankDataError('parsing_failure');
  const dates = new Map(submissions.map(r => [Number(r.ID_RSSD), typeof r.DateTime === 'string' ? r.DateTime.slice(0,100) : null]));
  const seen = new Set(), banks = [];
  for (const source of panel) {
    const form = String(source.FilingType).padStart(3,'0');
    if (!CALL_FORMS.has(form)) continue;
    const rssd = Number(source.ID_RSSD), name = String(source.Name || '').trim();
    if (!Number.isSafeInteger(rssd) || rssd <= 0 || !name || name.length > 300 || seen.has(rssd)) throw new BankDataError('institution_identity_ambiguous');
    seen.add(rssd);
    banks.push({ rssd, name, form, city: String(source.City || '').trim().slice(0,100), state: String(source.State || '').trim().slice(0,10),
      fdic: Number(source.FDICCertNumber) || null, charter: Number(source.OCCChartNumber) || null,
      filed: source.HasFiledForReportingPeriod === true, submission: dates.get(rssd) || null, period: reportDate, verified: now, source });
  }
  if (!banks.length) throw new BankDataError('institution_not_found');
  return banks;
}
export function bankRssd(value) {
  const s = String(value ?? '');
  if (!/^[1-9]\d{0,9}$/.test(s)) throw new BankDataError('invalid_bank', {status:400});
  return Number(s);
}
export function bankSelection(value) {
  const ids = [...new Set(String(value || '').split(',').filter(Boolean).map(bankRssd))];
  if (!ids.length || ids.length > 4) throw new BankDataError('invalid_selection',{status:400});
  return ids;
}
