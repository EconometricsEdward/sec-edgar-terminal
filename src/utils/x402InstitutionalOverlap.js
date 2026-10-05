import { createHash } from 'node:crypto';
import { create13FCache, valid13FSnapshot, THIRTEEN_F_FRESH_MS } from './thirteenFCache.js';
import { buildThirteenFComparison } from './thirteenFComparison.js';
import { X402_DATA_HEADERS, x402DataError } from './x402Research.js';
export { X402_INSTITUTIONAL_OVERLAP_SCHEMA } from './x402InstitutionalOverlapSchema.js';

const SCHEMA = 'edgar.paid-institutional-overlap.v1';
const MAX_BYTES = 4 * 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exactCik = value => /^(?!0000000000)\d{10}$/.test(value);
const unavailable = () => x402DataError('DATA_NOT_PREPARED', 'Every selected manager needs a complete, validated prepared quarter. No source downloads are started and this request is not charged.', 503);
const badSelection = () => x402DataError('INVALID_SELECTION', 'Use the documented bounded institutional-overlap selectors. This request is not charged.', 400);

function quarter(value, now) {
  return /^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(value) && Number(value.slice(0, 4)) > 0
    && value <= new Date(now).toISOString().slice(0, 10);
}

/** Selection is validated before payment verification or a prepared-data read. */
export function paidInstitutionalOverlapSelection(request, now = Date.now()) {
  const query = new URL(request.url).searchParams;
  const allowed = ['ciks', 'period', 'minimumManagers', 'sort', 'order', 'limit', 'offset', 'snapshot', 'format'];
  if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1 || !query.get(key))) return null;
  const ciks = (query.get('ciks') ?? '').split(',');
  const period = query.get('period') ?? '';
  const minimumManagers = query.get('minimumManagers') ?? '2';
  const sort = query.get('sort') ?? 'reportedValue', order = query.get('order') ?? 'desc';
  const limit = query.get('limit') ?? '100', offset = query.get('offset') ?? '0';
  const snapshot = query.get('snapshot') ?? '', format = query.get('format') ?? 'json';
  if (ciks.length < 2 || ciks.length > 4 || ciks.some(cik => !exactCik(cik)) || new Set(ciks).size !== ciks.length
    || period && !quarter(period, now) || !/^[2-4]$/.test(minimumManagers) || Number(minimumManagers) > ciks.length
    || !['reportedValue', 'cusip'].includes(sort) || !['asc', 'desc'].includes(order)
    || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100 || !/^(0|[1-9]\d{0,3})$/.test(offset)
    || snapshot && !/^[a-f0-9]{64}$/.test(snapshot) || !['json', 'csv'].includes(format)) return null;
  return { ciks: ciks.sort(), period, minimumManagers: Number(minimumManagers), sort, order,
    limit: Number(limit), offset: Number(offset), snapshot, format };
}

function validSelection(selection, now) {
  if (!selection || typeof selection !== 'object' || !Array.isArray(selection.ciks)) return false;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(selection)) {
    if (key === 'ciks') query.set(key, value.join(','));
    else if (value !== '') query.set(key, String(value));
  }
  const selected = paidInstitutionalOverlapSelection({ url: `https://example.invalid/?${query}` }, now);
  return selected && JSON.stringify(selected) === JSON.stringify(selection);
}

function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const input = typeof value === 'string' ? value : JSON.stringify(value);
  const safe = /^[\s\x00-\x1f]*[=+\-@]/.test(input) || /^[\t\r\n]/.test(input) ? `'${input}` : input;
  return `"${safe.replaceAll('"', '""')}"`;
}
const columns = ['schemaVersion', 'snapshot', 'period', 'stale', 'generatedAt', 'minimumManagers', 'sort', 'order',
  'totalMatches', 'offset', 'nextOffset', 'paginationTruncated', 'key', 'cusip', 'putCall', 'quantityType', 'managerCount', 'aggregateReportedValueUsd',
  'cik', 'managerName', 'status', 'issuer', 'classTitle', 'quantity', 'valueUsd', 'weightPct', 'totalReportedValueUsd',
  'top5Pct', 'top10Pct', 'reportType', 'confidentialOmitted', 'checkedAt', 'freshUntil', 'observedAt', 'managerStale', 'filings', 'limitations'];

