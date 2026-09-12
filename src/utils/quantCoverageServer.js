import { createHash } from 'node:crypto';
import seed from '../data/quant-coverage.json' with { type: 'json' };
import { QUANT_GROUPS, QUANT_BATCHES, QUANT_COVERAGE_VERSION, quantBatch } from './quantGroups.js';
import { MEMBERSHIP_SOURCES, parseHoldingsCsv, buildMembership } from './quantMembership.js';
import { MARKET_LENSES } from './marketCohorts.js';
import { MARKET_VERSION } from './marketResearch.js';
import { buildMarketCompany, marketAcceptanceTimes, marketCompanySummary } from './marketResearchData.js';
import { isMarketAtlas } from './marketResearchValidation.js';
import { secFetch } from './secClient.js';
import { getOperatingTickers } from './tickerMap.js';
import { warmGet, warmSet, warmGetMany, warmCacheEnabled, warmAcquireLease, warmReleaseLease } from './warmCache.js';
import { readSnapshot, writeSnapshot } from './snapshotCache.js';
import { publishMarketOverview } from './marketOverviewServer.js';

export const QUANT_COMPANY_CACHE = 'quant-company-v1';
export const QUANT_ATLAS_CACHE = 'quant-atlas-v1';
const LEGACY_MEMBERSHIP_CACHE = 'quant-coverage-v1';
const DAY = 86400000;
const RETENTION = 8 * 86400;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export const membershipId = membership => hash(membership.rows.map(r => [r.cik, r.ticker, r.sector, r.fund]));

export async function readQuantMembership() {
  const [current, preservedLegacy] = await Promise.all([warmGet(QUANT_COVERAGE_VERSION, 'membership'), warmGet(LEGACY_MEMBERSHIP_CACHE, 'membership')]);
  const cached = [current, preservedLegacy].find(value => value?.version === seed.version && value.rows?.length >= 1450 && value.rows?.length <= 1600);
  return cached || seed;
}

/** Three small holdings downloads weekly, outside all page request paths. */
export async function refreshQuantMembership({ signal } = {}) {
  if (!warmCacheEnabled()) throw new Error('Shared coverage storage is unavailable.');
  const previous = await readQuantMembership();
  if (Date.now() - Date.parse(previous.checked_at) < 7 * DAY) return { retained: true, issuers: previous.issuers };
  const lease = await warmAcquireLease(QUANT_COVERAGE_VERSION, 'membership', 90000);
  if (!lease) return { skipped: 'Membership refresh is already running.' };
  try {
    const holdings = [];
    for (const source of MEMBERSHIP_SOURCES) {
      const response = await fetch(source.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), cache: 'no-store' });
      if (!response.ok || Number(response.headers.get('content-length')) > 750000) throw new Error(`Holdings source unavailable: ${source.fund}.`);
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 750000) throw new Error('Holdings download exceeds the size limit.'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      holdings.push(parseHoldingsCsv(Buffer.concat(chunks).toString('utf8'), source));
    }
    const directory = await getOperatingTickers(holdings.flatMap(s => s.rows.map(r => r.ticker)));
    const next = buildMembership(holdings, directory, previous.rows.map(r => r.ticker));
    if (!await warmSet(QUANT_COVERAGE_VERSION, 'membership', next, 90 * 86400)) throw new Error('Membership could not be stored.');
    return { issuers: next.issuers, securities: next.securities, membership_id: membershipId(next), sources: next.sources };
  } finally { await warmReleaseLease(QUANT_COVERAGE_VERSION, 'membership', lease); }
}

