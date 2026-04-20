import React, { useState, useEffect, useCallback } from 'react';
import {
  Bitcoin, TrendingUp, TrendingDown, Building2, Wallet as WalletIcon,
  ExternalLink, Info, AlertTriangle, Loader2, FileSearch,
} from 'lucide-react';
import SEO from '../components/SEO.jsx';
import CryptoScanner from '../components/CryptoScanner.jsx';
import ScanResults from '../components/ScanResults.jsx';

// ============================================================================
// Main CryptoPage
// ============================================================================

export default function CryptoPage() {
  const [scanData, setScanData] = useState(null);

  // Coin prices state
  const [coins, setCoins] = useState([]);
  const [coinsLoading, setCoinsLoading] = useState(true);
  const [coinsError, setCoinsError] = useState(null);
  const [coinsUpdatedAt, setCoinsUpdatedAt] = useState(null);

  // Load coin prices on mount
  useEffect(() => {
    let cancelled = false;
    let intervalId = null;

    async function loadCoins() {
      try {
        const res = await fetch('/api/crypto-prices');
        if (!res.ok) throw new Error(`API ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setCoins(data.coins || []);
        setCoinsUpdatedAt(new Date());
        setCoinsError(null);
      } catch (err) {
        if (!cancelled) setCoinsError(err.message);
      } finally {
        if (!cancelled) setCoinsLoading(false);
      }
    }

    loadCoins();
    intervalId = setInterval(loadCoins, 60000);  // Refresh every 60s

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  const handleScanComplete = useCallback((data) => {
    setScanData(data);
    // Scroll to results
    setTimeout(() => {
      document.getElementById('scan-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }, []);

  const handleRescan = useCallback(async (ticker, options = {}) => {
    try {
      const params = new URLSearchParams({
        tickers: ticker,
        depth: '50',
      });
      if (options.fresh) params.set('fresh', 'true');
      const res = await fetch(`/api/crypto-scan?${params}`);
      if (!res.ok) return;
      const newData = await res.json();
      // Merge: replace the specific ticker's result in existing scanData
      setScanData((prev) => {
        if (!prev) return newData;
        const updatedResults = prev.results.map((r) =>
          r.ticker === ticker && newData.results[0] ? newData.results[0] : r
        );
        return { ...prev, results: updatedResults, scannedAt: newData.scannedAt };
      });
    } catch (err) {
      console.error('Rescan failed', err);
    }
  }, []);

  return (
    <>
      <SEO
        title="Crypto Filings Scanner & SEC Crypto Disclosures"
        description="Scan any public company's SEC filings (10-K, 10-Q, 8-K) for mentions of bitcoin, cryptocurrency, and digital assets. Every match links to the source filing. Compare multiple companies side-by-side. Plus live coin prices."
        path="/crypto"
      />

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Bitcoin className="w-5 h-5 text-amber-500" />
          <h1 className="text-xl font-black uppercase tracking-tight">
            Crypto <span className="text-stone-500">/</span> SEC Disclosure Scanner
          </h1>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed max-w-3xl">
          Scan any public company's SEC filings for mentions of bitcoin, cryptocurrency, digital
          assets, and related terms. Results cached for 24 hours. Every match links to the
          original filing on SEC.gov. Plus live coin prices from Kraken.
        </p>
      </div>

      {/* Scanner — the main feature */}
      <CryptoScanner onScanComplete={handleScanComplete} />

      {/* Scan results */}
      <div id="scan-results">
        {scanData && <ScanResults data={scanData} onRescan={handleRescan} />}
      </div>

      {/* Top Coins reference section */}
      <CoinsSection
        coins={coins}
        loading={coinsLoading}
        error={coinsError}
        updatedAt={coinsUpdatedAt}
      />

      {/* Coming soon sections — ETFs + Companies curated lists */}
      <ComingSoonSection
        icon={WalletIcon}
        title="Spot Crypto ETFs"
        subtitle="ETFs section coming online"
        body="Spot BTC and ETH ETF holdings from SEC N-PORT filings. Launching in the next update."
      />

      <ComingSoonSection
        icon={Building2}
        title="Public Crypto Companies"
        subtitle="Curated list coming online"
        body="Curated list of treasury holders, miners, and exchanges with live Bitcoin holdings. Launching in the next update."
      />

      {/* About footer */}
      <div className="border-2 border-stone-800 bg-stone-900/30 p-4 flex items-start gap-3">
        <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
        <div className="text-[11px] text-stone-400 leading-relaxed">
          <span className="font-bold text-stone-200">About this page:</span>{' '}
          The scanner fetches up to 50 recent SEC filings per ticker (10-K, 10-Q, 8-K, S-1, proxy,
          N-CSR) and scans them for crypto-related keywords. Results cache for 24 hours. Coin
          prices come from Kraken (primary) and Coinbase (fallback), both regulated US exchanges
          with transparent price feeds. All data is traceable to a primary source.
        </div>
      </div>
    </>
  );
}

// ============================================================================
// CoinsSection — reference table of top coin prices
// ============================================================================

function CoinsSection({ coins, loading, error, updatedAt }) {
  const secondsAgo = updatedAt ? Math.floor((Date.now() - updatedAt.getTime()) / 1000) : null;

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b-2 border-stone-800">
        <TrendingUp className="w-5 h-5 text-amber-400" />
        <h2 className="text-sm uppercase tracking-[0.25em] font-black text-stone-200">
          Top Coins
        </h2>
        {updatedAt && !loading && (
          <span className="text-[10px] text-stone-500 lowercase tracking-widest ml-2">
            updated {secondsAgo < 5 ? 'just now' : secondsAgo < 60 ? `${secondsAgo}s ago` : `${Math.floor(secondsAgo / 60)}m ago`}
          </span>
        )}
      </div>

      {loading && coins.length === 0 && (
        <div className="flex items-center justify-center py-12 border-2 border-stone-800 bg-stone-900/30">
          <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />
          <span className="ml-3 text-xs text-stone-400 uppercase tracking-widest">Loading coin prices...</span>
        </div>
      )}

      {error && !loading && (
        <div className="border-2 border-rose-800/60 bg-rose-950/30 p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          <span className="text-xs text-rose-200">Could not load coin prices: {error}</span>
        </div>
      )}

      {!error && coins.length > 0 && (
        <>
          <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-stone-900 border-b-2 border-stone-800">
                <tr>
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400 w-8">#</th>
                  <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Coin</th>
                  <th className="text-right px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Price</th>
                  <th className="text-right px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">24h Change</th>
                  <th className="text-right px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">24h High</th>
                  <th className="text-right px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">24h Low</th>
                  <th className="text-center px-4 py-3 text-[10px] uppercase tracking-widest text-stone-400">Source</th>
                </tr>
              </thead>
              <tbody>
                {coins.map((c, i) => (
                  <CoinRow key={c.ticker} coin={c} idx={i + 1} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[10px] text-stone-500 leading-relaxed">
            Prices refresh every 60 seconds. Primary source: Kraken public API. Fallback: Coinbase public API.
            Both are regulated US crypto exchanges with transparent price feeds. Unlike aggregated feeds,
            prices shown here come from a single named exchange.
          </p>
        </>
      )}
    </section>
  );
}

function CoinRow({ coin, idx }) {
  const isUp = coin.change24h >= 0;
  const colorClass = isUp ? 'text-emerald-400' : 'text-rose-400';
  const Arrow = isUp ? TrendingUp : TrendingDown;

  return (
    <tr className="border-b border-stone-800/60 hover:bg-amber-500/5">
      <td className="px-4 py-2.5 text-stone-500 tabular-nums text-xs">{idx}</td>
      <td className="px-4 py-2.5">
        <span className="text-sm font-black tracking-wider text-stone-100 mr-2">{coin.ticker}</span>
        <span className="text-xs text-stone-400">{coin.name}</span>
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums font-bold text-stone-100">
        {formatPrice(coin.price)}
      </td>
      <td className={`px-4 py-2.5 text-right tabular-nums ${colorClass}`}>
        <span className="inline-flex items-center gap-1">
          <Arrow className="w-3 h-3" />
          {isUp ? '+' : ''}{coin.change24h?.toFixed(2)}%
        </span>
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-stone-300 text-xs">
        {formatPrice(coin.high24h)}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-stone-300 text-xs">
        {formatPrice(coin.low24h)}
      </td>
      <td className="px-4 py-2.5 text-center">
        {coin.source && coin.sourceUrl ? (
          <a
            href={coin.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-amber-400 hover:text-amber-300 font-bold"
          >
            {coin.source}
            <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <span className="text-[10px] uppercase tracking-widest text-stone-500">{coin.source || '—'}</span>
        )}
      </td>
    </tr>
  );
}

function formatPrice(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(6)}`;
}

// ============================================================================
// ComingSoonSection — placeholder for ETFs + Companies
// ============================================================================

function ComingSoonSection({ icon: Icon, title, subtitle, body }) {
  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b-2 border-stone-800">
        <Icon className="w-5 h-5 text-amber-400" />
        <h2 className="text-sm uppercase tracking-[0.25em] font-black text-stone-200">{title}</h2>
      </div>
      <div className="border-2 border-dashed border-stone-800 p-10 text-center">
        <Icon className="w-10 h-10 text-stone-700 mx-auto mb-3" />
        <p className="text-stone-500 text-sm uppercase tracking-widest mb-1">{subtitle}</p>
        <p className="text-stone-600 text-xs max-w-md mx-auto">{body}</p>
      </div>
    </section>
  );
}
