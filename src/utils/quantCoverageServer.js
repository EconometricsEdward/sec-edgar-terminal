import { createHash } from 'node:crypto';
import seed from '../data/quant-coverage.json' with { type: 'json' };
import { QUANT_GROUPS, QUANT_BATCHES, QUANT_COVERAGE_VERSION, QUANT_MAX_CHECKS_PER_BATCH, quantBatch, quantSectorForSic } from './quantGroups.js';
import { MEMBERSHIP_SOURCES, parseHoldingsCsv, buildMembership, buildExpandedMembership, retainedQuantBaseline, quantExcludedCandidates, isQuantMembership, EXPANDED_MEMBERSHIP_VERSION } from './quantMembership.js';
import { MARKET_LENSES } from './marketCohorts.js';
import { MARKET_VERSION } from './marketResearch.js';
import { buildMarketCompany, marketAcceptanceTimes, marketCompanySummary, MARKET_REVENUE_VERSION } from './marketResearchData.js';
import { isMarketAtlas } from './marketResearchValidation.js';
import { secFetch } from './secClient.js';
import { readPreparedSecDocument, refreshSecDocument, secDocumentIdentity } from './secDocumentStore.js';
import { getOperatingDirectorySnapshot } from './tickerMap.js';
import { warmGet, warmSet, warmGetMany, warmCacheEnabled, warmAcquireLease, warmReleaseLease } from './warmCache.js';
import { readSnapshot, writeSnapshot } from './snapshotCache.js';
import { publishMarketOverview } from './marketOverviewServer.js';
import { cacheDeploymentScope, isProductionDeployment } from './cacheScope.js';
import { revenueCorrectionPriority, recalculatePreparedMarketRevenue, withholdUncorrectedRevenue } from './marketRevenueCorrections.js';

const scope = cacheDeploymentScope();
export const QUANT_COVERAGE_CACHE = `${QUANT_COVERAGE_VERSION}:${scope}`;
export const QUANT_COMPANY_CACHE = `quant-company-v2:${scope}`;
export const QUANT_ATLAS_CACHE = `quant-atlas-v2:${scope}`;
const LEGACY_MEMBERSHIP_CACHE = 'quant-coverage-v1';
const LEGACY_COMPANY_CACHE = 'quant-company-v1';
const LEGACY_ATLAS_CACHE = 'quant-atlas-v1';
const LEGACY_CIKS = new Set(seed.rows.map(row => row.cik));
const DAY = 86400000;
const RETENTION = 8 * 86400;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export const membershipId = membership => hash(membership.rows.map(r => [r.cik, r.ticker, r.sector, r.fund]));

export async function readQuantMembership() {
  const [current, preservedLegacy] = await Promise.all([warmGet(QUANT_COVERAGE_CACHE, 'membership'), isProductionDeployment() ? warmGet(LEGACY_MEMBERSHIP_CACHE, 'membership') : null]);
  const cached = [current, preservedLegacy].find(isQuantMembership);
  return cached || seed;
}

