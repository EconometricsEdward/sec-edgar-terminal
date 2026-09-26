export const EXPOSURE_VERSION = 'call-exposures-1';
export const CREDIT_SEGMENTS = [
  { key: 'construction', label: 'Construction & land', color: '#f5bc68', note: 'Residential construction, other construction, land development and other land loans. RC-C I 1.a.' },
  { key: 'cre', label: 'Commercial real estate', color: '#ac9bff', note: 'Multifamily and owner-occupied and other nonfarm nonresidential property loans. Excludes construction and farmland. This is a portfolio grouping, not the regulatory CRE concentration definition. RC-C I 1.d–e.' },
  { key: 'residential', label: 'Residential mortgages', color: '#65c9ef', note: 'Revolving home-equity credit and first- and junior-lien loans secured by 1–4 family residential properties. RC-C I 1.c.' },
  { key: 'commercial', label: 'Commercial & industrial', color: '#71d8b3', note: 'Commercial and industrial loans to U.S. and non-U.S. addressees. RC-C I 4.' },
  { key: 'consumer', label: 'Consumer lending', color: '#f58f9f', note: 'Credit cards, other revolving credit, auto loans and other consumer loans. Excludes residential mortgages. RC-C I 6.' },
  { key: 'other', label: 'Other loans & leases', color: '#889bb6', note: 'Residual: total domestic loans and leases less the five displayed categories. Includes farmland, agricultural, financial-institution and other loans, leases and unallocated unearned-income adjustments. Its credit performance cannot be isolated consistently across forms.' },
];
export const EXPOSURE_LENSES = ['credit', 'funding', 'securities'];
export const finite = value => typeof value === 'number' && Number.isFinite(value);
export const exposureRatio = (a, b) => finite(a) && finite(b) && b > 0 ? a / b * 100 : null;
export function priorExposurePeriod(date) {
  const d = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return '';
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 0)).toISOString().slice(0, 10);
}
export function exposureChange(current, prior) {
  return finite(current) && finite(prior) && prior > 0 ? (current / prior - 1) * 100 : null;
}

