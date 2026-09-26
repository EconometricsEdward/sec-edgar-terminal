import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { allowedSource, fundingUrls, PLUMBING_VERSION, SWAP_HISTORY_REPORTS, SWAP_REPORTS } from './catalog.js';
import { normalizeRates, normalizeFails, parseSwapReport, normalizeSwapHistory, reportDate, reportTables, mergeSwapObservations } from './normalize.js';
import { marketResearchStore } from './store.js';

export function archiveSource(url, body, retrievedAt, acquisition = 'direct-http') {
  if (!allowedSource(url) || Buffer.byteLength(body) > 3 * 1024 * 1024) throw new Error('Invalid source capture');
  const gzip = gzipSync(body);
  if (gzip.byteLength > 1024 * 1024) throw new Error('Oversize source archive');
  const hash = createHash('sha256').update(body).digest('hex');
  return { url, hash, retrievedAt, acquisition, gzip: gzip.toString('base64') };
}
export async function fetchPublicSource(url, { fetchImpl = fetch, signal } = {}) {
  if (!allowedSource(url)) throw new Error('Unapproved source');
  const response = await fetchImpl(url, { redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: { Accept: 'application/json,text/html', 'User-Agent': 'SEC EDGAR Terminal public research https://secedgarterminal.com/about' } });
  if (!response.ok) throw new Error(`source_http_${response.status}`);
  if (Number(response.headers.get('content-length')) > 3 * 1024 * 1024) throw new Error('Oversize source response');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 3 * 1024 * 1024) throw new Error('Oversize source response'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function runMarketResearchWorker({ store = marketResearchStore, fetchImpl = fetch, now = () => new Date(), signal } = {}) {
  const claim = await store('begin', { owner: randomUUID() });
  if (!claim.allowed) return { status: 'not_due' };
  const result = { funding: 'unchanged', derivatives: 'unchanged', attemptedAt: now().toISOString() };
  const publish = (snapshot, archives) => store('publish', { owner: claim.owner, generation: claim.generation, snapshot, archives });
  try {
    try {
      const urls = fundingUrls(now()); const archives = [];
      const bodies = {};
      // Two bounded independent endpoints; no requests are started by visitors.
      await Promise.all(Object.entries(urls).map(async ([key, url]) => { bodies[key] = await fetchPublicSource(url, { fetchImpl, signal }); archives.push(archiveSource(url, bodies[key], now().toISOString())); }));
      const snapshot = { version: PLUMBING_VERSION, kind: 'funding', generatedAt: now().toISOString(), rates: normalizeRates(JSON.parse(bodies.rates)), fails: normalizeFails(JSON.parse(bodies.fails)),
        sources: archives.map(({ gzip: _gzip, ...source }) => source) };
      await publish(snapshot, archives); result.funding = 'updated';
    } catch (error) { result.funding = 'retained'; result.fundingError = /^source_http_\d+$/.test(error.message) ? error.message : 'source_validation_or_availability'; }
    try {
      const prior = await store('read', { kind: 'derivatives' }); const archives = [], reports = [];
      for (const definition of [...SWAP_HISTORY_REPORTS, ...SWAP_REPORTS]) {
        const body = await fetchPublicSource(definition.url, { fetchImpl, signal });
        const archive = archiveSource(definition.url, body, now().toISOString()); archives.push(archive);
        const rows = definition.asset ? parseSwapReport(body, definition) : normalizeSwapHistory({ date: reportDate(body), tables: reportTables(body), measure: definition.measure });
        reports.push(rows.map(row => ({ ...row, sourceHash: archive.hash })));
      }
      // Do not mix release vintages if upstream pages update during ingestion.
      const latest = reports.slice(3).map(rows => rows[0]?.date);
      if (new Set(latest).size !== 1 || reports.slice(0, 3).some(rows => [...rows].sort((a,b) => a.date.localeCompare(b.date)).at(-1)?.date !== latest[0])) throw new Error('Release dates differ');
      const snapshot = { version: PLUMBING_VERSION, kind: 'derivatives', generatedAt: now().toISOString(), observations: mergeSwapObservations(prior?.snapshot?.observations, reports),
        sources: archives.map(({ gzip: _gzip, ...source }) => source) };
      await publish(snapshot, archives); result.derivatives = 'updated';
    } catch (error) { result.derivatives = 'retained'; result.derivativesError = /^source_http_\d+$/.test(error.message) ? error.message : 'source_validation_or_availability'; }
    return result;
  } finally { await store('finish', { owner: claim.owner, generation: claim.generation, result }); }
}