/** Weekly membership discovery runs only in scheduled or bounded deployment work. */
export async function refreshQuantMembership({ signal, deadline = Date.now() + 80000 } = {}) {
  if (!warmCacheEnabled()) throw new Error('Shared coverage storage is unavailable.');
  const previous = await readQuantMembership();
  if (previous.version === EXPANDED_MEMBERSHIP_VERSION && Date.now() - Date.parse(previous.checked_at) < 7 * DAY) return { retained: true, issuers: previous.issuers };
  const lease = await warmAcquireLease(QUANT_COVERAGE_CACHE, 'membership', 90000);
  if (!lease) return { skipped: 'Membership refresh is already running.' };
  try {
    const holdings = []; let baseline, warning;
    try {
      for (const source of MEMBERSHIP_SOURCES) {
        const response = await fetch(source.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), cache: 'no-store' });
        if (!response.ok || Number(response.headers.get('content-length')) > 750000) throw new Error(`Holdings source unavailable: ${source.fund}.`);
        const reader = response.body.getReader(); const chunks = []; let bytes = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 750000) throw new Error('Holdings download exceeds the size limit.'); chunks.push(value); } }
        finally { await reader.cancel().catch(() => {}); }
        holdings.push(parseHoldingsCsv(Buffer.concat(chunks).toString('utf8'), source));
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      baseline = retainedQuantBaseline(previous);
      warning = 'Fund classifications are retained with their original source dates while the holdings provider is unavailable. Issuer identities are matched to the dated SEC directory.';
    }
    const directorySnapshot = await getOperatingDirectorySnapshot(), directory = directorySnapshot.data;
    if (!baseline) {
      try { baseline = buildMembership(holdings, directory, previous.rows.map(r => r.ticker)); }
      catch {
        baseline = retainedQuantBaseline(previous);
        warning = 'Fund classifications retain their original source dates while updated holdings mappings are checked. Issuer identities are matched to the dated SEC directory.';
      }
    }
    const supplemental = previous.rows.filter(row => row.fund === 'SEC');
    const records = supplemental.length ? await readQuantCheckpoints(supplemental.map(row => row.cik), { signal, deadline }) : [];
    const excludedCandidates = quantExcludedCandidates(previous, supplemental, records);
    const next = buildExpandedMembership(baseline, directory, previous, new Date(), { excludedCandidates, directoryFetchedAt: directorySnapshot.fetchedAt });
    if (directorySnapshot.stale) warning = [warning, `The SEC directory is retained from ${directorySnapshot.fetchedAt.slice(0, 10)} while its source is unavailable.`].filter(Boolean).join(' ');
    if (warning) next.membership_warning = warning;
    if (!await warmSet(QUANT_COVERAGE_CACHE, 'membership', next, 90 * 86400)) throw new Error('Membership could not be stored.');
    return { issuers: next.issuers, securities: next.securities, excluded_candidates: excludedCandidates.length, membership_id: membershipId(next), sources: next.sources, ...(warning ? { warning } : {}) };
  } finally { await warmReleaseLease(QUANT_COVERAGE_CACHE, 'membership', lease); }
}

export function filingFingerprint(submissions) {
  const recent = submissions?.filings?.recent;
  if (!Array.isArray(recent?.accessionNumber)) throw new Error('SEC filing history is incomplete.');
  return hash(recent.accessionNumber.flatMap((accession, index) => /^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(recent.form?.[index] || '') ? [[accession, recent.acceptanceDateTime?.[index], recent.reportDate?.[index]]] : []).slice(0, 40));
}
export function needsFactsRefresh(cached, fingerprint, now = Date.now()) {
  return cached?.needsReconciliation || cached?.company?.revenueVersion !== MARKET_REVENUE_VERSION || fingerprint !== cached.fingerprint || !Number.isFinite(Date.parse(cached.factsRetrievedAt)) || now - Date.parse(cached.factsRetrievedAt) >= 7 * DAY;
}

export function quantCheckpointFresh(record, now = Date.now()) {
  const age = now - Date.parse(record?.checkedAt);
  if (!Number.isFinite(age) || age < 0) return false;
  if (record?.eligibility === 'unsupported') return age < 7 * DAY;
  return Boolean(record?.company && !record.needsReconciliation && record.company.revenueVersion === MARKET_REVENUE_VERSION && age < 20 * 3600000);
}

/** Retired Redis checkpoints only existed for the original baseline universe. */
export async function readQuantCheckpoints(ids, options = {}, { readMany = warmGetMany, production = isProductionDeployment() } = {}) {
  const current = await readMany(QUANT_COMPANY_CACHE, ids, options);
  const missing = production ? ids.flatMap((id, index) => !current[index] && LEGACY_CIKS.has(id) ? [{ id, index }] : []) : [];
  if (missing.length) {
    const legacy = await readMany(LEGACY_COMPANY_CACHE, missing.map(item => item.id), options);
    missing.forEach((item, index) => { current[item.index] = legacy[index] || null; });
  }
  return current;
}

