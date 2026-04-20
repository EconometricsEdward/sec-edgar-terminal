import React, { useState, useRef, useEffect } from 'react';
import {
  Search, X, Bitcoin, AlertCircle, Loader2, Zap, Clock, RefreshCw,
  FileSearch, ChevronRight,
} from 'lucide-react';

// Preset tickers to give users a one-click starting point
const PRESET_TICKERS = [
  { ticker: 'MSTR', name: 'Strategy (MicroStrategy)', note: 'Biggest public BTC holder' },
  { ticker: 'COIN', name: 'Coinbase', note: 'Largest US crypto exchange' },
  { ticker: 'MARA', name: 'Marathon Digital', note: 'Bitcoin miner' },
  { ticker: 'IBIT', name: 'iShares Bitcoin ETF', note: 'Spot Bitcoin ETF' },
  { ticker: 'TSLA', name: 'Tesla', note: 'Bought BTC in 2021' },
  { ticker: 'RIOT', name: 'Riot Platforms', note: 'Bitcoin miner' },
];

export default function CryptoScanner({ onScanComplete }) {
  const [input, setInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null); // { current, total, ticker } during scan
  const inputRef = useRef(null);

  const parsedTickers = input
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  const isValid = parsedTickers.length >= 1 && parsedTickers.length <= 5;

  const runScan = async (tickers, options = {}) => {
    if (scanning) return;
    if (!tickers.length) return;

    setScanning(true);
    setError(null);
    setProgress({ current: 0, total: tickers.length, ticker: tickers[0] });

    try {
      const params = new URLSearchParams({
        tickers: tickers.join(','),
        depth: String(options.depth || 50),
      });
      if (options.fresh) params.set('fresh', 'true');

      const res = await fetch(`/api/crypto-scan?${params}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Scan failed: HTTP ${res.status}`);
      }
      const data = await res.json();

      // Pass results up to parent
      if (onScanComplete) onScanComplete(data);
      setInput('');
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const handleSubmit = (e) => {
    e?.preventDefault();
    if (!isValid) return;
    runScan(parsedTickers);
  };

  const handlePresetClick = (ticker) => {
    if (scanning) return;
    runScan([ticker]);
  };

  const clearInput = () => {
    setInput('');
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <div className="mb-8">
      {/* Section header */}
      <div className="flex items-center gap-2 mb-1">
        <FileSearch className="w-5 h-5 text-amber-500" />
        <h2 className="text-sm uppercase tracking-[0.2em] font-black text-stone-200">
          Crypto Disclosure Scanner
        </h2>
      </div>
      <p className="text-xs text-stone-400 mb-4 leading-relaxed max-w-3xl">
        Scan any public company's recent SEC filings (10-K, 10-Q, 8-K, and more) for mentions
        of bitcoin, cryptocurrency, digital assets, and related terms. Every match links
        directly to the source filing on SEC.gov. Compare up to 5 tickers side-by-side.
      </p>

      {/* Scanner input */}
      <form onSubmit={handleSubmit} className="relative mb-4">
        <div className="flex gap-0">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value.toUpperCase());
                setError(null);
              }}
              placeholder="Enter a ticker or up to 5 comma-separated (MSTR,COIN,MARA)"
              className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-10 pr-10 py-3 text-base font-bold tracking-wider placeholder-stone-600 transition-colors"
              autoComplete="off"
              spellCheck="false"
              disabled={scanning}
            />
            {input && !scanning && (
              <button
                type="button"
                onClick={clearInput}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
                aria-label="Clear"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={!isValid || scanning}
            className="px-5 py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors flex items-center gap-2 border-2 border-amber-500 disabled:border-stone-800"
          >
            {scanning ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5" />
                Scan
              </>
            )}
          </button>
        </div>

        {/* Ticker count hint / validation */}
        {parsedTickers.length > 0 && !scanning && (
          <div className="mt-2 text-[10px] font-mono uppercase tracking-wider text-stone-500">
            {parsedTickers.length === 1
              ? `Will scan 1 ticker: ${parsedTickers[0]}`
              : parsedTickers.length <= 5
              ? `Will scan ${parsedTickers.length} tickers: ${parsedTickers.join(', ')}`
              : `Too many: ${parsedTickers.length} tickers. Max 5.`}
          </div>
        )}
      </form>

      {/* Scanning status */}
      {scanning && progress && (
        <div className="mb-4 border-2 border-amber-700/40 bg-amber-950/20 p-4 flex items-start gap-3">
          <Loader2 className="w-5 h-5 text-amber-400 shrink-0 mt-0.5 animate-spin" />
          <div className="flex-1">
            <div className="text-sm text-amber-200 font-bold mb-1">
              Scanning SEC filings{progress.total > 1 ? ` for ${progress.total} tickers` : ''}...
            </div>
            <div className="text-xs text-amber-100/80 leading-relaxed">
              This can take 30-90 seconds. We're fetching and parsing up to 50 recent filings per
              ticker (10-K, 10-Q, 8-K, S-1, and more). Results will cache for 24 hours so future
              scans of the same ticker are instant.
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && !scanning && (
        <div className="mb-4 border-2 border-rose-800/60 bg-rose-950/30 p-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs text-rose-200 font-bold">Scan failed</div>
            <div className="text-xs text-rose-300 mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {/* Preset buttons */}
      {!scanning && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-3 h-3 text-stone-500" />
            <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
              Quick Starts
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {PRESET_TICKERS.map((p) => (
              <button
                key={p.ticker}
                onClick={() => handlePresetClick(p.ticker)}
                className="group flex items-start gap-3 p-3 border-2 border-stone-800 bg-stone-900/30 hover:border-amber-500 hover:bg-amber-500/5 transition-colors text-left"
              >
                <Bitcoin className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-black tracking-wider text-stone-100 group-hover:text-amber-300 transition-colors">
                      {p.ticker}
                    </span>
                    <ChevronRight className="w-3 h-3 text-stone-700 group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all" />
                  </div>
                  <div className="text-[10px] text-stone-400 font-bold truncate">{p.name}</div>
                  <div className="text-[9px] uppercase tracking-widest text-stone-600 mt-0.5">
                    {p.note}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
