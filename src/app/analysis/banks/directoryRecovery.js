import { isBankDirectory } from '../../../utils/bank/directory.js';
export { isBankDirectory } from '../../../utils/bank/directory.js';

/** A single, bounded, read-only recovery request. Search has its own independent request. */
export async function loadBankDirectory({ signal, fetchImpl = fetch, timeoutMs = 35000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl('/api/banks?q=', {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Bank directory unavailable');
  const data = await response.json();
  if (!isBankDirectory(data)) throw new Error('Invalid bank directory response');
  return data;
}
