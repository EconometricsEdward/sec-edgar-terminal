import { createHash } from 'node:crypto';
import { buildThirteenFMarketConnections, is13FMarketConnectionResult, thirteenFMarketHoldings } from './thirteenFMarketConnections.js';
import { normalize13FRequest } from './thirteenFServer.js';

export const THIRTEEN_F_REVIEW_SCHEMA = 'edgar.13f-shared-review.v1';
export const THIRTEEN_F_REVIEW_MAX_HOLDINGS = 20000;
const FIELDS = ['key', 'cusip', 'issuer', 'classTitle', 'putCall', 'quantity', 'quantityType', 'valueUsd', 'weightPct'];
const PORTFOLIO_FIELDS = ['cik', 'managerName', 'period', 'reportType', 'entryCount', 'positionCount', 'totalValueUsd', 'complete', 'comparable', 'confidentialOmitted', 'issues', 'amendmentCount', 'otherManagers'];
const FILING_FIELDS = ['accession', 'form', 'filingDate', 'reportDate', 'primaryUrl', 'indexUrl', 'tableUrls', 'isAmendment', 'amendmentType', 'amendmentNumber', 'superseded'];
const pick = (value, fields) => Object.fromEntries(fields.map(key => [key, value?.[key] ?? null]));
const fail = message => Object.assign(new Error(message), { status: 422, code: 'INVALID_REVIEW_REPORT' });
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** Freeze the whole filed portfolio, not the twenty-position initial preview.
 * Ordinals are stable within this exact report revision and ordered by value. */
export function prepareThirteenFReviewReport(report) {
  const { cik, period } = normalize13FRequest(report?.manager?.cik, report?.selectedPeriod);
  if (!period || report?.portfolio?.cik !== cik || report.portfolio.period !== period)
    throw fail('The manager and report quarter could not be verified.');
  const holdings = thirteenFMarketHoldings(report);
  if (report.delivery && report.delivery.holdingsComplete !== true
    || !holdings.length || holdings.length !== report.portfolio.holdings?.length || holdings.length > THIRTEEN_F_REVIEW_MAX_HOLDINGS
    || report.portfolio.positionCount != null && report.portfolio.positionCount !== holdings.length)
    throw fail('A full report with unique, verified holdings is required for a shared review.');
  if (holdings.some(holding => typeof holding.issuer !== 'string' || !holding.issuer.length || holding.issuer.length > 500
    || holding.classTitle != null && (typeof holding.classTitle !== 'string' || holding.classTitle.length > 500)
    || ['quantity', 'valueUsd'].some(key => holding[key] != null && (typeof holding[key] !== 'number' || holding[key] < 0))
    || FIELDS.some(key => typeof holding[key] === 'number' && !Number.isFinite(holding[key]))))
    throw fail('The report contains an invalid holding.');
  const checkedAt = report.cache?.checkedAt || report.observedAt;
  if (!Number.isFinite(Date.parse(checkedAt)) || Date.parse(checkedAt) > Date.now() + 60000)
    throw fail('The report source check date is unavailable.');
  const frozen = {
    schemaVersion: THIRTEEN_F_REVIEW_SCHEMA,
    manager: pick(report.manager, ['cik', 'name', 'submissionsUrl']),
    selectedPeriod: period, observedAt: report.observedAt || checkedAt, cache: { checkedAt },
    coverage: { selectedPeriodComplete: report.coverage?.selectedPeriodComplete === true },
    portfolio: { ...pick(report.portfolio, PORTFOLIO_FIELDS),
      positionCount: holdings.length, holdings: holdings.map(holding => pick(holding, FIELDS)),
      filings: (report.portfolio.filings || []).map(filing => pick(filing, FILING_FIELDS)),
    },
  };
  if (Buffer.byteLength(JSON.stringify(frozen)) > 8 * 1024 * 1024)
    throw fail('The report exceeds the supported shared review size.');
  return frozen;
}

/** Check times do not change the identity of an unchanged report. Amendments,
 * source chains, holding values and completeness always do. */
export function hashThirteenFReviewReport(report) {
  const frozen = prepareThirteenFReviewReport(report);
  const binding = { schemaVersion: frozen.schemaVersion, cik: frozen.manager.cik, period: frozen.selectedPeriod,
    coverage: frozen.coverage, portfolio: frozen.portfolio };
  // Postgres jsonb changes object key order on a round trip, including nested
  // issue/other-manager records. Array order remains significant.
  return createHash('sha256').update(JSON.stringify(canonical(binding))).digest('hex').toUpperCase();
}

/** Save a bounded summary separately from evidence so a report with thousands
 * of holdings can be aggregated and paginated without loading every passage. */
export function summarizeThirteenFReviewResult(report, result) {
  const holding = report.portfolio.holdings.find(item => item.key === result?.holding?.key);
  if (!holding || FIELDS.some(key => (holding[key] ?? null) !== (result.holding[key] ?? null))
    || result.manager?.cik !== report.manager.cik || result.selectedPeriod !== report.selectedPeriod)
    throw fail('The review result does not match this report holding.');
  const checkedAt = result.discovery?.checkedAt || result.observedAt;
  if (!Number.isFinite(Date.parse(checkedAt)) || Date.parse(checkedAt) > Date.now() + 1000)
    throw fail('The review result has an invalid source check date.');
  const valid = is13FMarketConnectionResult(result, { cik: report.manager.cik, period: report.selectedPeriod, holding });
  // A timed-out attempt has no issuer evidence. It is durable retry state,
  // never a verified connection or a successful no-match result.
  if (!valid && !(result.status === 'unavailable' && result.retryable === true && !result.discovery))
    throw fail('The review result contains unverified evidence.');
  const model = buildThirteenFMarketConnections({ ...report, portfolio: { ...report.portfolio, holdings: [holding] } }, [result]);
  const position = model.positions[0];
  return {
    holding: pick(holding, FIELDS), status: position.status, issuer: position.issuer,
    message: String(position.message || '').slice(0, 1500), checkedAt,
    markets: model.markets.map(market => pick(market, ['key', 'family', 'contract', 'group', 'label', 'category', 'groupLabel', 'fit', 'basisLimit'])),
    checked: model.coverage.checked === 1, partial: model.coverage.partial === 1,
    disclosureOnly: model.coverage.disclosureOnly === 1,
    retryable: result.retryable === true || position.status === 'unavailable' || position.status === 'partial',
  };
}
