/** Fixed production worker contract. No arbitrary SQL, dataset or storage key. */
export const FUND_REVIEW_LIMITS = Object.freeze({ rpcBytes: 10 * 1024 * 1024, reportBytes: 8 * 1024 * 1024,
  resultBytes: 1024 * 1024, summaryBytes: 64 * 1024, holdings: 20000, markets: 40 });
export const FUND_REVIEW_RPC_PARAMETERS = Object.freeze({
  edgar_fund_review_enqueue: ['p_report', 'p_report_hash'],
  edgar_fund_review_claim: ['p_owner', 'p_lease_seconds'],
  edgar_fund_review_work: ['p_claim', 'p_limit'],
  edgar_fund_review_save: ['p_claim', 'p_ordinal', 'p_result', 'p_summary', 'p_retry_seconds'],
  edgar_fund_review_release: ['p_claim'],
  edgar_fund_review_read: ['p_cik', 'p_period', 'p_report_hash', 'p_market', 'p_status', 'p_query', 'p_offset', 'p_limit'],
  edgar_fund_review_result: ['p_cik', 'p_period', 'p_report_hash', 'p_key'],
});
const CIK = /^(?!0000000000)[0-9]{10}$/, HASH = /^[a-fA-F0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[A-Z0-9*@#]{9}\|(SECURITY|PUT|CALL)\|(SH|PRN)$/;
const STATUSES = ['linked', 'partial', 'disclosure_only', 'no_matches', 'no_filing', 'unresolved', 'unavailable'];
const encoder = new TextEncoder();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v, max) => typeof v === 'string' && v.length <= max;
const bytes = v => encoder.encode(JSON.stringify(v)).byteLength;
const timestamp = (v, now) => text(v, 40) && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now + 60000;
const quarter = value => typeof value === 'string' && /^\d{4}-(?:03-31|06-30|09-30|12-31)$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const numberOrNull = value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
function holding(value) {
  return object(value) && KEY.test(value.key || '') && [value.cusip, value.putCall || 'SECURITY', value.quantityType].join('|') === value.key
    && text(value.issuer, 500) && value.issuer.length > 0 && (value.classTitle === null || text(value.classTitle, 500))
    && numberOrNull(value.quantity) && numberOrNull(value.valueUsd);
}
function claim(value) {
  return keys(value, ['id', 'reportHash', 'generation', 'owner', 'cycle']) && UUID.test(value.id || '') && UUID.test(value.owner || '')
    && HASH.test(value.reportHash || '') && int(value.cycle, 1, 2147483647)
    && (int(value.generation, 1, Number.MAX_SAFE_INTEGER) || typeof value.generation === 'string' && /^[1-9]\d{0,18}$/.test(value.generation)
      && BigInt(value.generation) <= 9223372036854775807n);
}
function summary(value, now) {
  return keys(value, ['holding', 'status', 'issuer', 'message', 'checkedAt', 'markets', 'checked', 'partial', 'disclosureOnly', 'retryable'])
    && holding(value.holding) && STATUSES.includes(value.status) && text(value.message, 2000)
    && timestamp(value.checkedAt, now) && (value.issuer === null || object(value.issuer) && CIK.test(value.issuer.cik || ''))
    && ['checked', 'partial', 'disclosureOnly', 'retryable'].every(key => typeof value[key] === 'boolean')
    && Array.isArray(value.markets) && value.markets.length <= FUND_REVIEW_LIMITS.markets
    && new Set(value.markets.map(m => m?.key)).size === value.markets.length
    && value.markets.every(m => keys(m, ['key', 'family', 'contract', 'group', 'label', 'category', 'groupLabel', 'fit', 'basisLimit'])
      && ['tff', 'disaggregated'].includes(m.family) && /^[A-Z0-9+]{3,12}$/.test(m.contract || '')
      && m.group === (m.family === 'tff' ? 'leveraged-funds' : 'managed-money') && m.key === `${m.family}:${m.contract}:${m.group}`
      && text(m.label, 200) && text(m.groupLabel, 100) && ['rates', 'currencies', 'energy', 'metals', 'agriculture', 'other'].includes(m.category)
      && ['named-reference', 'proxy'].includes(m.fit) && text(m.basisLimit, 1200))
    && bytes(value) <= FUND_REVIEW_LIMITS.summaryBytes;
}
export function validFundReviewRpc(name, params, now = Date.now()) {
  if (!Object.hasOwn(FUND_REVIEW_RPC_PARAMETERS, name) || !keys(params, ['p_namespace', ...FUND_REVIEW_RPC_PARAMETERS[name]])
    || params.p_namespace !== undefined && params.p_namespace !== 'production') return false;
  if (name === 'edgar_fund_review_enqueue') {
    const r = params.p_report, hs = r?.portfolio?.holdings;
    return object(r) && HASH.test(params.p_report_hash || '') && CIK.test(r.manager?.cik || '') && quarter(r.selectedPeriod)
      && r.selectedPeriod <= new Date(now).toISOString().slice(0, 10) && r.portfolio?.cik === r.manager.cik && r.portfolio?.period === r.selectedPeriod
      && timestamp(r.cache?.checkedAt, now) && timestamp(r.observedAt, now)
      && typeof r.portfolio.complete === 'boolean' && typeof r.coverage?.selectedPeriodComplete === 'boolean'
      && numberOrNull(r.portfolio.totalValueUsd) && Array.isArray(hs) && int(hs.length, 1, FUND_REVIEW_LIMITS.holdings)
      && r.portfolio.positionCount === hs.length && hs.every(holding) && new Set(hs.map(h => h.key)).size === hs.length
      && bytes(r) <= FUND_REVIEW_LIMITS.reportBytes;
  }
  if (name === 'edgar_fund_review_claim') return UUID.test(params.p_owner || '') && int(params.p_lease_seconds, 5, 90);
  if (['edgar_fund_review_work', 'edgar_fund_review_save', 'edgar_fund_review_release'].includes(name) && !claim(params.p_claim)) return false;
  if (name === 'edgar_fund_review_work') return int(params.p_limit, 1, 12);
  if (name === 'edgar_fund_review_release') return true;
  if (name === 'edgar_fund_review_save') {
    const r = params.p_result;
    return int(params.p_ordinal, 1, FUND_REVIEW_LIMITS.holdings) && (params.p_retry_seconds === 0 || int(params.p_retry_seconds, 60, 86400))
      && object(r) && holding(r.holding) && CIK.test(r.manager?.cik || '') && quarter(r.selectedPeriod)
      && ['ready', 'unresolved', 'unavailable'].includes(r.status) && timestamp(r.observedAt, now)
      && bytes(r) <= FUND_REVIEW_LIMITS.resultBytes && summary(params.p_summary, now)
      && ['key', 'cusip', 'issuer', 'classTitle', 'putCall', 'quantity', 'quantityType', 'valueUsd', 'weightPct'].every(key => (r.holding[key] ?? null) === (params.p_summary.holding[key] ?? null));
  }
  if (!CIK.test(params.p_cik || '') || !quarter(params.p_period)) return false;
  if (name === 'edgar_fund_review_result') return HASH.test(params.p_report_hash || '') && KEY.test(params.p_key || '');
  return (params.p_report_hash == null || HASH.test(params.p_report_hash))
    && (params.p_market == null || text(params.p_market, 120))
    && (params.p_status == null || ['all', 'unchecked', ...STATUSES].includes(params.p_status))
    && (params.p_query == null || text(params.p_query, 100))
    && (params.p_offset === undefined || int(params.p_offset, 0, FUND_REVIEW_LIMITS.holdings))
    && (params.p_limit === undefined || int(params.p_limit, 1, 50));
}
