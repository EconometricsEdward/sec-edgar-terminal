// ============================================================================
// api/crypto-prices — Top coin prices from Kraken (primary) + Coinbase (fallback)
//
// Both APIs are free, public, no auth required. This endpoint hides them
// behind a consistent shape so the frontend doesn't care which source worked.
//
// Strategy:
//   1. Try Kraken with a single batched call for all coins
//   2. For any coin Kraken didn't return, try Coinbase individually
//   3. Cache the whole response at Vercel's edge for 60 seconds
//
// Kraken uses "XBT" for Bitcoin (ISO-4217 style), so we normalize on the
// output side — users see "BTC" everywhere.
// ============================================================================

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The coins we show on the crypto tab. Each entry maps our canonical ticker
// to the symbols each API uses. Add more here to expand coverage.
const COIN_LIST = [
  { ticker: 'BTC', name: 'Bitcoin',     krakenPair: 'XBTUSD', coinbaseId: 'BTC-USD' },
  { ticker: 'ETH', name: 'Ethereum',    krakenPair: 'ETHUSD', coinbaseId: 'ETH-USD' },
  { ticker: 'SOL', name: 'Solana',      krakenPair: 'SOLUSD', coinbaseId: 'SOL-USD' },
  { ticker: 'XRP', name: 'XRP',         krakenPair: 'XRPUSD', coinbaseId: 'XRP-USD' },
  { ticker: 'ADA', name: 'Cardano',     krakenPair: 'ADAUSD', coinbaseId: 'ADA-USD' },
  { ticker: 'AVAX', name: 'Avalanche',  krakenPair: 'AVAXUSD', coinbaseId: 'AVAX-USD' },
  { ticker: 'LINK', name: 'Chainlink',  krakenPair: 'LINKUSD', coinbaseId: 'LINK-USD' },
  { ticker: 'DOT', name: 'Polkadot',    krakenPair: 'DOTUSD', coinbaseId: 'DOT-USD' },
  { ticker: 'LTC', name: 'Litecoin',    krakenPair: 'LTCUSD', coinbaseId: 'LTC-USD' },
  { ticker: 'BCH', name: 'Bitcoin Cash', krakenPair: 'BCHUSD', coinbaseId: 'BCH-USD' },
];

// Kraken normalizes some symbols in its response. XBTUSD returns as XXBTZUSD,
// ETHUSD as XETHZUSD, etc. This maps what we send to what Kraken returns.
// We need this because Kraken's response uses its own canonical naming.
const KRAKEN_RESPONSE_KEY_MAP = {
  'XBTUSD': 'XXBTZUSD',
  'ETHUSD': 'XETHZUSD',
  'LTCUSD': 'XLTCZUSD',
  // Newer coins use the sent pair as-is
  'SOLUSD': 'SOLUSD',
  'XRPUSD': 'XXRPZUSD',
  'ADAUSD': 'ADAUSD',
  'AVAXUSD': 'AVAXUSD',
  'LINKUSD': 'LINKUSD',
  'DOTUSD': 'DOTUSD',
  'BCHUSD': 'BCHUSD',
};

async function fetchKraken() {
  const pairs = COIN_LIST.map(c => c.krakenPair).join(',');
  const url = `https://api.kraken.com/0/public/Ticker?pair=${pairs}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EDGAR-Terminal/1.0' },
      // Kraken is usually quick but give it a 5s timeout
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Kraken returned ${res.status}`);
    }

    const data = await res.json();
    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken error: ${data.error.join(', ')}`);
    }

    // Transform to our shape
    const results = {};
    for (const coin of COIN_LIST) {
      const krakenKey = KRAKEN_RESPONSE_KEY_MAP[coin.krakenPair] || coin.krakenPair;
      const ticker = data.result?.[krakenKey];
      if (!ticker) continue;

      // Kraken's ticker format:
      //   c[0] = last trade closed price (this is "the price")
      //   v[1] = volume last 24h
      //   h[1] = high last 24h
      //   l[1] = low last 24h
      //   o = opening price today
      const price = parseFloat(ticker.c?.[0]);
      const volume24h = parseFloat(ticker.v?.[1]);
      const high24h = parseFloat(ticker.h?.[1]);
      const low24h = parseFloat(ticker.l?.[1]);
      const open24h = parseFloat(ticker.o);

      if (!Number.isFinite(price)) continue;

      const change24hUsd = Number.isFinite(open24h) ? price - open24h : null;
      const change24hPct = Number.isFinite(open24h) && open24h !== 0
        ? ((price - open24h) / open24h) * 100
        : null;

      results[coin.ticker] = {
        ticker: coin.ticker,
        name: coin.name,
        price,
        change24hUsd,
        change24hPct,
        high24h: Number.isFinite(high24h) ? high24h : null,
        low24h: Number.isFinite(low24h) ? low24h : null,
        volume24h: Number.isFinite(volume24h) ? volume24h : null,
        source: 'Kraken',
        sourceUrl: `https://www.kraken.com/prices/${coin.name.toLowerCase().replace(/\s+/g, '-')}`,
      };
    }
    return results;
  } catch (err) {
    console.warn('Kraken fetch failed:', err.message);
    return {};
  }
}

async function fetchCoinbase(ticker, name, coinbaseId) {
  try {
    // Coinbase's public "spot price" endpoint — no auth needed
    const res = await fetch(`https://api.coinbase.com/v2/prices/${coinbaseId}/spot`, {
      headers: { 'User-Agent': 'EDGAR-Terminal/1.0' },
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const price = parseFloat(data?.data?.amount);
    if (!Number.isFinite(price)) return null;

    return {
      ticker,
      name,
      price,
      change24hUsd: null,  // Coinbase spot endpoint doesn't give 24h change
      change24hPct: null,
      high24h: null,
      low24h: null,
      volume24h: null,
      source: 'Coinbase',
      sourceUrl: `https://www.coinbase.com/price/${name.toLowerCase().replace(/\s+/g, '-')}`,
    };
  } catch (err) {
    console.warn(`Coinbase fetch failed for ${ticker}:`, err.message);
    return null;
  }
}

export async function GET(request) {
  try {
    // Step 1: batch call to Kraken
    const krakenResults = await fetchKraken();

    // Step 2: for any coins Kraken didn't return, try Coinbase
    const missing = COIN_LIST.filter(c => !krakenResults[c.ticker]);
    const coinbaseResults = {};
    if (missing.length > 0) {
      await Promise.all(
        missing.map(async (coin) => {
          const result = await fetchCoinbase(coin.ticker, coin.name, coin.coinbaseId);
          if (result) coinbaseResults[coin.ticker] = result;
        })
      );
    }

    // Merge with Kraken taking priority
    const combined = { ...coinbaseResults, ...krakenResults };

    // Return as array in the same order as COIN_LIST (stable ordering)
    const coins = COIN_LIST
      .map(c => combined[c.ticker])
      .filter(Boolean);

    return Response.json(
      {
        coins,
        updatedAt: new Date().toISOString(),
        sources: {
          kraken: Object.keys(krakenResults).length,
          coinbase: Object.keys(coinbaseResults).length,
        },
      },
      {
        headers: {
          // Edge cache for 60 seconds, serve stale for 5 min while revalidating
          'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
        },
      }
    );
  } catch (err) {
    return Response.json(
      { error: err.message, coins: [] },
      { status: 500 }
    );
  }
}