/** A directory ticker alone cannot admit funds or unsupported reporting taxonomies. */
export function quantCandidateEligibility(entry, submissions, facts = null) {
  if (Number(submissions?.cik) !== Number(entry.cik)) throw new Error('SEC submissions identity does not match the candidate issuer.');
  if (entry.fund !== 'SEC') return null;
  if (submissions.entityType && submissions.entityType !== 'operating') return 'SEC entity is not an operating company.';
  if (!submissions.filings?.recent?.form?.some(form => /^(10-K|10-Q)(\/A)?$/.test(form)))
    return 'No supported annual or quarterly operating-company report in recent SEC history.';
  if (facts && !facts.facts?.['us-gaap']) return 'SEC financial taxonomy is not supported by this comparison model.';
  return null;
}
async function secDocument(path, signal) {
  const prepared = await readPreparedSecDocument(path, { allowStale: false });
  if (prepared) return prepared;
  const response = await secFetch(`https://data.sec.gov${path}`, { headers: { Accept: 'application/json' }, signal, timeoutMs: 15000, retries: 1, cache: 'no-store' });
  if (!response.ok) throw new Error(`SEC returned HTTP ${response.status}.`);
  const payload = await response.json(), fetchedAt = new Date().toISOString();
  return { payload, metadata: { fetchedAt, revalidatedAt: fetchedAt } };
}
async function secJson(path, signal) {
  return (await secDocument(path, signal)).payload;
}
async function refreshCompany(entry, cached, signal) {
  const now = Date.now();
  if (quantCheckpointFresh(cached, now)) return { ...cached, reused: true };
  const submissions = await secJson(`/submissions/CIK${entry.cik}.json`, signal);
  const unsupported = async reason => {
    const record = { eligibility: 'unsupported', checkedAt: new Date().toISOString(), reason };
    if (!await warmSet(QUANT_COMPANY_CACHE, entry.cik, record, 14 * 86400)) throw new Error('Candidate eligibility could not be persisted.');
    return record;
  };
  const eligibility = quantCandidateEligibility(entry, submissions);
  if (eligibility) return unsupported(eligibility);
  const fingerprint = filingFingerprint(submissions);
  let company = cached?.company, factsRetrievedAt = cached?.factsRetrievedAt, factsValidatedAt = cached?.factsValidatedAt;
  if (needsFactsRefresh(cached, fingerprint, now)) {
    const factsEnvelope = await secDocument(`/api/xbrl/companyfacts/CIK${entry.cik}.json`, signal), facts = factsEnvelope.payload;
    if (!facts.facts || !submissions.sic || Number(facts.cik) !== Number(entry.cik)) throw new Error('SEC facts or industry identity are unavailable.');
    const taxonomy = quantCandidateEligibility(entry, submissions, facts);
    if (taxonomy) return unsupported(taxonomy);
    company = marketCompanySummary(buildMarketCompany({ ticker: entry.ticker, cik: entry.cik, name: submissions.name || entry.name, sic: submissions.sic, facts: facts.facts, acceptanceTimes: marketAcceptanceTimes(submissions) }, MARKET_LENSES.filter(c => c.tickers.includes(entry.ticker)).map(c => c.id)));
    if (entry.fund === 'SEC' && !['annual', 'ttm'].some(basis => company.reports?.[basis] && Object.values(company.metrics?.[basis] || {}).some(Number.isFinite)))
      return unsupported('No supported SEC financial observations are available.');
    factsRetrievedAt = factsEnvelope.metadata.fetchedAt;
    factsValidatedAt = factsEnvelope.metadata.revalidatedAt || factsRetrievedAt;
  }
  const checkedAt = new Date().toISOString();
  const recent=submissions.filings.recent;
  const latestIndex=recent.form.findIndex(form=>/^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(form));
  const expected=recent.accessionNumber[latestIndex];
  const represented=[company.reports?.annual?.accession,company.reports?.ttm?.accession,company.filingComparisons?.annual?.current?.accession,company.filingComparisons?.ttm?.current?.accession];
  const needsReconciliation=Boolean(expected)&&!represented.includes(expected);
  const result = { company, fingerprint, checkedAt, factsRetrievedAt, factsValidatedAt, attemptedAt: checkedAt, needsReconciliation };
  if (!await warmSet(QUANT_COMPANY_CACHE, entry.cik, result, 14 * 86400)) throw new Error('Company checkpoint could not be persisted.');
  return result;
}

