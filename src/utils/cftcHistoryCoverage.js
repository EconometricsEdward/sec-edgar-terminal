const FAMILIES = ['tff', 'disaggregated'];
const REPORT_BASIS = 'futures_only';
const SHARDS = 32;
const MAX_CONTRACTS = 1000;

function count(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CONTRACTS;
}

function reportDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function publicSummary(value) {
  if (!value || !FAMILIES.includes(value.family) || value.report_basis !== REPORT_BASIS || !reportDate(value.report_date)) return null;
  const { contracts_total, contracts_prepared, contracts_limited, contracts_pending, contracts_unavailable } = value;
  if (![contracts_total, contracts_prepared, contracts_limited, contracts_pending, contracts_unavailable].every(count)
    || contracts_total < 1 || contracts_limited > contracts_prepared
    || contracts_prepared + contracts_pending + contracts_unavailable !== contracts_total) return null;
  return { family: value.family, report_basis: REPORT_BASIS, report_date: value.report_date,
    contracts_total, contracts_prepared, contracts_limited, contracts_pending, contracts_unavailable };
}

/** Publish only complete, unambiguous catalogs for the currently served report. */
export function publicCftcHistoryCoverage(value, cacheStatus) {
  if (value?.enabled !== true || !Array.isArray(value.jobs) || value.jobs.length > 64 || !Array.isArray(cacheStatus?.families)) return [];
  return FAMILIES.flatMap(family => {
    const served = cacheStatus.families.filter(item => item?.family === family);
    if (served.length !== 1 || !['ready', 'partial', 'stale'].includes(served[0].status) || !reportDate(served[0].report_date)) return [];
    // A revised same-date catalog must not inherit the earlier catalog's counts.
    // Omit ambiguous groups until status can establish a single current catalog.
    const candidates = value.jobs.filter(job => job?.family === family && job.reportDate === served[0].report_date);
    if (candidates.length !== 1) return [];
    const job = candidates[0], counters = job.counters;
    if (!/^[a-f0-9]{64}$/.test(job.catalogHash || '') || job.shards !== SHARDS
      || !Array.isArray(job.shardIndexes) || job.shardIndexes.length !== SHARDS
      || new Set(job.shardIndexes).size !== SHARDS
      || !job.shardIndexes.every(index => Number.isInteger(index) && index >= 0 && index < SHARDS)
      || !counters || ![counters.contracts, counters.visited, counters.prepared, counters.limited, counters.failed].every(count)
      || counters.visited > counters.contracts || counters.prepared + counters.failed > counters.visited) return [];
    const allTerminal = Number.isInteger(job.done) && Number.isInteger(job.dead) && job.done >= 0 && job.dead >= 0 && job.done + job.dead === SHARDS;
    // Terminal shards cannot still be preparing. Omit a stale or inconsistent
    // aggregate instead of presenting its unvisited contracts as queued work.
    if (allTerminal && counters.prepared + counters.failed !== counters.contracts) return [];
    const summary = publicSummary({ family, report_basis: REPORT_BASIS, report_date: job.reportDate,
      contracts_total: counters.contracts, contracts_prepared: counters.prepared, contracts_limited: counters.limited,
      contracts_pending: counters.contracts - counters.prepared - counters.failed, contracts_unavailable: counters.failed });
    return summary ? [summary] : [];
  });
}

/** Client and server both reject counts from another family, date, or catalog size. */
export function selectCftcHistoryCoverage(summaries, family, date, catalogSize) {
  if (!Array.isArray(summaries) || summaries.length > FAMILIES.length || !FAMILIES.includes(family) || !reportDate(date) || !count(catalogSize)) return null;
  const matches = summaries.filter(item => item?.family === family && item.report_date === date);
  if (matches.length !== 1) return null;
  const summary = publicSummary(matches[0]);
  return summary?.contracts_total === catalogSize ? summary : null;
}
