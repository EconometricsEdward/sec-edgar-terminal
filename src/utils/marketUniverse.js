/** Pure SEC-derived diagnostics for the covered issuer universe. */
import { MARKET_LENSES } from './marketCohorts.js';
import { UNIVERSE_METRICS, finite, computeFundamentalDiagnostics, normalizeChangeThreshold, FUNDAMENTAL_DEFINITIONS } from './marketFundamentals.js';

export const UNIVERSE_VERSION = 'edgar.factor-universe.v2';
export const UNIVERSE_METHOD = 'fundamental-universe-2.0.0';
export const UNIVERSE_FRESH_MS = 25 * 3600_000;
export const UNIVERSE_GROUPS = MARKET_LENSES.map(cohort => ({ id: cohort.id, label: cohort.assetClass }));
export { UNIVERSE_METRICS, finite, distribution } from './marketFundamentals.js';

export function uniqueIssuers(companies) {
  const seen = new Set();
  return [...companies].sort((a, b) => a.ticker.localeCompare(b.ticker)).filter(company => {
    const id = String(company.cik || company.ticker).replace(/^0+/, '');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function financialIssuer(company) {
  const sic = Number(company.sic);
  return sic >= 6000 && sic <= 6799;
}

export function summarizeScope(rows, threshold = 0) {
  const diagnostics = computeFundamentalDiagnostics(rows, threshold);
  const comparable = rows.filter(row => UNIVERSE_METRICS.some(metric => finite(row.metrics[metric.key]?.change))).length;
  return { companies: rows.length, comparable_companies: comparable, comparable_coverage: rows.length ? comparable / rows.length : 0, ...diagnostics };
}

const pct = value => finite(value) ? `${value.toFixed(1)}%` : 'unavailable';
export function universeBrief(scope) {
  const growth = scope.breadth[0], margin = scope.breadth[1], cash = scope.cash_confirmation, notes = [];
  const bandNote = scope.threshold ? ` Direction counts require a change beyond ±${scope.threshold} percentage points.` : '';
  if (growth.eligible >= 8 && growth.eligible >= growth.population_count * .6) notes.push(`${growth.higher} of ${growth.eligible} comparable issuers (${pct(growth.higher_pct)}) reported faster revenue growth. The median acceleration was ${growth.change.median.toFixed(2)} percentage points.${bandNote}`);
  else notes.push('Comparable revenue-growth coverage is limited. Missing issuers remain outside the denominator.');
  if (cash.eligible >= 8 && cash.coverage >= .6) notes.push(`${cash.both_higher} issuers reported both faster revenue growth and a higher free-cash-flow margin on the same comparable filing set. Capital investment and working-capital timing can explain lower cash margins.`);
  if (margin.eligible >= 8 && margin.eligible >= margin.population_count * .6) notes.push(`Operating-margin dispersion across the same paired issuers is ${Math.abs(margin.paired_iqr_change) < .005 ? 'approximately unchanged' : margin.paired_iqr_change > 0 ? 'wider' : 'narrower'}: the current middle-50% range is ${margin.current.iqr.toFixed(2)} versus ${margin.prior.iqr.toFixed(2)} percentage points.`);
  if (scope.simultaneous_weakening.eligible) notes.push(`${scope.simultaneous_weakening.count} of ${scope.simultaneous_weakening.eligible} eligible operating issuers weakened simultaneously in revenue-growth acceleration, operating margin, and free-cash-flow margin.`);
  return notes;
}

function universeRow(company, basis) {
  const comparison = company.filingComparisons?.[basis];
  const valid = comparison?.pointInTime === true && comparison.gapDays >= 350 && comparison.gapDays <= 380;
  const financial = financialIssuer(company);
  const metrics = Object.fromEntries(UNIVERSE_METRICS.map(({ key, population }) => {
    const supported = population === 'all' || !financial;
    const current = valid && supported ? comparison.current?.metrics?.[key] : null;
    const prior = valid && supported ? comparison.prior?.metrics?.[key] : null;
    return [key, {
      current: finite(current) ? current : null,
      prior: finite(prior) ? prior : null,
      change: finite(current) && finite(prior) ? current - prior : null,
      unavailable_reason: !supported ? 'ISSUER_TYPE_EXCLUDED' : !valid ? 'NO_COMPARABLE_PERIOD' : !finite(current) || !finite(prior) ? 'MISSING_FILING_INPUT' : null,
    }];
  }));
  const group = company.researchGroup?.id || company.cohorts?.[0] || 'unclassified';
  return {
    ticker: company.ticker, cik: company.cik, name: company.name, group, cohorts: company.cohorts || [], coverage_fund: company.membershipFund || null,
    sec_checked_at: company.checkedAt || company.observedAt || null, facts_retrieved_at: company.factsRetrievedAt || company.observedAt || null,
    financial, metrics,
    source_accessions: [...new Set([...(comparison?.current?.factorSourceAccessions || []), ...(comparison?.prior?.factorSourceAccessions || [])])],
    filed: comparison?.current?.filed ?? null, fiscal_end: comparison?.current?.end ?? null, prior_fiscal_end: comparison?.prior?.end ?? null,
    accession: comparison?.current?.accession ?? null,
    source: comparison?.current?.accession ? `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${comparison.current.accession.replaceAll('-', '')}/` : null,
  };
}

export function buildUniverseSnapshot(atlas, _retiredSeries = {}, { basis = 'ttm', now = new Date() } = {}) {
  const companies = uniqueIssuers(atlas.companies || []);
  const rows = companies.map(company => universeRow(company, basis));
  const groupDefinitions = [{ id: 'all', label: 'All covered issuers' }, ...(atlas.groups || UNIVERSE_GROUPS), ...(companies.some(company => !company.researchGroup && !company.cohorts?.length) ? [{ id: 'unclassified', label: 'Unclassified' }] : [])];
  const scopes = Object.fromEntries(groupDefinitions.map(group => {
    const selected = group.id === 'all' ? rows : rows.filter(row => row.group === group.id);
    const summary = summarizeScope(selected);
    return [group.id, { ...group, ...summary, brief: universeBrief(summary) }];
  }));
  const age = now.getTime() - Date.parse(atlas.generatedAt);
  const secStale = atlas.cache?.status === 'stale' || !finite(age) || age < 0 || age > UNIVERSE_FRESH_MS;
  const issuerCoverage = atlas.requested ? rows.length / atlas.requested : 0;
  const observedDuplicateShareClasses = Math.max(0, (atlas.companies?.length || 0) - rows.length);
  const declaredDuplicateShareClasses = Number.isInteger(atlas.coverage?.duplicate_share_classes) && atlas.coverage.duplicate_share_classes >= 0 ? atlas.coverage.duplicate_share_classes : 0;
  return {
    schema_version: UNIVERSE_VERSION, methodology_version: UNIVERSE_METHOD, diagnostics_version: 'fundamental-diagnostics-2.0.0',
    fundamental_definitions: FUNDAMENTAL_DEFINITIONS, generated_at: now.toISOString(), sec_snapshot_at: atlas.generatedAt, sec_stale: secStale,
    basis, status: secStale ? 'stale' : issuerCoverage >= .95 ? 'ready' : 'partial',
    universe: { requested: atlas.requested, issuers: rows.length, coverage: atlas.coverage || null, issuer_coverage: issuerCoverage, share_classes_excluded: Math.max(declaredDuplicateShareClasses, observedDuplicateShareClasses), grouping: atlas.coverage?.grouping || 'One primary research group per issuer.' },
    scopes, rows, history: [],
    limitations: [
      atlas.coverage ? 'Coverage is drawn from published IVV, IJH and IJR equity holdings mapped to SEC issuers. It is a research coverage proxy, not certified current index membership or the whole U.S. market. Each issuer is equally weighted.' : 'Coverage is the current EDGAR Terminal SEC research universe, not the whole U.S. market; there are no market-cap weights.',
      'Comparisons use the same issuer’s current and comparable prior-year filing values at the current filing cutoff. Fiscal ends differ.',
      'Changes in ratios use percentage points. Missing values are excluded, never counted as unchanged. Financial issuers are excluded from operating-margin, free-cash-flow-margin and cash/assets breadth.',
      'These are descriptive accounting diagnostics. They do not use security prices, returns, volatility, beta, correlations, or post-filing market response and are not forecasts or trade signals.',
    ],
    links: { methodology: 'https://secedgarterminal.com/market/factors', schema: 'https://secedgarterminal.com/schemas/factor-universe-v2.schema.json', api: `https://secedgarterminal.com/api/v2/factor-universe?basis=${basis}` },
  };
}

export function upgradeUniverseSnapshot(snapshot) {
  if (snapshot?.schema_version !== UNIVERSE_VERSION) throw new Error('Legacy price-derived universe snapshots cannot be upgraded or republished. Rebuild from preserved SEC inputs.');
  const scopes = Object.fromEntries(Object.entries(snapshot.scopes || {}).map(([id, scope]) => {
    const rows = id === 'all' ? snapshot.rows : snapshot.rows.filter(row => row.group === id);
    const diagnostics = summarizeScope(rows, scope.threshold || 0);
    return [id, { ...scope, ...diagnostics, brief: universeBrief(diagnostics) }];
  }));
  return { ...snapshot, methodology_version: UNIVERSE_METHOD, diagnostics_version: 'fundamental-diagnostics-2.0.0', fundamental_definitions: FUNDAMENTAL_DEFINITIONS, scopes };
}

export function universeMarkdown(snapshot, group = 'all', selectedThreshold = 0) {
  const base = snapshot.scopes[group] || snapshot.scopes.all;
  const rows = base.id === 'all' ? snapshot.rows : snapshot.rows.filter(row => row.group === base.id);
  const scope = summarizeScope(rows, normalizeChangeThreshold(selectedThreshold));
  const sourceLinks = rows.filter(row => row.source).slice(0, 25).map(row => `- ${row.ticker}: ${row.source}`);
  return [`# SEC Fundamental Lab`, `Generated: ${snapshot.generated_at}`, `SEC snapshot: ${snapshot.sec_snapshot_at}`, `Basis: ${snapshot.basis}`, `Scope: ${base.label} · ${rows.length} issuers`, '', '## What changed', ...universeBrief(scope).map(note => `- ${note}`), '', '## Coverage', `Comparable companies: ${scope.comparable_companies} of ${scope.companies}. Missing values are excluded per measure.`, `Direction threshold: ±${scope.threshold} percentage points.`, '', '## Method', FUNDAMENTAL_DEFINITIONS.direction, FUNDAMENTAL_DEFINITIONS.breadth, FUNDAMENTAL_DEFINITIONS.magnitude, FUNDAMENTAL_DEFINITIONS.dispersion, '', '## SEC filing evidence', ...sourceLinks, '', 'No security-price, return, volatility, beta, correlation, or post-filing market-response data is used. These diagnostics are descriptive, not forecasts or trade signals.'].join('\n');
}