/** Each daily shard is small and resumable; successful issuers never lose their checkpoint. */
export async function refreshQuantBatch(batch, { signal, deadline = Date.now() + 270000, tickers = null } = {}) {
  if (!Number.isSafeInteger(batch) || batch < 0 || batch >= QUANT_BATCHES) throw Object.assign(new Error('Invalid coverage batch.'), { status: 400 });
  if (tickers !== null && (!Array.isArray(tickers) || tickers.length < 1 || tickers.length > 160
    || tickers.some(ticker => !/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker)))) throw new Error('Choose at most 160 valid correction tickers.');
  if (!warmCacheEnabled()) throw new Error('Shared coverage storage is unavailable.');
  const lease = await warmAcquireLease(QUANT_COVERAGE_CACHE, `batch-${batch}`, 295000);
  if (!lease) return { skipped: 'Batch coordination is unavailable or another refresh is running.', batch };
  try {
    const selected = tickers ? new Set(tickers) : null;
    const membership = await readQuantMembership(), entries = membership.rows.filter(r => quantBatch(r.cik) === batch && (!selected || selected.has(r.ticker)));
    const ids = entries.map(r => r.cik);
    const cached = await readQuantCheckpoints(ids, { signal, deadline });
    const pending = entries.map((entry, index) => ({ entry, cached: cached[index] })).filter(item => !quantCheckpointFresh(item.cached));
    const attempts = await warmGetMany(`${QUANT_COMPANY_CACHE}:attempts`, pending.map(item => item.entry.cik), {signal,deadline});
    const due = pending.map((item, index) => ({ ...item, attemptedAt: new Date(Math.max(Date.parse(attempts[index]?.at)||0,Date.parse(item.cached?.attemptedAt)||0)).toISOString() }))
      // Maintain already-published baseline coverage while first-time issuers
      // warm gradually; a cold expansion cannot starve the existing service.
      .sort((a, b) => Number(a.entry.fund === 'SEC') - Number(b.entry.fund === 'SEC')
        || (Date.parse(a.attemptedAt) || 0) - (Date.parse(b.attemptedAt) || 0));
    const queue = due.slice(0, QUANT_MAX_CHECKS_PER_BATCH);
    const result = { batch, membership_id: membershipId(membership), requested: entries.length, checked: 0, unsupported: 0, reused: entries.length - due.length,
      failed: 0, skipped: 0, errors: [] };
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (queue.length && Date.now() < deadline - 22000 && !signal?.aborted) {
        const { entry, cached: prior } = queue.shift();
        try { const refreshed = await refreshCompany(entry, prior, signal); if (refreshed.eligibility === 'unsupported') result.unsupported++; else result.checked++; }
        catch (error) {
          result.failed++;
          if (result.errors.length < 8) result.errors.push({ ticker: entry.ticker, source: 'SEC', reason: error.message });
          await warmSet(`${QUANT_COMPANY_CACHE}:attempts`, entry.cik, { at: new Date().toISOString(), lastError: error.message }, 7 * 86400);
        }
      }
    }));
    result.skipped = queue.length + due.length - Math.min(due.length, QUANT_MAX_CHECKS_PER_BATCH);
    await warmSet(QUANT_COVERAGE_CACHE, `batch-${batch}`, { ...result, completed_at: new Date().toISOString() }, RETENTION);
    return result;
  } finally { await warmReleaseLease(QUANT_COVERAGE_CACHE, `batch-${batch}`, lease); }
}

export async function readQuantAtlas() {
  const caches = [QUANT_ATLAS_CACHE, ...(isProductionDeployment() ? [LEGACY_ATLAS_CACHE] : [])];
  for (const cache of caches) {
    for (const id of ['atlas', 'atlas-last-good']) {
      const atlas = await readSnapshot(cache, id);
      const age = Date.now() - Date.parse(atlas?.generatedAt);
      if (isMarketAtlas(atlas, MARKET_VERSION) && age >= 0 && age < 7 * DAY) return atlas;
    }
  }
  return null;
}

