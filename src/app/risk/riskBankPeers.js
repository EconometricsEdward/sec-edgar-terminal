import { PEER_BENCHMARKS } from '../../utils/bank/peerMetrics.js';
import { peerDistribution } from '../../utils/bank/peerModel.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const identity = (value, rssd) => String(value) === String(rssd);
const keys = ['leverage', 'cet1', 'noncurrent', 'chargeoffs', 'loansDeposits', 'brokered', 'roa', 'nim'];
const states = new Set(['ready', 'small_cohort', 'insufficient_inputs', 'bank_not_covered', 'preparing']);
const profile = value => value && Number.isSafeInteger(value.rssd) && value.rssd > 0
  && typeof value.name === 'string' && value.name.trim()
  && [true, false, null].includes(value.cblr) && value.metrics && typeof value.metrics === 'object'
  && Object.values(value.metrics).every(n => n === null || finite(n));

/** This projection binds the legal bank, quarter and normalization version.
 * It never receives SEC or FFIEC card values, which can use different definitions.
 */
export function isRiskBankPeerResult(data, rssd, period) {
  if (!data || data.period !== period || !states.has(data.status)
    || !Array.isArray(data.peers) || data.peers.length > 30 || !Array.isArray(data.benchmarks)
    || !Number.isSafeInteger(data.universeCount) || !Number.isSafeInteger(data.eligibleCount)
    || data.universeCount < 0 || data.eligibleCount < 0 || data.eligibleCount > data.universeCount) return false;
  if (data.snapshot && (data.snapshot.report_date !== period || data.snapshot.model_version !== 'bankscope-peers-3' || !data.snapshot.id)) return false;
  if (!data.bank) return data.peers.length === 0 && data.benchmarks.length === 0;
  if (!data.snapshot || !profile(data.bank) || !identity(data.bank.rssd, rssd)) return false;
  const ids = new Set([String(rssd)]);
  return data.peers.every(peer => {
    if (!profile(peer) || ids.has(String(peer.rssd))) return false;
    ids.add(String(peer.rssd));
    return true;
  });
}

export function riskBankPeerView(data, rssd, period) {
  if (!isRiskBankPeerResult(data, rssd, period)) return null;
  if (!data.bank) return { ...data, metrics: [] };
  const metrics = keys.map(key => PEER_BENCHMARKS.find(metric => metric.key === key)).map(metric => {
    const usable = bank => (!metric.riskBased || bank.cblr === false) && finite(bank.metrics[metric.key]);
    const value = usable(data.bank) ? data.bank.metrics[metric.key] : null;
    const peers = data.peers.filter(usable).map(bank => ({ rssd: bank.rssd, name: bank.name, value: bank.metrics[metric.key] }));
    // Reuse the same distribution helper as BankScope. Framework exclusions are
    // explicit here too, so unverified/CBLR zero placeholders cannot become dots.
    const distribution = peerDistribution(peers.map(peer => ({ metrics: { [metric.key]: peer.value } })), metric.key, value);
    return { ...metric, ...distribution, peers,
      notRequired: Boolean(metric.riskBased && data.bank.cblr === true),
      frameworkUnverified: Boolean(metric.riskBased && data.bank.cblr === null) };
  });
  return { ...data, metrics };
}

export function riskBankPeerMetric(metrics, preferred = 'leverage') {
  return metrics.find(metric => metric.key === preferred)
    || metrics.find(metric => finite(metric.value) && metric.available)
    || metrics.find(metric => finite(metric.value)) || metrics[0] || null;
}

export function riskBankPeerSourceUrl(snapshot) {
  try {
    const url = new URL(snapshot?.source_url);
    return url.protocol === 'https:' && url.hostname === 'api.fdic.gov' ? url.href : null;
  } catch { return null; }
}