function deliver(payload, format) {
  let body;
  try {
    if (format === 'json') body = JSON.stringify(payload);
    else {
      const managerByCik = new Map(payload.managers.map(manager => [manager.cik, manager]));
      const csvRows = payload.rows.flatMap(row => row.cells.map(cell => {
        const manager = managerByCik.get(cell.cik);
        return { schemaVersion: SCHEMA, snapshot: payload.pagination.snapshot, period: payload.period, stale: payload.stale,
          generatedAt: payload.generatedAt, minimumManagers: payload.selection.minimumManagers, sort: payload.selection.sort, order: payload.selection.order,
          totalMatches: payload.pagination.total, offset: payload.pagination.offset, nextOffset: payload.pagination.nextOffset, paginationTruncated: payload.pagination.truncated,
          ...row, ...cell, managerName: manager.name, totalReportedValueUsd: manager.totalValueUsd,
          top5Pct: manager.top5Pct, top10Pct: manager.top10Pct, reportType: manager.reportType,
          confidentialOmitted: manager.confidentialOmitted, checkedAt: manager.checkedAt, freshUntil: manager.freshUntil,
          observedAt: manager.observedAt, managerStale: manager.stale, filings: manager.filings, limitations: payload.limitations };
      }));
      body = `${columns.map(csvCell).join(',')}\r\n${csvRows.map(row => columns.map(column => csvCell(row[column])).join(',')).join('\r\n')}\r\n`;
    }
  } catch { return unavailable(); }
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return x402DataError('PRODUCT_TOO_LARGE', 'This product exceeds the bounded delivery size. Choose a smaller page. This request is not charged.', 413);
  return new Response(body, { headers: { ...X402_DATA_HEADERS,
    'X-Data-Stale': payload.stale ? '1' : '0', 'X-Schema-Version': SCHEMA,
    'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    'Access-Control-Expose-Headers': `${X402_DATA_HEADERS['Access-Control-Expose-Headers']}, X-Schema-Version, Content-Disposition`,
    ...(format === 'csv' ? { 'Content-Disposition': 'attachment; filename="institutional-overlap.csv"' } : {}),
  } });
}

