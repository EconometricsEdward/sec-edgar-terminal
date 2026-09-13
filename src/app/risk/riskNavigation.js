const RISK_VIEWS = new Set(['overview', 'stress', 'disclosures', 'cftc', 'fcm']);

export function normalizeRiskView(value, cftcEnabled = true) {
  return RISK_VIEWS.has(value) && (cftcEnabled || !['cftc', 'fcm'].includes(value)) ? value : 'overview';
}

export function parseRiskLocation(search, cftcEnabled = true) {
  const params = new URLSearchParams(search);
  return {
    ticker: (params.get('ticker') || params.get('symbol') || '').toUpperCase(),
    view: normalizeRiskView(params.get('view'), cftcEnabled),
    entity: params.get('entity') || '',
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
