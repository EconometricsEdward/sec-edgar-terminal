// Delivery projections are derived from one complete prepared report. They never
// rewrite its financial totals, coverage, source chain or stored holdings body.
export const THIRTEEN_F_PAGE_SIZE = 25;
export const THIRTEEN_F_OVERVIEW_SIZE = 10;
const MODES = new Set(['full', 'summary', 'holdings']);
const TYPES = new Set(['all', 'ordinary', 'principal', 'PUT', 'CALL']);
const SORTS = new Set(['value', 'name', 'quantity']);
const DELIVERY_KEYS = ['delivery', 'offset', 'q', 'type', 'sort', 'snapshot'];

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_DELIVERY' });
}
export function normalize13FDelivery(params) {
  for (const key of DELIVERY_KEYS) if (params.getAll(key).length > 1) throw invalid('Use each holdings delivery parameter only once.');
  const mode = params.get('delivery') || 'full';
  if (!MODES.has(mode) || params.has('delivery') && !params.get('delivery')) throw invalid('Use full, summary or holdings delivery.');
  if (mode !== 'holdings' && ['offset', 'q', 'type', 'sort'].some(key => params.has(key))) throw invalid('Search, sorting and pagination apply only to holdings delivery.');
  const offsetInput = params.get('offset') || '0';
  if (!/^(0|[1-9]\d{0,4})$/.test(offsetInput) || Number(offsetInput) > 20000 || Number(offsetInput) % THIRTEEN_F_PAGE_SIZE !== 0) throw invalid('Use a holdings page offset from 0 to 20000 in steps of 25.');
  const query = (params.get('q') || '').trim();
  if (query.length > 160 || /[\u0000-\u001f\u007f]/.test(query)) throw invalid('Use a position search of at most 160 characters.');
  const type = params.get('type') || 'all', sort = params.get('sort') || 'value';
  if (!TYPES.has(type) || !SORTS.has(sort)) throw invalid('Use a supported security type and holdings sort.');
  const snapshot = params.get('snapshot') || '';
  if (params.has('snapshot') && (!snapshot || snapshot.length > 2048 || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z(?:\/[0-9-]+)*$/.test(snapshot))) throw invalid('Use the snapshot version returned with this report.');
  return { mode, offset: Number(offsetInput), query, type, sort, snapshot };
}

export function thirteenFReportVersion(data) {
  return [data.observedAt, ...(data.portfolio?.filings || []).map(filing => filing.accession)].join('/');
}

export function select13FHoldings(holdings, { query = '', type = 'all', sort = 'value' } = {}) {
  const needle = query.trim().toLowerCase();
  return holdings.filter(row => (!needle || `${row.issuer} ${row.cusip} ${row.classTitle}`.toLowerCase().includes(needle))
    && (type === 'all' || type === 'ordinary' && !row.putCall || type === 'principal' && row.quantityType === 'PRN' || row.putCall === type))
    .sort((a, b) => {
      const primary = sort === 'name' ? a.issuer.localeCompare(b.issuer, 'en')
        : sort === 'quantity' ? (b.quantity ?? -Infinity) - (a.quantity ?? -Infinity)
          : (b.valueUsd ?? -Infinity) - (a.valueUsd ?? -Infinity);
      // A stable security-key tie break prevents tied positions crossing pages.
      return (Number.isNaN(primary) ? 0 : primary) || a.key.localeCompare(b.key, 'en');
    });
}

export function project13FDelivery(data, options = {}) {
  const { mode = 'full', offset = 0, query = '', type = 'all', sort = 'value', snapshot = '' } = options;
  const version = thirteenFReportVersion(data);
  if (snapshot && snapshot !== version) throw Object.assign(new Error('This report has been updated. Refresh the snapshot before continuing through holdings or exporting.'), { status: 409, code: 'REPORT_UPDATED' });
  if (data.status !== 'ready' || !data.portfolio) return data;
  const all = data.portfolio.holdings;
  const ordered = mode === 'full' ? all : select13FHoldings(all, mode === 'summary' ? {} : { query, type, sort });
  const limit = mode === 'summary' ? THIRTEEN_F_OVERVIEW_SIZE : mode === 'holdings' ? THIRTEEN_F_PAGE_SIZE : all.length;
  const start = mode === 'holdings' ? offset : 0;
  const holdings = mode === 'full' ? all : ordered.slice(start, start + limit);
  return { ...data, portfolio: { ...data.portfolio, holdings }, delivery: {
    mode, total: all.length, filteredTotal: ordered.length, offset: start, limit,
    returned: holdings.length, version, query, type, sort,
    holdingsComplete: holdings.length === all.length && start === 0,
  } };
}

// Readers must never mistake a delivered page for a full comparable portfolio.
export function valid13FDelivery(data, options = {}) {
  if (data?.status === 'unavailable') return true;
  const { mode = 'full', offset = 0, query = '', type = 'all', sort = 'value', snapshot = '' } = options;
  const delivery = data?.delivery, rows = data?.portfolio?.holdings;
  if (!delivery || delivery.mode !== mode || !Array.isArray(rows) || delivery.version !== thirteenFReportVersion(data)
    || snapshot && delivery.version !== snapshot || !Number.isInteger(delivery.total) || delivery.total < 0 || delivery.total > 20000
    || delivery.total !== data.portfolio.positionCount || delivery.returned !== rows.length
    || !Number.isInteger(delivery.filteredTotal) || delivery.filteredTotal < 0 || delivery.filteredTotal > delivery.total
    || new Set(rows.map(row => row.key)).size !== rows.length) return false;
  const expectedOffset = mode === 'holdings' ? offset : 0;
  const expectedLimit = mode === 'summary' ? THIRTEEN_F_OVERVIEW_SIZE : mode === 'holdings' ? THIRTEEN_F_PAGE_SIZE : delivery.total;
  if (delivery.offset !== expectedOffset || delivery.limit !== expectedLimit || rows.length !== Math.max(0, Math.min(expectedLimit, delivery.filteredTotal - expectedOffset))
    || delivery.holdingsComplete !== (rows.length === delivery.total && expectedOffset === 0)) return false;
  if (mode === 'holdings') return delivery.query === query.trim() && delivery.type === type && delivery.sort === sort;
  return delivery.filteredTotal === delivery.total;
}
