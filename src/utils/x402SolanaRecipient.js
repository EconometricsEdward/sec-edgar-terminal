const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

async function associatedAccount(owner, mint) {
  const { address, getAddressEncoder, getProgramDerivedAddress } = await import('@solana/kit');
  const encode = getAddressEncoder();
  const [account] = await getProgramDerivedAddress({ programAddress: address(ASSOCIATED_TOKEN_PROGRAM),
    seeds: [encode.encode(address(owner)), encode.encode(address(TOKEN_PROGRAM)), encode.encode(address(mint))] });
  return account;
}

/** Read-only account preflight. It never creates accounts, signs, or moves funds. */
export function createX402RecipientCheck({ fetchImpl = (...args) => fetch(...args), now = Date.now,
  deriveAccount = associatedAccount, timeoutMs = 4000,
  rpcUrl = process.env.X402_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com' } = {}) {
  const cache = new Map();
  return async function checkRecipient({ network, payTo, asset = USDC }) {
    if (network !== MAINNET || asset !== USDC || !payTo) return { ready: false, status: 'recipient-check-unavailable' };
    const key = `${network}:${asset}:${payTo}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.promise;
    const record = { expires: now() + 15000 };
    record.promise = (async () => {
      try {
        const url = new URL(rpcUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid RPC endpoint');
        const account = await deriveAccount(payTo, asset);
        const response = await fetchImpl(url.href, { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
            params: [account, { encoding: 'jsonParsed', commitment: 'confirmed' }] }),
          signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
        if (!response.ok) throw new Error('RPC unavailable');
        if (Number(response.headers.get('content-length')) > 32768) throw new Error('RPC response too large');
        const reader = response.body?.getReader();
        const chunks = []; let total = 0;
        if (reader) try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            total += value.byteLength;
            if (total > 32768) throw new Error('RPC response too large');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        const body = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
        if (body.error || !body.result || !Object.hasOwn(body.result, 'value')) throw new Error('Invalid RPC response');
        const value = body.result.value;
        const info = value?.data?.parsed?.info;
        const ready = value?.owner === TOKEN_PROGRAM && value?.executable === false
          && value.data.parsed.type === 'account' && info?.mint === USDC && info?.owner === payTo && info?.state === 'initialized';
        const result = { ready, status: ready ? 'ready' : 'recipient-setup-required', account };
        record.expires = now() + (ready ? 60000 : 15000);
        return result;
      } catch {
        record.expires = now() + 15000;
        return { ready: false, status: 'recipient-check-unavailable' };
      }
    })();
    cache.set(key, record);
    if (cache.size > 16) cache.delete(cache.keys().next().value);
    return record.promise;
  };
}

export const checkX402Recipient = createX402RecipientCheck();

/** Keep public configuration honest about both payout setup and RPC outages. */
export async function getX402LivePublicConfiguration(configuration, { check = checkX402Recipient,
  required = process.env.VERCEL_ENV === 'production' } = {}) {
  if (!required || configuration.status !== 'active') return configuration;
  const recipient = await check(configuration);
  return { ...configuration, status: recipient.ready ? 'active' : recipient.status };
}
