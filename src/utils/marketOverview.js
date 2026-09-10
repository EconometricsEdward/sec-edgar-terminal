import { MARKET_VERSION, MARKET_METRICS, metricStats } from './marketResearch.js';

export const MARKET_OVERVIEW_VERSION = 'market-overview-v1';

/** Display data only: full filing provenance remains in the research atlas. */
export function buildMarketOverview(atlas, { membership = null, previous = null, persistHistory = false } = {}) {
  const expanded = Boolean(atlas.coverage);
  const companies = atlas.companies.map(company => ({
    version: company.version, ticker: company.ticker, name: company.name, cik: company.cik,
    sic: String(company.sic), revenueBasis: company.revenueBasis, observedAt: company.observedAt,
    cohorts: [...new Set([...(expanded ? [company.researchGroup.id] : []), ...company.cohorts])],
    ...(expanded ? { sector: company.researchGroup.label, coverageFund: company.membershipFund,
      secCheckedAt: company.checkedAt, factsRetrievedAt: company.factsRetrievedAt } : {}),
    metrics: Object.fromEntries(['annual', 'ttm'].map(basis => [basis, Object.fromEntries(
      MARKET_METRICS.map(metric => [metric.key, company.metrics[basis]?.[metric.key] ?? null]),
    )])),
    reports: company.reports, ...(company.cache ? { cache: company.cache } : {}),
  })).sort((a, b) => a.ticker.localeCompare(b.ticker));
  const cohorts = expanded ? atlas.groups.map(group => ({
    id: group.id, label: group.label, title: `${group.label} companies`,
    description: 'One primary sector per issuer, using the published fund classification.',
    disclosureTerms: group.label,
    tickers: membership ? membership.rows.filter(row => row.sector === group.label).map(row => row.ticker)
      : companies.filter(company => company.cohorts.includes(group.id)).map(company => company.ticker),
    targetKnown: Boolean(membership),
  })) : atlas.cohorts;
  const themes = expanded ? atlas.cohorts.map(cohort => ({ ...cohort,
    tickers: companies.filter(company => company.cohorts.includes(cohort.id)).map(company => company.ticker),
  })).filter(cohort => cohort.tickers.length) : [];
  const sameMembership = previous?.coverage?.membership_id === atlas.coverage?.membership_id;
  let observations = expanded ? sameMembership ? previous?.observations || [] : [] : atlas.observations;
  if (persistHistory && expanded) {
    const observation = { observedAt: atlas.generatedAt, companies: companies.length,
      tickers: companies.map(company => company.ticker),
      revenueGrowth: metricStats(companies, 'ttm', 'revenueGrowth'), netMargin: metricStats(companies, 'ttm', 'netMargin') };
    observations = [...observations.filter(row => row.observedAt !== observation.observedAt), observation].slice(-30);
  }
  return { version: MARKET_VERSION, viewVersion: MARKET_OVERVIEW_VERSION,
    generatedAt: atlas.generatedAt, requested: atlas.requested, companies, cohorts, themes,
    failures: atlas.failures, ...(expanded ? { coverage: atlas.coverage } : {}),
    observations, historyPersistence: expanded ? persistHistory || Boolean(previous?.historyPersistence) : atlas.historyPersistence,
    ...(expanded && !sameMembership ? { historyNote: 'Expanded coverage starts a new history segment. Changes from the earlier research universe are not market trends.' } : {}),
    ...(atlas.cache ? { cache: atlas.cache } : {}),
  };
}

/** Keep shared sector filters through tab changes and honor heatmap selections. */
export function updateMarketView(view, patch) {
  const next = { ...view, ...patch };
  if (next.tab === 'factors' && next.cohort !== 'all' && !next.cohort.startsWith('sector-')) next.cohort = 'all';
  return next;
}
