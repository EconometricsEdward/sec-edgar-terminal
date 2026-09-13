/** A bounded operator summary; migration keys and payloads stay private. */
const families = new Set(['snapshot', 'checkpoint', 'research', 'document', 'reference', 'history']);
const numericFields = ['payloadBytes', 'rows', 'maxPayloadBytes', 'maxRows', 'maxTtlSeconds',
  'puts', 'deduplicatedPuts', 'evictedRows', 'expiredRows', 'expiredPendingRows'];
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;

export function summarizeDisposableCache(value, maintenanceSummary = null) {
  if (value?.schema !== 1 || !Array.isArray(value.families) || !timestamp(value.observedAt)) {
    return { status: 'unavailable' };
  }
  const groups = value.families.filter(group => families.has(group?.family)).slice(0, 6).map(group => ({
    family: group.family, ...Object.fromEntries(numericFields.map(key => [key, number(group[key])])),
    evictLive: group.evictLive === true, oldestExpiresAt: timestamp(group.oldestExpiresAt),
  }));
  if (groups.length !== 6 || new Set(groups.map(group => group.family)).size !== 6
    || groups.some(group => numericFields.some(key => group[key] === null))
    || ['payloadBytes', 'rows', 'maxPayloadBytes'].some(key => number(value[key]) === null)) {
    return { status: 'unavailable' };
  }
  const maintenance = value.maintenance || {};
  return {
    status: groups.some(group => group.maxPayloadBytes && group.payloadBytes / group.maxPayloadBytes >= .9
      || group.maxRows && group.rows / group.maxRows >= .9) ? 'watch' : 'healthy',
    observedAt: timestamp(value.observedAt), payloadBytes: number(value.payloadBytes), rows: number(value.rows),
    maxPayloadBytes: number(value.maxPayloadBytes), families: groups,
    maintenance: { mode: ['inventory', 'migrate', 'steady'].includes(maintenance.mode) ? maintenance.mode : null,
      modeChangedAt: timestamp(maintenance.modeChangedAt), updatedAt: timestamp(maintenance.updatedAt),
      summary: maintenanceSummary },
    measurement: 'Compressed cached payloads; physical database storage also includes indexes and other overhead.',
  };
}
