import { createHash } from 'node:crypto';
import { limitedText } from './client.js';
import { bankRssd } from './catalog.js';
import { getOperatingDirectorySnapshot } from '../tickerMap.js';
import { ORGANIZATION_VERSION, organizationProfile, organizationPeers, organizationOffices, parentSecCandidates } from './organizationModel.js';

const BASE = 'https://api.fdic.gov/banks/';
const FIELDS = ['FED_RSSD', 'CERT', 'NAME', 'CITY', 'STALP', 'ACTIVE', 'CALLFORM', 'LEI', 'RSSDHCR', 'NAMEHCR', 'CITYHCR', 'STALPHCR', 'REPDTE', 'RUNDATE', 'DATEUPDT', 'ESTYMD', 'INSDATE', 'OFFICES', 'OFFDOM', 'OFFFOR', 'PRIORNAME1', 'PRIORNAME2', 'PRIORNAME3', 'PRIORNAME4', 'PRIORNAME5'];

export function organizationSourceUrl(kind, identity) {
  const value = bankRssd(identity);
  const options = kind === 'profile' ? ['institutions', `FED_RSSD:${value} AND ACTIVE:1`, FIELDS, 2, 'CERT']
    : kind === 'peers' ? ['institutions', `RSSDHCR:${value} AND ACTIVE:1`, ['FED_RSSD', 'CERT', 'NAME', 'CITY', 'STALP', 'ACTIVE', 'CALLFORM', 'RSSDHCR', 'REPDTE'], 1000, 'CERT']
      : kind === 'offices' ? ['locations', `CERT:${value}`, ['UNINUM', 'CERT', 'STALP'], 10000, 'UNINUM'] : null;
  if (!options) throw new Error('Unknown organization source');
  const [endpoint, filters, fields, limit, sort] = options;
  return `${BASE}${endpoint}?${new URLSearchParams({ filters, fields: fields.join(','), limit: String(limit), sort_by: sort, sort_order: 'ASC', format: 'json' })}`;
}

/** Bounded, coalesced public reads. Current structure is never backdated to a Call Report. */
export function createOrganizationService({ fetchImpl = fetch, directory = getOperatingDirectorySnapshot, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  let providerRetryAt = 0;
  async function source(kind, identity) {
    const url = organizationSourceUrl(kind, identity), key = `${kind}:${identity}`;
    if (cache.get(key)?.until > now()) return cache.get(key).data;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 8 || providerRetryAt > now()) throw new Error('Organization source is busy');
    const task = (async () => {
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) {
        if ([403, 429, 503].includes(response.status)) providerRetryAt = now() + 60000;
        throw new Error('Organization source unavailable');
      }
      const raw = await limitedText(response, 2 * 1024 * 1024), body = JSON.parse(raw);
      const maximum = kind === 'profile' ? 1 : kind === 'peers' ? 1000 : 10000;
      if (!Number.isSafeInteger(body.meta?.total) || body.meta.total < 0 || body.meta.total > maximum
        || !Array.isArray(body.data) || body.data.length !== body.meta.total || !body.meta.index?.name
        || body.data.some(row => !row?.data || typeof row.data !== 'object')) throw new Error('Incomplete organization source');
      const data = { rows: body.data.map(row => row.data), source: { url, index: body.meta.index.name,
        updatedAt: body.meta.index.createTimestamp || null, retrievedAt: new Date(now()).toISOString(),
        sha256: createHash('sha256').update(raw).digest('hex') } };
      if (cache.size >= 96) cache.delete(cache.keys().next().value);
      cache.set(key, { until: now() + (data.rows.length ? 3600000 : 60000), data });
      return data;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  return async (input, part = 'profile') => {
    const rssd = bankRssd(input);
    if (!['profile', 'network', 'sec'].includes(part)) throw new Error('Unknown organization view');
    const record = await source('profile', rssd);
    if (!record.rows.length) return { rssd, version: ORGANIZATION_VERSION, unavailable: 'institution_not_found', source: record.source };
    const bank = organizationProfile(record.rows[0], rssd);
    if (part === 'profile') return { rssd, version: ORGANIZATION_VERSION, bank, source: record.source };
    if (part === 'sec') {
      let sec = { status: bank.parent ? 'unavailable' : 'no_parent', candidates: [] };
      if (bank.parent) {
        try {
          const snapshot = await directory();
          sec = { status: snapshot.stale ? 'stale' : 'ready', candidates: parentSecCandidates(bank.parent, snapshot),
            fetchedAt: snapshot.fetchedAt, sourceUrl: 'https://www.sec.gov/files/company_tickers.json' };
        } catch { /* SEC availability must not erase a valid regulatory relationship. */ }
      }
      return { rssd, version: ORGANIZATION_VERSION, parentRssd: bank.parent?.rssd || null, sec, source: record.source };
    }
    const [offices, peers] = await Promise.allSettled([
      source('offices', bank.cert).then(data => ({ ...organizationOffices(data.rows, bank.cert), source: data.source })),
      bank.parent ? source('peers', bank.parent.rssd).then(data => ({ banks: organizationPeers(data.rows, bank.parent.rssd, rssd), source: data.source })) : Promise.resolve(null),
    ]);
    return { rssd, version: ORGANIZATION_VERSION, parentRssd: bank.parent?.rssd || null,
      offices: offices.status === 'fulfilled' ? offices.value : null,
      peers: peers.status === 'fulfilled' ? peers.value : null,
      missing: [['offices', offices], ['peers', peers]].filter(([, r]) => r.status === 'rejected').map(([key]) => key), source: record.source };
  };
}
export const getBankOrganization = createOrganizationService();