const sharedCache = create13FCache();
function completePublicChain(value) {
  const portfolio = value.data.portfolio, filings = portfolio.filings;
  const observedDate = value.data.observedAt.slice(0, 10), checkedDate = value.checkedAt.slice(0, 10);
  for (let index = 0; index < filings.length; index++) {
    const filing = filings[index], previous = filings[index - 1];
    if (!['13F-HR', '13F-HR/A'].includes(filing.form) || typeof filing.isAmendment !== 'boolean'
      || filing.isAmendment !== filing.form.endsWith('/A') || typeof filing.superseded !== 'boolean'
      || filing.filingDate > checkedDate || filing.filingDate > observedDate
      || previous && (previous.filingDate > filing.filingDate
        || previous.filingDate === filing.filingDate && ((previous.amendmentNumber ?? 0) > (filing.amendmentNumber ?? 0)
          || (previous.amendmentNumber ?? 0) === (filing.amendmentNumber ?? 0) && previous.accession > filing.accession))) return false;
    if (filing.isAmendment ? !Number.isSafeInteger(filing.amendmentNumber) || filing.amendmentNumber < 1
      || !['RESTATEMENT', 'NEW HOLDINGS'].includes(filing.amendmentType)
      : filing.amendmentNumber !== null || filing.amendmentType !== null) return false;
  }
  if (portfolio.amendmentCount !== filings.filter(filing => filing.isAmendment).length) return false;
  let baseline = -1;
  for (let index = 0; index < filings.length; index++) if (filings[index].amendmentType === 'RESTATEMENT') baseline = index;
  if (baseline < 0) {
    // Supplemental additions cannot supply the missing original table.
    const originals = filings.map((filing, index) => ({ filing, index })).filter(({ filing }) => !filing.isAmendment);
    if (originals.length !== 1 || originals[0].index !== 0) return false;
    baseline = 0;
  } else if (filings.slice(0, baseline).some(filing => filing.amendmentNumber === filings[baseline].amendmentNumber)) return false;
  if (filings.some((filing, index) => filing.superseded !== (index < baseline))) return false;
  let previousNumber = filings[baseline].amendmentNumber ?? 0;
  for (const filing of filings.slice(baseline + 1)) {
    if (!filing.isAmendment || filing.amendmentType !== 'NEW HOLDINGS' || filing.amendmentNumber !== previousNumber + 1) return false;
    previousNumber = filing.amendmentNumber;
  }
  return true;
}
/** Only prepared snapshot reads are allowed; no filing/history loader is called. */
export function createPaidInstitutionalOverlapReader({ readManager = (cik, period, signal) => sharedCache.readSnapshot(cik, period, signal), now = Date.now } = {}) {
  return async function institutionalOverlap(selection) {
    const clock = now();
    if (!validSelection(selection, clock)) return badSelection();
    let saved;
    try { saved = await Promise.all(selection.ciks.map(cik => readManager(cik, selection.period, AbortSignal.timeout(8000)))); }
    catch { return unavailable(); }
    if (saved.some((value, index) => value?.invalidatedAt !== undefined
      || !valid13FSnapshot(value, selection.ciks[index], selection.period, clock) || !completePublicChain(value))) return unavailable();
    const periods = new Set(saved.map(value => value.data.selectedPeriod));
    if (periods.size !== 1) return x402DataError('QUARTERS_NOT_ALIGNED', 'Selected managers have different prepared latest quarters. Choose an explicit quarter available for every manager. This request is not charged.', 409);
    const period = saved[0].data.selectedPeriod;
    let comparison;
    try { comparison = buildThirteenFComparison(saved.map(value => ({ cik: value.cik, data: value.data })), { period, now: clock, maxSharedHoldings: 1 }); }
    catch { return unavailable(); }
    if (!comparison.coverage.allComplete) return unavailable();
    const managers = comparison.managers.map((manager, index) => ({ ...manager,
      checkedAt: saved[index].checkedAt,
      freshUntil: new Date(Date.parse(saved[index].checkedAt) + THIRTEEN_F_FRESH_MS).toISOString(),
      stale: clock - Date.parse(saved[index].checkedAt) >= THIRTEEN_F_FRESH_MS }));
    const holdings = saved.map(value => new Map(value.data.portfolio.holdings.map(row => [row.key, row])));
    const union = new Map();
    for (const portfolio of holdings) for (const [key, holding] of portfolio) {
      const row = union.get(key);
      if (row) row.managerCount++;
      else union.set(key, { key, cusip: holding.cusip, putCall: holding.putCall, quantityType: holding.quantityType, managerCount: 1 });
    }
    const allShared = [...union.values()].filter(row => row.managerCount >= 2);
    const rows = allShared.filter(row => row.managerCount >= selection.minimumManagers).map(row => {
      const cells = managers.map((manager, index) => {
        const position = holdings[index].get(row.key);
        if (position) return { cik: manager.cik, status: 'reported', issuer: position.issuer, classTitle: position.classTitle,
          quantity: position.quantity, valueUsd: position.valueUsd,
          weightPct: manager.totalValueUsd > 0 ? position.valueUsd / manager.totalValueUsd * 100 : null };
        const absenceKnown = manager.absenceKnown;
        return { cik: manager.cik, status: absenceKnown ? 'not-reported' : 'unknown', issuer: null, classTitle: null,
          quantity: absenceKnown ? 0 : null, valueUsd: absenceKnown ? 0 : null,
          weightPct: absenceKnown && manager.totalValueUsd > 0 ? 0 : null };
      });
      const aggregateReportedValueUsd = cells.filter(cell => cell.status === 'reported').reduce((sum, cell) => sum + cell.valueUsd, 0);
      if (!Number.isSafeInteger(aggregateReportedValueUsd)) return null;
      return { ...row, aggregateReportedValueUsd, cells };
    });
    if (rows.some(row => row === null)) return unavailable();
    const sign = selection.order === 'asc' ? 1 : -1;
    rows.sort((a, b) => (selection.sort === 'reportedValue' ? sign * (a.aggregateReportedValueUsd - b.aggregateReportedValueUsd)
      : sign * a.cusip.localeCompare(b.cusip, 'en')) || a.key.localeCompare(b.key, 'en'));
    const criteria = { ciks: selection.ciks, requestedPeriod: selection.period || 'latest', minimumManagers: selection.minimumManagers,
      sort: selection.sort, order: selection.order };
    const fingerprint = hash({ criteria, sources: saved.map(value => ({ cik: value.cik, checkedAt: value.checkedAt,
      sourceChainHash: value.sourceChainHash, dataHash: hash(value.data) })) });
    if (selection.snapshot && selection.snapshot !== fingerprint) return x402DataError('SNAPSHOT_CHANGED', 'The prepared observations or comparison criteria changed. Restart pagination without a snapshot token. This request is not charged.', 409);
    if (!rows.length) return x402DataError('NO_MATCHING_DATA', 'No prepared holdings meet the selected minimum manager count. This request is not charged.', 404);
    if (selection.offset >= rows.length) return x402DataError('PAGE_OUT_OF_RANGE', 'The offset is beyond this comparison. This request is not charged.', 416);
    const remaining = selection.offset + selection.limit < rows.length;
    const nextOffset = remaining && selection.offset + selection.limit <= 9999 ? selection.offset + selection.limit : null;
    const payload = { schemaVersion: SCHEMA, status: 'ready', period, generatedAt: new Date(clock).toISOString(),
      stale: managers.some(manager => manager.stale), selection: criteria,
      snapshot: { earliestCheckedAt: managers.map(manager => manager.checkedAt).sort()[0], latestCheckedAt: managers.map(manager => manager.checkedAt).sort().at(-1),
        observations: managers.map((manager, index) => ({ cik: manager.cik, checkedAt: manager.checkedAt, freshUntil: manager.freshUntil,
          observedAt: manager.observedAt, stale: manager.stale, sourceChainHash: saved[index].sourceChainHash })) },
      managers, pairs: comparison.pairs.map(({ sharedHoldings: _shared, sharedHoldingsTruncated: _truncated, ...pair }) => pair),
      coverage: comparison.coverage,
      population: { unionPositions: union.size, totalSharedPositions: allShared.length, matchingPositions: rows.length },
      rows: rows.slice(selection.offset, selection.offset + selection.limit),
      pagination: { limit: selection.limit, offset: selection.offset, total: rows.length, nextOffset, truncated: remaining && nextOffset === null, snapshot: fingerprint },
      limitations: [
        'Reported quarter-end 13F holdings are not current portfolios, total assets, investment performance, purchases, sales, or economic exposure.',
        'Matches require the same CUSIP, put/call designation and share/principal units. Issuer names and class titles remain as reported for each manager. Options stay separate and are not netted or delta-adjusted.',
        'Weighted pair overlap sums the smaller reported-value percentage for each shared position using each complete public table. Aggregate reported value across managers is a ranking aid, not a combined portfolio weight or ownership stake.',
        'Confidential omissions and combination-report scope remain explicit. A missing security is unknown when public scope cannot establish absence. Zero total reported value withholds every percentage.',
        'Each quarter uses the retained public amendment chain observed at the displayed check time. Results can become stale or change after new filings; no freshness SLA is promised.',
        'Delivery is paginated to at most 100 positions per request and offset 9,999. Counts and pair metrics describe the complete comparison; pagination.truncated marks additional matches beyond this paging boundary.',
        'Every selected manager must have validated complete prepared evidence. Missing, invalidated or expired snapshots fail the whole request without settlement.',
      ] };
    return deliver(payload, selection.format);
  };
}

export const paidInstitutionalOverlapReader = createPaidInstitutionalOverlapReader();
