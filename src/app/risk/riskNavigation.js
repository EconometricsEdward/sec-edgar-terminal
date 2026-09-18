const RISK_VIEWS = new Set(['overview', 'exposures', 'fcm']);

export function normalizeRiskBasis(value) {
  return value === 'annual' ? 'annual' : 'ttm';
}

export function normalizeRiskView(value, cftcEnabled = true) {
  const view = value === 'cftc' ? 'exposures' : value;
  return RISK_VIEWS.has(view) && (cftcEnabled || !['exposures', 'fcm'].includes(view)) ? view : 'overview';
}

export function parseRiskLocation(search, cftcEnabled = true) {
  const params = new URLSearchParams(search);
  return {
    ticker: (params.get('ticker') || params.get('symbol') || '').trim().toUpperCase(),
    view: normalizeRiskView(params.get('view') || params.get('tab'), cftcEnabled),
    basis: normalizeRiskBasis(params.get('basis')),
    entity: params.get('entity') || '',
    asOf: params.get('asOf') || '',
  };
}

export function riskViewPath(search, view, cftcEnabled = true) {
  const params = new URLSearchParams(search);
  const normalized = normalizeRiskView(view, cftcEnabled);
  const retiredMarketView = view === 'cftc' || (params.get('view') || params.get('tab')) === 'cftc';
  params.delete('tab');
  if (normalized === 'exposures' && retiredMarketView) params.set('exposurePanel', 'markets');
  if (normalized === 'overview') params.delete('view');
  else params.set('view', normalized);
  const query = params.toString();
  return `/risk${query ? `?${query}` : ''}`;
}
