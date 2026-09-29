import { REFINANCING_VERSION, MATURITY_BUCKETS } from './maturities.js';
import { quantSectorForSic, QUANT_GROUPS } from '../quantGroups.js';

export const REFINANCING_WALL_VERSION = 'market-refinancing-v1';
export const REFINANCING_RETENTION_MS = 7 * 86400000;
export const REFINANCING_FRESH_MS = 25 * 3600000;
export const REFINANCING_MAX_BYTES = 20 * 1024 * 1024;
const METRICS = ['cash', 'operatingCashFlow', 'operatingIncome', 'interestExpense', 'interestCoverage', 'cashToNext12m'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableNumber = value => value === null || typeof value === 'number' && Number.isFinite(value);
const text = (value, limit) => typeof value === 'string' && value.length <= limit;
const sameAmount = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-10;

/** Checkpoints already contain ~4 KB of financial comparisons per issuer.
 * Tuple packing keeps 5,000-company atlases below their 32 MiB decoded ceiling;
 * bucket names/concepts come from the versioned catalog, not guessed text. */
export function packRefinancingProfile(input) {
  const profile = compactRefinancingProfile(input);
  if (!profile || !isRefinancingProfile(profile, profile.cik)) return null;
  return { schemaVersion: REFINANCING_VERSION, packed: true, cik: profile.cik,
    context: [profile.status, profile.asOf, profile.filedAt, profile.accession, profile.form, profile.basis],
    reason: profile.coverage.reason,
    buckets: profile.buckets.map(bucket => [bucket.value, bucket.startDate, bucket.endDate, bucket.calendarYear, bucket.dateBasis, bucket.reason]),
    metrics: METRICS.map(key => { const metric = profile.metrics[key];
      return [metric.value, metric.tag, metric.startDate, metric.endDate, metric.reason, metric.formula || null]; }),
    warnings: profile.warnings,
  };
}

function unpackRefinancingProfile(profile) {
  if (profile.schemaVersion !== REFINANCING_VERSION || !Array.isArray(profile.context) || profile.context.length !== 6
    || !Array.isArray(profile.buckets) || ![0, 6].includes(profile.buckets.length)
    || profile.buckets.some(bucket => !Array.isArray(bucket) || bucket.length !== 6)
    || !Array.isArray(profile.metrics) || profile.metrics.length !== METRICS.length
    || profile.metrics.some(metric => !Array.isArray(metric) || metric.length !== 6)) return null;
  const [status, asOf, filedAt, accession, form, basis] = profile.context;
  const buckets = profile.buckets.map(([value, startDate, endDate, calendarYear, dateBasis, reason], index) => {
    const definition = MATURITY_BUCKETS[index];
    return { key: definition.key, label: basis === 'fiscal' ? definition.label
      : definition.key === 'next12m' ? 'Next 12 months' : definition.year ? `Rolling year ${definition.year}` : 'Thereafter',
    value, startDate, endDate, calendarYear, dateBasis, reason,
    tag: `LongTermDebtMaturitiesRepaymentsOfPrincipal${basis === 'fiscal' ? definition.suffix : definition.rollingSuffix}` };
  });
  const reportedBuckets = buckets.filter(bucket => bucket.value !== null).length;
  const reportedSubtotal = reportedBuckets ? buckets.reduce((sum, bucket) => sum + (bucket.value ?? 0), 0) : null;
  const complete = reportedBuckets === 6;
  return { schemaVersion: profile.schemaVersion, cik: profile.cik, currency: 'USD', status, reason: profile.reason,
    asOf, filedAt, accession, form, basis,
    sourceUrl: accession ? `https://www.sec.gov/Archives/edgar/data/${Number(profile.cik)}/${String(accession).replaceAll('-', '')}/${accession}-index.html` : null,
    buckets, totalScheduled: complete ? reportedSubtotal : null, reportedSubtotal,
    coverage: { reportedBuckets, totalBuckets: 6, complete, reason: profile.reason },
    metrics: Object.fromEntries(METRICS.map((key, index) => {
      const [value, tag, startDate, endDate, reason, formula] = profile.metrics[index];
      return [key, { value, tag, startDate, endDate, reason, ...(formula ? { formula } : {}) }];
    })), warnings: profile.warnings,
  };
}

/** Filing identity is shared by every bucket/metric. Keep the concept and
 * observation dates, but do not repeat the same filing URL twelve times. */
export function compactRefinancingProfile(profile) {
  if (!record(profile)) return null;
  if (profile.packed === true) return unpackRefinancingProfile(profile);
  const { ticker: _ticker, name: _name, sector: _sector, ...rest } = profile;
  return { ...rest,
    buckets: (profile.buckets || []).map(({ source: _source, ...bucket }) => bucket),
    metrics: Object.fromEntries(METRICS.map(key => {
      const { source: _source, sources: _sources, ...metric } = profile.metrics?.[key] || {};
      return [key, metric];
    })),
  };
}

export function isRefinancingProfile(profile, cik) {
  if (!record(profile) || profile.schemaVersion !== REFINANCING_VERSION || profile.cik !== cik
    || profile.currency !== 'USD' || !['ready', 'unavailable'].includes(profile.status)
    || !Array.isArray(profile.buckets) || ![0, 6].includes(profile.buckets.length)
    || !record(profile.coverage) || profile.coverage.totalBuckets !== 6
    || !Number.isInteger(profile.coverage.reportedBuckets) || profile.coverage.reportedBuckets < 0 || profile.coverage.reportedBuckets > 6
    || !Array.isArray(profile.warnings) || profile.warnings.length > 10 || profile.warnings.some(value => !text(value, 800))
    || !record(profile.metrics) || !METRICS.every(key => record(profile.metrics[key]) && nullableNumber(profile.metrics[key].value)
      && (profile.metrics[key].tag === null || text(profile.metrics[key].tag, 180))
      && (profile.metrics[key].startDate === null || date(profile.metrics[key].startDate))
      && (profile.metrics[key].endDate === null || date(profile.metrics[key].endDate))
      && (profile.metrics[key].reason === null || text(profile.metrics[key].reason, 200)))) return false;
  if (!profile.buckets.length) return profile.status === 'unavailable' && profile.asOf === null && profile.filedAt === null
    && profile.accession === null && profile.sourceUrl === null && profile.basis === null && profile.coverage.reportedBuckets === 0
    && profile.totalScheduled === null && profile.reportedSubtotal === null && profile.coverage.complete === false
    && METRICS.every(key => profile.metrics[key].value === null);
  if (!date(profile.asOf) || !date(profile.filedAt) || profile.filedAt < profile.asOf
    || !/^\d{10}-\d{2}-\d{6}$/.test(profile.accession || '') || !['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A'].includes(profile.form)
    || !['fiscal', 'rolling'].includes(profile.basis)
    || profile.sourceUrl !== `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${profile.accession.replaceAll('-', '')}/${profile.accession}-index.html`) return false;
  if (!profile.buckets.every((bucket, index) => record(bucket) && bucket.key === MATURITY_BUCKETS[index].key
    && text(bucket.label, 80) && nullableNumber(bucket.value) && (bucket.value === null || bucket.value >= 0)
    && date(bucket.startDate) && (bucket.endDate === null || date(bucket.endDate))
    && (bucket.calendarYear === null || Number.isInteger(bucket.calendarYear) && bucket.calendarYear >= 1900 && bucket.calendarYear <= 2200)
    && ['calendar-year', 'anniversary-estimate'].includes(bucket.dateBasis) && text(bucket.tag, 180)
    && (bucket.reason === null || text(bucket.reason, 200)))) return false;
  const reported = profile.buckets.filter(bucket => bucket.value !== null), complete = reported.length === 6;
  const total = reported.reduce((sum, bucket) => sum + bucket.value, 0);
  return profile.coverage.reportedBuckets === reported.length && profile.coverage.complete === complete
    && profile.status === (reported.length ? 'ready' : 'unavailable')
    && (reported.length ? typeof profile.reportedSubtotal === 'number' && sameAmount(profile.reportedSubtotal, total) : profile.reportedSubtotal === null)
    && (complete ? typeof profile.totalScheduled === 'number' && sameAmount(profile.totalScheduled, total) : profile.totalScheduled === null);
}

export function buildRefinancingCompany(company) {
  const sector = company.researchGroup?.label || company.sector || quantSectorForSic(company.sic);
  const sectorId = QUANT_GROUPS.find(group => group.label === sector)?.id || 'sector-unclassified';
  const cik = String(company.cik).padStart(10, '0');
  const candidate = compactRefinancingProfile(company.refinancing);
  return { cik, ticker: company.ticker, name: company.name, sic: String(company.sic), sector, sectorId,
    checkedAt: company.refinancingSource?.revalidatedAt || company.checkedAt || company.observedAt,
    factsRetrievedAt: company.refinancingSource?.fetchedAt || company.factsRetrievedAt || company.observedAt,
    profile: isRefinancingProfile(candidate, cik) ? candidate : null };
}

function withCoverage(value, companies) {
  const checkedCompanies = companies.filter(company => company.profile).length;
  const coveredCompanies = companies.filter(company => company.profile?.status === 'ready').length;
  return { ...value,
    coverage: { totalCandidates: value.coverage.totalCandidates, loadedCompanies: companies.length, checkedCompanies, coveredCompanies,
      completeCompanies: companies.filter(company => company.profile?.coverage.complete).length,
      missingScheduleCompanies: checkedCompanies - coveredCompanies, pendingCompanies: companies.length - checkedCompanies },
    companies,
    sectors: QUANT_GROUPS.map(group => ({ ...group, companies: companies.filter(company => company.sectorId === group.id).length,
      coveredCompanies: companies.filter(company => company.sectorId === group.id && company.profile?.status === 'ready').length }))
      .filter(group => group.companies),
  };
}

/** Only scheduled publication scans the prepared company universe. */
export function buildRefinancingWall(atlas) {
  const companies = (atlas?.companies || []).map(buildRefinancingCompany).sort((a, b) => a.ticker.localeCompare(b.ticker));
  return withCoverage({ version: REFINANCING_WALL_VERSION, extractionVersion: REFINANCING_VERSION,
    generatedAt: atlas.generatedAt, sourceSnapshotAt: atlas.generatedAt, membershipId: atlas.coverage?.membership_id || null,
    coverage: { totalCandidates: atlas.requested } }, companies);
}

/** Merge only matching identities already present in this membership snapshot.
 * A partial shard never refreshes untouched source dates or the snapshot's
 * retention clock. Full publishers use this too before replacing a projection. */
export function mergeRefinancingWall(previous, updates, generatedAt = previous.generatedAt) {
  if (!isRefinancingWall(previous) || !Array.isArray(updates) || updates.length > 5000
    || !timestamp(generatedAt) || Date.parse(generatedAt) < Date.parse(previous.generatedAt)) return previous;
  const incoming = new Map(updates.map(company => [company?.cik, company]));
  let changed = false;
  const companies = previous.companies.map(company => {
    const next = incoming.get(company.cik);
    if (!next || !timestamp(next.checkedAt) || !timestamp(next.factsRetrievedAt)
      || !isRefinancingProfile(next.profile, company.cik)
      || Date.parse(next.checkedAt) > Date.parse(generatedAt) + 60000
      || Date.parse(next.factsRetrievedAt) > Date.parse(next.checkedAt)) return company;
    if (company.profile) {
      if (Date.parse(next.checkedAt) < Date.parse(company.checkedAt)
        || Date.parse(next.factsRetrievedAt) < Date.parse(company.factsRetrievedAt)) return company;
      // Equal source clocks are idempotent. Newer annual evidence may still
      // replace an old filing discovered in the same immutable source version.
      const newerSource = Date.parse(next.checkedAt) > Date.parse(company.checkedAt)
        || Date.parse(next.factsRetrievedAt) > Date.parse(company.factsRetrievedAt);
      const newerFiling = next.profile.asOf && (!company.profile.asOf || next.profile.asOf > company.profile.asOf
        || next.profile.asOf === company.profile.asOf && next.profile.filedAt > company.profile.filedAt);
      if (!newerSource && !newerFiling) return company;
      if (next.profile.asOf && company.profile.asOf && (next.profile.asOf < company.profile.asOf
        || next.profile.asOf === company.profile.asOf && next.profile.filedAt < company.profile.filedAt)) return company;
    }
    // Pending rows inherit Market's observation clock, not a maturity-source
    // clock. Initial archived evidence keeps its own true dates even when older.
    changed = true;
    return { ...company, checkedAt: next.checkedAt, factsRetrievedAt: next.factsRetrievedAt, profile: next.profile };
  });
  if (!changed) return previous;
  const { cache: _cache, ...base } = previous;
  return withCoverage({ ...base, generatedAt }, companies);
}

export function isRefinancingWall(value) {
  if (!record(value) || value.version !== REFINANCING_WALL_VERSION || value.extractionVersion !== REFINANCING_VERSION
    || !timestamp(value.generatedAt) || !timestamp(value.sourceSnapshotAt)
    || !record(value.coverage) || !Array.isArray(value.companies) || !value.companies.length || value.companies.length > 5000
    || !Number.isInteger(value.coverage.totalCandidates) || value.coverage.totalCandidates < value.companies.length
    || value.coverage.totalCandidates > 10000 || value.coverage.loadedCompanies !== value.companies.length
    || new Set(value.companies.map(company => company.cik)).size !== value.companies.length
    || !value.companies.every(company => record(company) && /^(?!0000000000)\d{10}$/.test(company.cik)
      && text(company.ticker, 20) && company.ticker.length > 0 && text(company.name, 300)
      && text(company.sic, 8) && timestamp(company.checkedAt) && timestamp(company.factsRetrievedAt)
      && QUANT_GROUPS.some(group => group.id === company.sectorId && group.label === company.sector)
      && (company.profile === null || isRefinancingProfile(company.profile, company.cik)))) return false;
  const checked = value.companies.filter(company => company.profile).length;
  const covered = value.companies.filter(company => company.profile?.status === 'ready').length;
  if (value.coverage.checkedCompanies !== checked || value.coverage.coveredCompanies !== covered
    || value.coverage.completeCompanies !== value.companies.filter(company => company.profile?.coverage.complete).length
    || value.coverage.missingScheduleCompanies !== checked - covered || value.coverage.pendingCompanies !== value.companies.length - checked) return false;
  const sectorIds = new Set(value.companies.map(company => company.sectorId));
  return Array.isArray(value.sectors) && value.sectors.length === sectorIds.size && new Set(value.sectors.map(group => group.id)).size === sectorIds.size
    && value.sectors.every(group => QUANT_GROUPS.some(known => known.id === group.id && known.label === group.label)
      && group.companies === value.companies.filter(company => company.sectorId === group.id).length
      && group.coveredCompanies === value.companies.filter(company => company.sectorId === group.id && company.profile?.status === 'ready').length);
}
