import { BankDataError, isBankPreview } from './errors.js';
import { limitedText } from './client.js';
export function createBankStore({ env = process.env, fetchImpl = fetch, identity = async () => (await import('@vercel/oidc')).getVercelOidcToken() } = {}) {
  return async (operation, payload = {}) => {
    if (typeof window !== 'undefined' || !isBankPreview(env)) throw new BankDataError('preview_only', { status: 404 });
    try {
      const response = await fetchImpl('https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/bank-pilot-gateway', {
        method: 'POST', headers: { Authorization: `Bearer ${await identity()}`, 'Content-Type': 'application/json', 'x-region': 'us-east-1' },
        body: JSON.stringify({ operation, payload }), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw new BankDataError('database_failure');
      return JSON.parse(await limitedText(response));
    } catch (error) { if (error instanceof BankDataError) throw error; throw new BankDataError('database_failure'); }
  };
}
export const bankStore = createBankStore();
