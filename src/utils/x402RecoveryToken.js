import { createHash } from 'node:crypto';

export const X402_RECOVERY_HEADER = 'X-X402-Recovery-Token';
export const X402_RECOVERY_HOURS = 24;

/** A client-created capability, never a wallet key or payment authorization. */
export function x402RecoveryToken(request, { required = false } = {}) {
  const token = request.headers.get(X402_RECOVERY_HEADER);
  if (token === null && !required) return null;
  // Headers combines duplicates with commas; this rejects duplicates as well.
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid_recovery_token');
  return createHash('sha256').update(token).digest('hex');
}