export async function prepareQuantAtlas({signal,deadline}={}) {
  const membership = await readQuantMembership();
  const ids = membership.rows.map(r => r.cik);
  const records = await readQuantCheckpoints(ids, {signal,deadline});
  return assembleQuantAtlas(membership, records);
}
export function assembleQuantAtlas(membership, records, now = Date.now()) {
  const companies = [], failures = [];
  membership.rows.forEach((entry, i) => {
    const record = records[i], age = now - Date.parse(record?.checkedAt);
    if (!record?.company || !Number.isFinite(age) || age < 0 || age > 30 * 3600000) {
      failures.push({ ticker: entry.ticker, reason: record?.reason || record?.lastError || 'A current SEC check is not available.', retryable: record?.eligibility !== 'unsupported' }); return;
    }
    const sector = entry.fund === 'SEC' ? quantSectorForSic(record.company.sic) : entry.sector;
    const group = QUANT_GROUPS.find(g => g.label === sector);
    companies.push({ ...record.company, ticker: entry.ticker, researchGroup: group, membershipFund: entry.fund,
      sectorSource: entry.fund === 'SEC' ? 'SEC SIC broad research group' : 'Fund-reported sector', checkedAt: record.checkedAt, factsRetrievedAt: record.factsRetrievedAt,
      ...(record.factsValidatedAt ? { factsValidatedAt: record.factsValidatedAt } : {}) });
  });
  const baseline = membership.rows.filter(entry => entry.fund !== 'SEC');
  const loadedBaseline = companies.filter(company => company.membershipFund !== 'SEC').length;
  if (loadedBaseline < Math.ceil(baseline.length * .95)) throw new Error(`Baseline SEC coverage is still preparing: ${loadedBaseline} of ${baseline.length} issuers checked. The prior snapshot remains available.`);
  const checked = companies.map(c => c.checkedAt).sort();
  const atlas = { version: MARKET_VERSION, generatedAt: new Date(now).toISOString(), requested: membership.issuers, companies, cohorts: MARKET_LENSES.map(c => ({ id: c.id, label: c.assetClass, title: c.title, description: c.description, tickers: c.tickers, disclosureTerms: c.disclosureTerms })), failures, observations: [], historyPersistence: true, groups: QUANT_GROUPS, coverage: { membership_id: membershipId(membership), target_issuers: membership.issuers, loaded_issuers: companies.length, missing_issuers: failures.length, unsupported_issuers: failures.filter(failure => !failure.retryable).length, source_securities: membership.securities, duplicate_share_classes: membership.securities - membership.issuers, sources: membership.sources, ...(membership.membership_warning ? { membership_warning: membership.membership_warning } : {}), membership_checked_at: membership.checked_at, sec_checked_earliest: checked[0], sec_checked_latest: checked.at(-1), grouping: 'Fund-reported sectors for IVV/IJH/IJR; broad SEC SIC research groups for supplemental issuers. One representative security per SEC issuer. Directory candidates enter aggregates only after financial validation.' } };
  if (!isMarketAtlas(atlas, MARKET_VERSION)) throw new Error('Expanded SEC snapshot failed validation.');
  return atlas;
}

export function chooseQuantAtlasPublication(previous, next, now = Date.now()) {
  const age = now - Date.parse(previous?.generatedAt);
  if (isMarketAtlas(previous, MARKET_VERSION) && age >= 0 && age < 7 * DAY) {
    const nextCiks = new Set(next.companies.map(company => company.cik));
    if (previous.companies.filter(company => nextCiks.has(company.cik)).length < previous.companies.length * .95) return previous;
  }
  return next;
}

export async function publishQuantAtlas(atlas, options={}) {
  const publication = chooseQuantAtlasPublication(await readQuantAtlas(), atlas);
  if (!await writeSnapshot(QUANT_ATLAS_CACHE, 'atlas-last-good', publication, 7*86400, options)) throw new Error('Expanded SEC snapshot could not be persisted.');
  if (!await writeSnapshot(QUANT_ATLAS_CACHE, 'atlas', publication, 7*86400, options)) throw new Error('Expanded SEC snapshot could not be published.');
  const membership = await readQuantMembership();
  await publishMarketOverview(publication, membershipId(membership) === publication.coverage.membership_id ? membership : null, options);
}

