/** Pure SEC-filing peer context. No market prices or return series. */
export const MIN_FUNDAMENTAL_PEERS = 8;
export const FUNDAMENTAL_PEER_Z_CLIP = 3;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const quantile = (sorted, probability) => {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability, lower = Math.floor(position), fraction = position - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
};
const median = values => quantile(values, .5);

export function calculateRobustPeerZ({ value, peerValues, minPeers = MIN_FUNDAMENTAL_PEERS, clip = FUNDAMENTAL_PEER_Z_CLIP } = {}) {
  const values = Array.isArray(peerValues) ? peerValues.filter(finite).sort((a, b) => a - b) : [];
  const center = median(values);
  const mad = center == null ? null : median(values.map(item => Math.abs(item - center)).sort((a, b) => a - b));
  const q1 = quantile(values, .25), q3 = quantile(values, .75);
  const mean = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : null;
  const standardDeviation = values.length > 1 ? Math.sqrt(values.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (values.length - 1)) : null;
  const candidates = [
    ['median_absolute_deviation', finite(mad) ? 1.4826 * mad : null],
    ['interquartile_range', finite(q1) && finite(q3) ? (q3 - q1) / 1.349 : null],
    ['sample_standard_deviation', standardDeviation],
  ];
  const chosen = candidates.find(([, scale]) => finite(scale) && scale > Number.EPSILON * Math.max(1, Math.abs(center ?? 0)));
  const distribution = { count: values.length, median: center, mad, q1, q3, standardDeviation, scale: chosen?.[1] ?? null, scaleMethod: chosen?.[0] ?? null, min: values[0] ?? null, max: values.at(-1) ?? null };
  if (!finite(value)) return { available: false, z: null, percentile: null, reason: 'The company filing change is unavailable.', distribution };
  if (!Number.isSafeInteger(minPeers) || minPeers < 2 || !finite(clip) || clip <= 0) return { available: false, z: null, percentile: null, reason: 'Peer-comparison settings are invalid.', distribution };
  if (values.length < minPeers) return { available: false, z: null, percentile: null, reason: `At least ${minPeers} compatible sector peers are required; ${values.length} are available.`, distribution };
  if (!chosen) return { available: false, z: null, percentile: null, reason: 'Compatible peer changes have no usable dispersion.', distribution };
  const rawZ = (value - center) / chosen[1];
  const below = values.filter(item => item < value).length, equal = values.filter(item => item === value).length;
  return { available: true, z: Math.max(-clip, Math.min(clip, rawZ)), rawZ, clipped: Math.abs(rawZ) > clip, percentile: 100 * (below + .5 * equal) / values.length, reason: null, distribution };
}

function issuerId(row) { return String(row?.cik || row?.ticker || '').replace(/^0+/, '').toUpperCase(); }

export function compareFundamentalPeer(row, universeRows, metric, options = {}) {
  const value = row?.metrics?.[metric]?.change;
  const peers = Array.isArray(universeRows) ? universeRows.filter(peer => peer && issuerId(peer) !== issuerId(row) && peer.group === row?.group && finite(peer.metrics?.[metric]?.change)) : [];
  const result = calculateRobustPeerZ({ value, peerValues: peers.map(peer => peer.metrics[metric].change), ...options });
  return {
    version: 'fundamental-peer-context-1.0.0', diagnostic_only: true,
    ticker: row?.ticker || null, cik: row?.cik || null, primary_sector: row?.group || null, metric,
    current: finite(row?.metrics?.[metric]?.current) ? row.metrics[metric].current : null,
    prior: finite(row?.metrics?.[metric]?.prior) ? row.metrics[metric].prior : null,
    change_percentage_points: finite(value) ? value : null,
    ...result,
    methodology: 'Leave-one-issuer-out comparison of the same SEC filing-derived measure within the same primary sector. Center is the median; scale uses MAD, then IQR, then sample standard deviation. No imputation or weight redistribution.',
  };
}
