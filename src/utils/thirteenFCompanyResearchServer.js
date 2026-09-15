import { loadThirteenF, normalize13FRequest } from './thirteenFServer.js';
import { loadThirteenFCompanyIdentity } from './thirteenFCompanyIdentityServer.js';
import { loadFilingsCompany } from './filingsResearchServer.js';
import { secResearchJson } from './secResearchData.js';
import { buildAnalysisCompany } from './analysisResearch.js';
import { RESEARCH_FORMS } from './researchWorkspace.js';

const KEY = /^[A-Z0-9*@#]{9}\|(SECURITY|PUT|CALL)\|(SH|PRN)$/;
const CIK = /^\d{10}$/;
const FINANCIAL_NOTE = 'Latest available annual SEC facts, using filings available on the research date. These company financials are separate from the manager’s historical 13F snapshot. USD only; missing or custom-tag facts remain unavailable. Earlier years may include subsequent revisions.';
const metricKeys = {
  corporate: ['revenue', 'netIncome', 'operatingCashFlow', 'freeCashFlow', 'operatingMargin', 'longTermDebt'],
  banking: ['bankRevenue', 'netIncome', 'roe', 'cash', 'deposits', 'loans'],
  insurance: ['premiumsEarned', 'netIncome', 'roe', 'cash', 'totalAssets', 'stockholdersEquity'],
};
const fail = (message, status = 502, code = 'SEC_COMPANY_RESEARCH_UNAVAILABLE') => Object.assign(new Error(message), { status, code });
const sameCik = (a, b) => /^\d{1,10}$/.test(String(a ?? '')) && Number(a) > 0 && String(a).padStart(10, '0') === b;
const finite = value => Number.isFinite(value) ? value : null;
const text = (value, limit = 1000) => typeof value === 'string' ? value.slice(0, limit) : '';
function secDocumentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.sec.gov' && !url.username && !url.password && !url.port && url.pathname.startsWith('/Archives/edgar/data/') ? url.href : null;
  } catch { return null; }
}

export function normalize13FCompanyRequest(cikInput, periodInput, keyInput) {
  const request = normalize13FRequest(cikInput, periodInput);
  if (!request.period) throw fail('Select a report quarter before opening a holding.', 400, 'INVALID_PERIOD');
  const key = String(keyInput ?? '');
  if (!KEY.test(key)) throw fail('Select a valid holding from this manager’s report.', 400, 'INVALID_HOLDING');
  return { ...request, key };
}

function compactPeriod(period) {
  return { end: period.end, start: period.start || null, kind: period.kind || 'annual', fp: period.fp || 'FY', label: period.label || period.end };
}
function compactSource(source) {
  const url = secDocumentUrl(source.documentUrl);
  return { url, documentUrl: url, form: text(source.form, 20), filed: text(source.filed, 10), accession: text(source.accession, 20),
    taxonomy: text(source.taxonomy, 80), tag: text(source.tag, 160), unit: text(source.unit, 40),
    start: source.start || null, end: source.end || null, value: finite(source.value) };
}
function compactFinancials(analysis, asOf) {
  const indexes = (analysis.periods || []).map((period, index) => ({ period, index }))
    .filter(({ period }) => /^\d{4}-\d{2}-\d{2}$/.test(period.end || '') && period.end <= asOf)
    .sort((a, b) => b.period.end.localeCompare(a.period.end)).slice(0, 4).reverse();
  const periods = indexes.map(({ period }) => compactPeriod(period));
  const metrics = (metricKeys[analysis.lens] || metricKeys.corporate).map(key => {
    const definition = analysis.definitions?.find(row => row.key === key);
    return { key, label: definition?.label || key, format: definition?.format || 'currency', points: indexes.map(({ period, index }) => {
      const point = analysis.metrics?.[key]?.[index];
      const value = finite(point?.value), sources = Array.isArray(point?.sources) ? point.sources : [];
      return { period: compactPeriod(period), value, classification: value == null ? 'unavailable' : text(point?.classification, 40),
        formula: point?.formula ? text(point.formula) : null,
        reason: value == null ? text(point?.reason) || 'No compatible reported SEC fact is available for this annual period.' : null,
        sources: sources.slice(0, 32).map(compactSource), sourcesTruncated: sources.length > 32 };
    }) };
  });
  const available = metrics.some(metric => metric.points.some(point => point.value != null));
  return { status: available ? 'ready' : 'unavailable', lens: analysis.lens || null, basis: 'annual', asOf, periods, metrics,
    note: available ? FINANCIAL_NOTE : `No supported annual USD facts were available for this issuer. ${FINANCIAL_NOTE}` };
}
const unavailableFinancials = (asOf, reason) => ({ status: 'unavailable', lens: null, basis: 'annual', asOf, periods: [], metrics: [], note: `${reason} ${FINANCIAL_NOTE}` });
function compactHolding(holding) {
  return Object.fromEntries(['key', 'cusip', 'issuer', 'classTitle', 'putCall', 'quantity', 'quantityType', 'valueUsd', 'weightPct'].map(key => [key, holding[key] ?? null]));
}

/** Resolve an actual filed security first; issuer fundamentals never depend on
 * an assumed trading symbol or a caller-supplied company CIK. Existing loaders
 * retain their shared SEC gates, bounded caches and source identity checks. */