/** Deployment-only, bounded correction; source revalidation is explicitly opted in by the build. */
export async function refreshQuantRevenueCorrections({ signal, deadline = Date.now() + 180000,
  readAtlas = readQuantAtlas, read = warmGet, write = warmSet, prepared = readPreparedSecDocument,
  acquire = warmAcquireLease, release = warmReleaseLease, revalidateSources = false, refreshDocument = refreshSecDocument,
  refreshUnprepared = false, refreshBatch = refreshQuantBatch, preparedIdentity = secDocumentIdentity,
} = {}) {
  const atlas = await readAtlas();
  if (!atlas) return { corrected: 0, withheld: 0, remaining: 0, skipped: 'Prepared atlas unavailable.' };
  const queue = atlas.companies.filter(company => revenueCorrectionPriority(company) !== null)
    .sort((a, b) => revenueCorrectionPriority(a) - revenueCorrectionPriority(b) || a.ticker.localeCompare(b.ticker));
  const result = { candidates: queue.length, corrected: 0, withheld: 0, skipped: 0, remaining: 0, sourceRevalidations: 0, audited: [], errors: [] };
  const changes = new Map();
  const unprepared = [];
  for (const company of queue) {
    if (signal?.aborted || Date.now() >= deadline - 15000) break;
    const batchKey = `batch-${quantBatch(company.cik)}`;
    const lease = await acquire(QUANT_COVERAGE_CACHE, batchKey, 90000);
    if (!lease) { result.skipped++; continue; }
    try {
      // Respect the same shard lease as scheduled refreshes and re-read its
      // checkpoint after acquiring it so a delayed build cannot overwrite it.
      const record = await read(QUANT_COMPANY_CACHE, company.cik)
        || (isProductionDeployment() ? await read(LEGACY_COMPANY_CACHE, company.cik) : null);
      if (!record) { result.skipped++; continue; }
      let corrected = record?.company?.revenueVersion === MARKET_REVENUE_VERSION ? record.company : null;
      if (!corrected) {
        const currentCompany = { ...record.company, factsRetrievedAt: record.factsRetrievedAt,
          factsValidatedAt: record.factsValidatedAt, checkedAt: record.checkedAt };
        const paths = [`/api/xbrl/companyfacts/CIK${company.cik}.json`, `/submissions/CIK${company.cik}.json`];
        try {
          const [facts, submissions] = await Promise.all(paths.map(path => prepared(path, { allowStale: true })));
          corrected = recalculatePreparedMarketRevenue(currentCompany, facts, submissions);
        } catch (error) {
          let failure = error;
          const admitted = preparedIdentity(paths[0])?.covered;
          if (!admitted && refreshUnprepared) unprepared.push(company);
          if (admitted && revalidateSources && !signal?.aborted && Date.now() < deadline - 45000) {
            // Existing source refresh owns conditional requests, SEC pacing,
            // allowed coverage, identity validation and fenced publication.
            // A fresh source clock is required; the calculation guard stays strict.
            const refreshed = await Promise.allSettled(paths.map(path => refreshDocument(path, { signal, minRecheckAgeMs: 0 })));
            result.sourceRevalidations += refreshed.filter(item => item.status === 'fulfilled' && item.value?.envelope).length;
            try {
              if (refreshed.some(item => item.status === 'rejected')) throw refreshed.find(item => item.status === 'rejected').reason;
              corrected = recalculatePreparedMarketRevenue(currentCompany, refreshed[0].value?.envelope, refreshed[1].value?.envelope);
            } catch (refreshError) { failure = refreshError; }
          }
          if (!corrected) {
            corrected = withholdUncorrectedRevenue(record.company);
            if (result.errors.length < 8) result.errors.push({ ticker: company.ticker, reason: failure.message });
          }
        }
        if (!await write(QUANT_COMPANY_CACHE, company.cik, { ...record, company: corrected,
          checkedAt: corrected.checkedAt || record.checkedAt, factsRetrievedAt: corrected.factsRetrievedAt || record.factsRetrievedAt,
          ...(corrected.factsValidatedAt ? { factsValidatedAt: corrected.factsValidatedAt } : {}),
          ...(corrected.revenueVersion !== MARKET_REVENUE_VERSION ? { needsReconciliation: true } : {}) }, 14 * 86400)) {
          result.skipped++; continue;
        }
      }
      changes.set(company.cik, { ...company, ...corrected });
      if (corrected.revenueVersion === MARKET_REVENUE_VERSION) result.corrected++; else result.withheld++;
      if (revenueCorrectionPriority(company) < 3) result.audited.push({ ticker: company.ticker,
        annualRevenue: corrected.metrics.annual.revenue, ttmRevenue: corrected.metrics.ttm.revenue,
        revenueVersion: corrected.revenueVersion || null });
    } finally { await release(QUANT_COVERAGE_CACHE, batchKey, lease); }
  }
  // The existing Quant pipeline already supports these membership issuers
  // outside the prepared-SEC archive. Restrict it to this correction set;
  // source pacing, validation, shard leases and admission policy stay intact.
  for (const batch of [...new Set(unprepared.map(company => quantBatch(company.cik)))]) {
    if (signal?.aborted || Date.now() >= deadline - 30000) break;
    const members = unprepared.filter(company => quantBatch(company.cik) === batch);
    try {
      await refreshBatch(batch, { signal, deadline, tickers: members.map(company => company.ticker) });
      for (const company of members) {
        const record = await read(QUANT_COMPANY_CACHE, company.cik);
        if (record?.company?.revenueVersion === MARKET_REVENUE_VERSION) {
          changes.set(company.cik, record.company); result.corrected++; result.withheld--;
        }
      }
    } catch (error) { if (result.errors.length < 8) result.errors.push({ batch, reason: error.message }); }
  }
  result.remaining = queue.length - changes.size;
  return result;
}

