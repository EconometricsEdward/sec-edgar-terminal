/** Payment receipts are admitted only from the existing production workload. */
export const X402_RPC_PARAMETERS = Object.freeze({
  edgar_x402_claim: ['p_payment', 'p_owner'],
  edgar_x402_finish: ['p_claim', 'p_receipt'],
});
export const X402_LIMITS = Object.freeze({ rpcBytes: 8192, amount: '10000', maxAuthorizationSeconds: 86400 });
const HASH = /^[a-f0-9]{64}$/;
const ADDRESS = /^0x[a-f0-9]{40}$/;
const TRANSACTION = /^0x[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ASSETS = Object.freeze({
  'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
});
const NETWORKS = new Set(Object.keys(ASSETS));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
export function validX402Resource(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://secedgarterminal.com' && url.pathname.startsWith('/api/x402/v1/')
      && url.pathname.length > '/api/x402/v1/'.length && !url.username && !url.password && !url.hash
      && !/[\u0000-\u001f\u007f]/.test(value);
  } catch { return false; }
}
export function validX402Payment(payment, now = Date.now()) {
  if (!keys(payment, ['paymentHash', 'resourceUrl', 'resourceHash', 'payer', 'network', 'asset', 'amount', 'payTo', 'nonceHash', 'validBefore'])
    || !HASH.test(payment.paymentHash || '') || !HASH.test(payment.resourceHash || '')
    || !HASH.test(payment.nonceHash || '') || !ADDRESS.test(payment.payer || '')
    || !ADDRESS.test(payment.asset || '') || !ADDRESS.test(payment.payTo || '')
    || !NETWORKS.has(payment.network) || ASSETS[payment.network] !== payment.asset || payment.amount !== X402_LIMITS.amount
    || !validX402Resource(payment.resourceUrl) || !/^[1-9]\d{0,10}$/.test(payment.validBefore || '')) return false;
  const expiry = Number(payment.validBefore);
  return Number.isSafeInteger(expiry) && expiry > Math.floor(now / 1000)
    && expiry <= Math.floor(now / 1000) + X402_LIMITS.maxAuthorizationSeconds;
}
export function validX402Rpc(name, params, now = Date.now()) {
  if (!Object.hasOwn(X402_RPC_PARAMETERS, name)
    || !keys(params, ['p_namespace', ...X402_RPC_PARAMETERS[name]])
    || params.p_namespace !== undefined && params.p_namespace !== 'production') return false;
  if (name === 'edgar_x402_claim') return UUID.test(params.p_owner || '') && validX402Payment(params.p_payment, now);
  const claim = params.p_claim, receipt = params.p_receipt;
  if (!keys(claim, ['paymentHash', 'owner']) || !HASH.test(claim.paymentHash || '') || !UUID.test(claim.owner || '')
    || !keys(receipt, ['status', 'transaction', 'payer', 'network', 'errorCode'])
    || !['settled', 'failed', 'pending', 'handler_failed'].includes(receipt.status)
    || receipt.errorCode !== undefined && (typeof receipt.errorCode !== 'string' || !/^[a-z0-9_]{1,80}$/.test(receipt.errorCode))) return false;
  if (receipt.status === 'settled' || receipt.status === 'pending' && receipt.transaction !== undefined)
    return TRANSACTION.test(receipt.transaction || '') && ADDRESS.test(receipt.payer || '') && NETWORKS.has(receipt.network);
  return receipt.transaction === undefined && receipt.payer === undefined && receipt.network === undefined;
}
