const RISK_VIEWS = new Set(['overview', 'exposures', 'cftc', 'fcm']);

export function normalizeRiskBasis(value) {
  return value === 'annual' ? 'annual' : 'ttm';
}

export function normalizeRiskView(value, cftcEnabled = true) {
  return RISK_VIEWS.has(value) && (cftcEnabled || !['exposures', 'cftc', 'fcm'].includes(value)) ? value : 'overview';
}

export function parseRiskLocation(search, cftcEnabled = true) {
  const params = new URLSearchParams(search);
  return {
    ticker: (params.get('ticker') || params.get('symbol') || '').trim().toUpperCase(),
    view: normalizeRiskView(params.get('view'), cftcEnabled),
    basis: normalizeRiskBasis(params.get('basis')),
    entity: params.get('entity') || '',
    asOf: params.get('asOf') || '',
  };
}

export function riskViewPath(search, view, cftcEnabled = true) {
  const params = new URLSearchParams(search);
  const normalized = normalizeRiskView(view, cftcEnabled);
  if (normalized === 'overview') params.delete('view');
  else params.set('view', normalized);
  const query = params.toString();
  return `/risk${query ? `?${query}` : ''}`;
}