/** Called under the universe publisher lease, including its retained-atlas path. */
export async function applyPreparedRevenueCorrections(atlas, { signal, deadline, readMany = warmGetMany } = {}) {
  const candidates = atlas.companies.filter(company => revenueCorrectionPriority(company) !== null
    || company.revenueVersion === MARKET_REVENUE_VERSION && company.revenueQuality === 'awaiting-compatible-source');
  if (!candidates.length) return atlas;
  const records = await readMany(QUANT_COMPANY_CACHE, candidates.map(company => company.cik), { signal, deadline });
  const changes = new Map();
  candidates.forEach((company, index) => {
    const record = records[index], corrected = record?.company;
    if (!corrected || corrected.revenueVersion !== MARKET_REVENUE_VERSION && corrected.revenueQuality !== 'awaiting-compatible-source') return;
    // A checkpoint can be older than an independently published snapshot.
    // Never move source knowledge or a reported fiscal period backwards.
    if (Number(company.cik) !== Number(corrected.cik)
      || company.checkedAt && (!Number.isFinite(Date.parse(record.checkedAt)) || Date.parse(record.checkedAt) < Date.parse(company.checkedAt))
      || (company.factsValidatedAt || company.factsRetrievedAt) && (!Number.isFinite(Date.parse(record.factsValidatedAt || record.factsRetrievedAt))
        || Date.parse(record.factsValidatedAt || record.factsRetrievedAt) < Date.parse(company.factsValidatedAt || company.factsRetrievedAt))
      || ['annual', 'ttm'].some(basis => company.reports?.[basis]?.end
        && (!corrected.reports?.[basis]?.end || corrected.reports[basis].end < company.reports[basis].end
          || corrected.reports[basis].end === company.reports[basis].end && corrected.reports[basis].filed < company.reports[basis].filed))) return;
    const merged = { ...company, ...corrected, checkedAt: record.checkedAt,
      factsRetrievedAt: record.factsRetrievedAt, ...(record.factsValidatedAt ? { factsValidatedAt: record.factsValidatedAt } : {}) };
    if (corrected.revenueVersion === MARKET_REVENUE_VERSION) delete merged.revenueQuality;
    changes.set(company.cik, merged);
  });
  return changes.size ? { ...atlas, generatedAt: new Date().toISOString(),
    companies: atlas.companies.map(company => changes.get(company.cik) || company) } : atlas;
}
