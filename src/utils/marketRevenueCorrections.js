import { buildMarketCompany, marketAcceptanceTimes, marketCompanySummary, MARKET_REVENUE_VERSION } from './marketResearchData.js';

// These issuers exposed the mapping/context defects in the September audit.
// This list only prioritizes recalculation; financial values always come from SEC facts.
const AUDITED_CIKS = ['906345', '1381197', '1035983'];
const REVENUE_METRICS = ['revenue', 'revenueGrowth', 'netMargin', 'operatingMargin', 'cashFlowMargin', 'freeCashFlowMargin', 'capexIntensity'];
const normalizeCik = value => String(value).replace(/^0+/, '');

export function revenueCorrectionPriority(company) {
  if (!company || company.revenueVersion === MARKET_REVENUE_VERSION) return null;
  const audited = AUDITED_CIKS.indexOf(normalizeCik(company.cik));
  if (audited !== -1) return audited;
  const sic = Number(company.sic);
  return sic >= 6200 && sic <= 6299 || sic === 6798 ? 3 : null;
}

/** Retain unaffected balance-sheet/income data while awaiting compatible revenue inputs. */
export function withholdUncorrectedRevenue(company) {
  const cleanMetrics = metrics => Object.fromEntries(Object.entries(metrics || {}).map(([key, value]) => [key, REVENUE_METRICS.includes(key) ? null : value]));
  const comparisons = Object.fromEntries(['annual', 'ttm'].map(basis => {
    const comparison = company.filingComparisons?.[basis];
    if (!comparison) return [basis, null];
    const point = value => value ? { ...value, metrics: cleanMetrics(value.metrics) } : null;
    return [basis, { ...comparison, current: point(comparison.current), prior: point(comparison.prior), changes: cleanMetrics(comparison.changes) }];
  }));
  return { ...company, metrics: Object.fromEntries(['annual', 'ttm'].map(basis => [basis, cleanMetrics(company.metrics?.[basis])])),
    filingComparisons: comparisons, revenueQuality: 'awaiting-compatible-source',
    revenueBasis: 'Revenue metrics unavailable while compatible SEC inputs are being prepared' };
}

/** Pure rebuild: supplied prepared source documents only; never fetch or change their clocks. */
export function recalculatePreparedMarketRevenue(company, factsEnvelope, submissionsEnvelope) {
  const facts = factsEnvelope?.payload, submissions = submissionsEnvelope?.payload;
  if (!facts?.facts || !submissions?.sic || !submissions.filings?.recent
    || normalizeCik(facts.cik) !== normalizeCik(company.cik)
    || normalizeCik(submissions.cik) !== normalizeCik(company.cik)) throw new Error('Compatible prepared SEC documents are unavailable.');
  for (const [envelope, previousClock] of [[factsEnvelope, company.factsValidatedAt || company.factsRetrievedAt], [submissionsEnvelope, company.checkedAt]]) {
    const sourceClock = Date.parse(envelope.metadata?.revalidatedAt || envelope.metadata?.fetchedAt || '');
    if (previousClock && (!Number.isFinite(sourceClock) || sourceClock < Date.parse(previousClock))) {
      throw new Error('Prepared SEC documents predate the current company checkpoint.');
    }
  }
  const corrected = marketCompanySummary(buildMarketCompany({ ticker: company.ticker, cik: company.cik,
    name: submissions.name || company.name, sic: submissions.sic, facts: facts.facts,
    acceptanceTimes: marketAcceptanceTimes(submissions) }, company.cohorts || [], factsEnvelope.metadata?.fetchedAt || company.observedAt));
  for (const basis of ['annual', 'ttm']) {
    if (company.reports?.[basis]?.end && (!corrected.reports?.[basis]?.end || corrected.reports[basis].end < company.reports[basis].end
      || corrected.reports[basis].end === company.reports[basis].end && corrected.reports[basis].filed < company.reports[basis].filed)) {
      throw new Error('Prepared SEC facts are older than the published financial period.');
    }
  }
  const { revenueQuality: _oldQuality, ...previous } = company;
  return { ...previous, ...corrected,
    ...(factsEnvelope.metadata?.fetchedAt ? { factsRetrievedAt: factsEnvelope.metadata.fetchedAt } : {}),
    ...(factsEnvelope.metadata?.revalidatedAt || factsEnvelope.metadata?.fetchedAt
      ? { factsValidatedAt: factsEnvelope.metadata.revalidatedAt || factsEnvelope.metadata.fetchedAt } : {}),
    ...(submissionsEnvelope.metadata?.revalidatedAt || submissionsEnvelope.metadata?.fetchedAt
      ? { checkedAt: submissionsEnvelope.metadata.revalidatedAt || submissionsEnvelope.metadata.fetchedAt } : {}),
  };
}