export function filingFingerprint(submissions) {
  const recent = submissions?.filings?.recent;
  if (!Array.isArray(recent?.accessionNumber)) throw new Error('SEC filing history is incomplete.');
  return hash(recent.accessionNumber.flatMap((accession, index) => /^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(recent.form?.[index] || '') ? [[accession, recent.acceptanceDateTime?.[index], recent.reportDate?.[index]]] : []).slice(0, 40));
}
export function needsFactsRefresh(cached, fingerprint, now = Date.now()) {
  return cached?.needsReconciliation || !cached?.company || fingerprint !== cached.fingerprint || !Number.isFinite(Date.parse(cached.factsRetrievedAt)) || now - Date.parse(cached.factsRetrievedAt) >= 7 * DAY;
}
async function secJson(path, signal) {
  const response = await secFetch(`https://data.sec.gov${path}`, { headers: { Accept: 'application/json' }, signal, timeoutMs: 15000, retries: 0, cache: 'no-store' });
  if (!response.ok) throw new Error(`SEC returned HTTP ${response.status}.`);
  return response.json();
}
async function refreshCompany(entry, cached, signal) {
  const now = Date.now();
  if (!cached?.needsReconciliation && cached?.checkedAt && now - Date.parse(cached.checkedAt) < 20 * 3600000) return { ...cached, reused: true };
  const submissions = await secJson(`/submissions/CIK${entry.cik}.json`, signal);
  const fingerprint = filingFingerprint(submissions);
  let company = cached?.company, factsRetrievedAt = cached?.factsRetrievedAt;
  if (needsFactsRefresh(cached, fingerprint, now)) {
    const facts = await secJson(`/api/xbrl/companyfacts/CIK${entry.cik}.json`, signal);
    if (!facts.facts || !submissions.sic || Number(facts.cik) !== Number(entry.cik)) throw new Error('SEC facts or industry identity are unavailable.');
    company = marketCompanySummary(buildMarketCompany({ ticker: entry.ticker, cik: entry.cik, name: submissions.name || entry.name, sic: submissions.sic, facts: facts.facts, acceptanceTimes: marketAcceptanceTimes(submissions) }, MARKET_LENSES.filter(c => c.tickers.includes(entry.ticker)).map(c => c.id)));
    factsRetrievedAt = new Date().toISOString();
  }
  const checkedAt = new Date().toISOString();
  const recent=submissions.filings.recent;
  const latestIndex=recent.form.findIndex(form=>/^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(form));
  const expected=recent.accessionNumber[latestIndex];
  const represented=[company.reports?.annual?.accession,company.reports?.ttm?.accession,company.filingComparisons?.annual?.current?.accession,company.filingComparisons?.ttm?.current?.accession];
  const needsReconciliation=Boolean(expected)&&!represented.includes(expected);
  const result = { company, fingerprint, checkedAt, factsRetrievedAt, attemptedAt: checkedAt, needsReconciliation };
  if (!await warmSet(QUANT_COMPANY_CACHE, entry.cik, result, 30 * 86400)) throw new Error('Company checkpoint could not be persisted.');
  return result;
}

/** Each daily shard is small and resumable; successful issuers never lose their checkpoint. */
export async function refreshQuantBatch(batch, { signal, deadline = Date.now() + 270000 } = {}) {
  if (!Number.isSafeInteger(batch) || batch < 0 || batch >= QUANT_BATCHES) throw Object.assign(new Error('Invalid coverage batch.'), { status: 400 });
  if (!warmCacheEnabled()) throw new Error('Shared coverage storage is unavailable.');
  const lease = await warmAcquireLease(QUANT_COVERAGE_VERSION, `batch-${batch}`, 295000);
  if (!lease) return { skipped: 'Batch coordination is unavailable or another refresh is running.', batch };
  try {
    const membership = await readQuantMembership(), entries = membership.rows.filter(r => quantBatch(r.cik) === batch);
    const cached = await warmGetMany(QUANT_COMPANY_CACHE, entries.map(r => r.cik), {signal,deadline});
    const attempts = await warmGetMany(`${QUANT_COMPANY_CACHE}:attempts`, entries.map(r=>r.cik), {signal,deadline});
    const queue = entries.map((entry, i) => ({ entry, cached: cached[i], attemptedAt: new Date(Math.max(Date.parse(attempts[i]?.at)||0,Date.parse(cached[i]?.attemptedAt)||0)).toISOString() })).sort((a, b) => (Date.parse(a.attemptedAt) || 0) - (Date.parse(b.attemptedAt) || 0));
    const result = { batch, membership_id: membershipId(membership), requested: entries.length, checked: 0, failed: 0, skipped: 0, errors: [] };
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (queue.length && Date.now() < deadline - 22000 && !signal?.aborted) {
        const { entry, cached: prior } = queue.shift();
        try { await refreshCompany(entry, prior, signal); result.checked++; }
        catch (error) {
          result.failed++;
          if (result.errors.length < 8) result.errors.push({ ticker: entry.ticker, source: 'SEC', reason: error.message });
          await warmSet(`${QUANT_COMPANY_CACHE}:attempts`, entry.cik, { at: new Date().toISOString(), lastError: error.message }, 30 * 86400);
        }
      }
    }));
    result.skipped = queue.length;
    await warmSet(QUANT_COVERAGE_VERSION, `batch-${batch}`, { ...result, completed_at: new Date().toISOString() }, RETENTION);
    return result;
  } finally { await warmReleaseLease(QUANT_COVERAGE_VERSION, `batch-${batch}`, lease); }
}