export function createThirteenFCompanyResearchLoader({
  portfolioLoader = loadThirteenF, identityLoader = loadThirteenFCompanyIdentity,
  companyLoader = loadFilingsCompany, researchJson = secResearchJson,
  analysisBuilder = buildAnalysisCompany, now = Date.now, deadlineMs = 55000,
} = {}) {
  return async (cikInput, { period: periodInput, key: keyInput, signal: callerSignal } = {}) => {
    const { cik, period, key } = normalize13FCompanyRequest(cikInput, periodInput, keyInput);
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(deadlineMs)]) : AbortSignal.timeout(deadlineMs);
    signal.throwIfAborted();
    const report = await portfolioLoader(cik, { period, signal });
    if (!sameCik(report?.manager?.cik, cik) || report.selectedPeriod !== period || !sameCik(report.portfolio?.cik, cik) || report.portfolio?.period !== period)
      throw fail('The selected SEC report could not be verified for this manager and quarter. Retry the report.', 502, 'REPORT_IDENTITY_MISMATCH');
    const matches = (report.portfolio.holdings || []).filter(holding => holding.key === key);
    if (matches.length !== 1) throw fail('This holding is not present in the selected manager report. Reopen it from the holdings table.', 404, 'HOLDING_NOT_FOUND');
    const holding = matches[0];
    if ([holding.cusip, holding.putCall || 'SECURITY', holding.quantityType].join('|') !== key)
      throw fail('The selected holding’s SEC identity could not be verified.', 502, 'HOLDING_IDENTITY_MISMATCH');
    const identity = await identityLoader(holding, { period, signal });
    signal.throwIfAborted();
    if (!identity || !['resolved', 'unresolved'].includes(identity.status) || identity.cusip !== holding.cusip)
      throw fail('The company evidence did not match the selected security. Retry this holding.', 502, 'ISSUER_IDENTITY_MISMATCH');
    const observedAt = new Date(now()).toISOString(), asOf = observedAt.slice(0, 10);
    const result = {
      status: identity.status === 'resolved' ? 'ready' : 'unresolved',
      manager: { cik, name: report.manager.name, submissionsUrl: report.manager.submissionsUrl }, selectedPeriod: period,
      holding: compactHolding(holding), identity,
      financials: unavailableFinancials(asOf, 'A verified SEC company link is required to show company financials.'), filings: [], observedAt,
      coverage: { selectedPeriodComplete: report.coverage?.selectedPeriodComplete === true, portfolioComplete: report.portfolio.complete === true },
      issues: [],
    };
    if (identity.status !== 'resolved') return result;
    const issuerCik = identity.issuer?.cik;
    if (!CIK.test(issuerCik || '') || Number(issuerCik) <= 0 || !identity.evidence?.length
      || identity.evidence.some(source => !sameCik(source.cik, issuerCik) || !source.cusips?.includes(holding.cusip)))
      throw fail('The SEC company identity is incomplete. Retry this holding.', 502, 'ISSUER_IDENTITY_MISMATCH');
    const [companyResult, factsResult] = await Promise.allSettled([
      companyLoader(issuerCik, { signal }).then(company => {
        if (!sameCik(company?.cik, issuerCik)) throw fail('SEC company submissions did not match the verified issuer.', 502, 'ISSUER_IDENTITY_MISMATCH');
        return company;
      }),
      researchJson(`/api/xbrl/companyfacts/CIK${issuerCik}.json`, signal).then(data => {
        if (!sameCik(data?.cik, issuerCik) || !data.facts || typeof data.facts !== 'object' || Array.isArray(data.facts))
          throw fail('SEC company facts did not match the verified issuer.', 502, 'ISSUER_IDENTITY_MISMATCH');
        return data.facts;
      }),
    ]);
    signal.throwIfAborted();
    const company = companyResult.status === 'fulfilled' ? companyResult.value : null;
    if (company) {
      result.filings = (company.filings || []).filter(filing => RESEARCH_FORMS.test(filing.form || '') && filing.filingDate <= asOf && secDocumentUrl(filing.documentUrl))
        .sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession)).slice(0, 12)
        .map(filing => ({ form: filing.form, filingDate: filing.filingDate, reportDate: filing.reportDate || null, accession: filing.accession, documentUrl: secDocumentUrl(filing.documentUrl) }));
      if (company.omittedRecords > 0) result.issues.push('Some SEC filing metadata could not be validated; the recent filing list may be incomplete.');
    } else result.issues.push('Recent issuer filings could not be retrieved. Retry this holding or open the verified SEC issuer page.');
    if (factsResult.status === 'fulfilled') {
      try {
        const analysis = analysisBuilder({ cik: issuerCik, ticker: '', companyName: company?.name || identity.issuer.name,
          sic: company?.sic || identity.issuer.sic || '', facts: factsResult.value, filings: company?.filings || [] }, { basis: 'annual', asOf, periodLimit: 4 });
        if (!sameCik(analysis?.cik, issuerCik)) throw fail('Company financial analysis did not retain the verified issuer identity.');
        result.financials = compactFinancials(analysis, asOf);
      } catch {
        result.financials = unavailableFinancials(asOf, 'The available SEC facts could not produce a compatible annual financial extract.');
        result.issues.push('Company financials are unavailable; use the original SEC reports to review the issuer.');
      }
    } else {
      result.financials = unavailableFinancials(asOf, 'SEC company facts could not be retrieved or verified for this issuer.');
      result.issues.push('The verified company link remains available. Retry to load its SEC financial facts.');
    }
    signal.throwIfAborted();
    return result;
  };
}

export const loadThirteenFCompanyResearch = createThirteenFCompanyResearchLoader();
