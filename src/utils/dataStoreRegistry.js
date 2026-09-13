/** Explicitly approved datasets; this is not a redirect for arbitrary cache keys. */
export const DATA_STORE_REGISTRY = Object.freeze({
  cftc: Object.freeze({
    flag: 'EDGAR_DATASTORE_CFTC', schemaVersion: '1',
    origins: ['https://publicreporting.cftc.gov', 'https://www.cftc.gov'],
    attribution: 'U.S. Commodity Futures Trading Commission, Commitments of Traders',
    rights: 'Public government data; preserve CFTC source attribution and methodology.',
    cadence: 'Weekly report; retain scheduled release/revision checks and provider cooldowns.',
    validation: 'Existing CFTC basis, family, identity, completeness and formula-version validation.',
  }),
  sec: Object.freeze({
    flag: 'EDGAR_DATASTORE_SEC', schemaVersion: '1',
    origins: ['https://data.sec.gov', 'https://www.sec.gov'],
    attribution: 'U.S. Securities and Exchange Commission, EDGAR',
    rights: 'Public filings; documents may contain issuer-owned material. Preserve evidence links.',
    cadence: 'Bounded cohort revalidation; updates follow filings, not page traffic.',
    validation: 'Canonical SEC CIK and approved submissions/companyfacts resource only.',
  }),
  financial: Object.freeze({
    flag: 'EDGAR_DATASTORE_FINANCIAL', schemaVersion: '1',
    origins: ['https://data.sec.gov', 'https://www.sec.gov'],
    attribution: 'Derived from SEC EDGAR using existing validated calculations.',
    rights: 'Derived metrics with original filing/concept/period evidence retained.',
    cadence: 'Rebuild only for changed source documents or calculation version.',
    validation: 'Preserve period reconciliation, missing values and existing calculation lineage.',
  }),
});

export const DATA_STORE_LIMITS = Object.freeze({
  compactBytes: 64 * 1024,
  metadataBytes: 32 * 1024,
  decodedBytes: 24 * 1024 * 1024,
  objectBytes: 6 * 1024 * 1024,
  rpcBytes: 512 * 1024,
  observations: 512,
  requestTimeoutMs: 8000,
});

export function getDataStoreMode(dataset, env = process.env) {
  const entry = DATA_STORE_REGISTRY[dataset];
  if (!entry) throw new Error('Unregistered durable dataset');
  const mode = String(env[entry.flag] || 'off').toLowerCase();
  // A misspelt rollout flag must not accidentally enable a new data path.
  return ['shadow', 'supabase'].includes(mode) ? mode : 'off';
}

export function validateDataStoreSource(dataset, sourceUrl) {
  const entry = DATA_STORE_REGISTRY[dataset];
  if (!entry) throw new Error('Unregistered durable dataset');
  const url = new URL(sourceUrl);
  if (!entry.origins.includes(url.origin) || url.username || url.password || url.hash) {
    throw new Error('Unapproved durable source origin');
  }
  return url.href;
}