export async function readQuantAtlas() {
  for (const id of ['atlas', 'atlas-last-good']) {
    const atlas = await readSnapshot(QUANT_ATLAS_CACHE, id);
    const age = Date.now() - Date.parse(atlas?.generatedAt);
    if (isMarketAtlas(atlas, MARKET_VERSION) && age >= 0 && age < 7 * DAY) return atlas;
  }
  return null;
}

export async function prepareQuantAtlas({signal,deadline}={}) {
  const membership = await readQuantMembership();
  const records = await warmGetMany(QUANT_COMPANY_CACHE, membership.rows.map(r => r.cik), {signal,deadline});
  return assembleQuantAtlas(membership, records);
}
export function assembleQuantAtlas(membership, records, now = Date.now()) {
  const companies = [], failures = [];
  membership.rows.forEach((entry, i) => {
    const record = records[i], age = now - Date.parse(record?.checkedAt);
    if (!record?.company || !Number.isFinite(age) || age < 0 || age > 30 * 3600000) {
      failures.push({ ticker: entry.ticker, reason: record?.lastError || 'A current SEC check is not available.', retryable: true }); return;
    }
    const group = QUANT_GROUPS.find(g => g.label === entry.sector);
    companies.push({ ...record.company, ticker: entry.ticker, researchGroup: group, membershipFund: entry.fund, checkedAt: record.checkedAt, factsRetrievedAt: record.factsRetrievedAt });
  });
  if (companies.length < Math.ceil(membership.issuers * .95)) throw new Error(`Expanded SEC coverage is still preparing: ${companies.length} of ${membership.issuers} issuers checked. The prior snapshot remains available.`);
  const checked = companies.map(c => c.checkedAt).sort();
  const atlas = { version: MARKET_VERSION, generatedAt: new Date(now).toISOString(), requested: membership.issuers, companies, cohorts: MARKET_LENSES.map(c => ({ id: c.id, label: c.assetClass, title: c.title, description: c.description, tickers: c.tickers, disclosureTerms: c.disclosureTerms })), failures, observations: [], historyPersistence: true, groups: QUANT_GROUPS, coverage: { membership_id: membershipId(membership), target_issuers: membership.issuers, loaded_issuers: companies.length, missing_issuers: failures.length, source_securities: membership.securities, duplicate_share_classes: membership.securities - membership.issuers, sources: membership.sources, membership_checked_at: membership.checked_at, sec_checked_earliest: checked[0], sec_checked_latest: checked.at(-1), grouping: 'Fund-reported sectors; one primary sector and one representative security per SEC issuer.' } };
  if (!isMarketAtlas(atlas, MARKET_VERSION)) throw new Error('Expanded SEC snapshot failed validation.');
  return atlas;
}

export async function publishQuantAtlas(atlas, options={}) {
  if (!await writeSnapshot(QUANT_ATLAS_CACHE, 'atlas-last-good', atlas, 7*86400, options)) throw new Error('Expanded SEC snapshot could not be persisted.');
  if (!await writeSnapshot(QUANT_ATLAS_CACHE, 'atlas', atlas, 7*86400, options)) throw new Error('Expanded SEC snapshot could not be published.');
  const membership = await readQuantMembership();
  await publishMarketOverview(atlas, membershipId(membership) === atlas.coverage.membership_id ? membership : null, options);
}
