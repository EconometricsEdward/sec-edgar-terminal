export function normalizeReportRequest(params) {
  const allowed = ['kind', 'id', 'basis'];
  if ([...params.keys()].some(key => !allowed.includes(key)) || allowed.some(key => params.getAll(key).length > 1)) {
    throw Object.assign(new Error('Choose one entity and reporting basis.'), { status: 400 });
  }
  const kind = params.get('kind') || '';
  let id = (params.get('id') || '').trim().toUpperCase();
  const basis = params.get('basis') || 'annual';
  if (!['company', 'nport', '13f'].includes(kind) || !['annual', 'ttm', 'quarter'].includes(basis)
    || (kind === '13f' ? !/^\d{1,10}$/.test(id) || Number(id) <= 0 : !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(id))) {
    throw Object.assign(new Error('Choose a valid company ticker, N-PORT fund ticker, or 13F manager CIK.'), { status: 400 });
  }
  if (kind === '13f') id = id.padStart(10, '0');
  return { kind, id, basis: kind === 'company' ? basis : 'annual' };
}

export function reportMatchesSelection(report, { kind, id, basis }) {
  return report?.schema === 'edgar.report.v1' && report.kind === kind
    && typeof report.entity?.id === 'string' && report.entity.id.toUpperCase() === id.toUpperCase()
    && (kind !== 'company' || report.period?.basis === basis)
    && typeof report.entity.name === 'string' && report.entity.name.length > 0
    && /^\d{1,10}$/.test(report.entity.cik || '')
    && Number.isFinite(Date.parse(report.generatedAt))
    && Array.isArray(report.summary) && Array.isArray(report.sections) && Array.isArray(report.sources)
    && Array.isArray(report.highlights) && Array.isArray(report.notes)
    && ['ready', 'partial'].includes(report.coverage?.status);
}
