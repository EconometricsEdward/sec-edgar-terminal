import React, { useMemo, useRef, useState } from 'react';
import {
  AlertCircle, ChevronRight, Clock, FileSearch, Loader2, Search, Sparkles, X,
} from 'lucide-react';

const QUICK_STARTS = [
  {
    label: 'AI exposure',
    tickers: 'NVDA,MSFT,GOOGL',
    query: 'artificial intelligence, AI, GPU',
    note: 'Find product, risk, and capex language',
  },
  {
    label: 'Tariffs',
    tickers: 'AAPL,NKE,WMT',
    query: 'tariff, tariffs, trade restrictions',
    note: 'Compare supply-chain sensitivity',
  },
  {
    label: 'Cybersecurity',
    tickers: 'MSFT,JPM,UNH',
    query: 'cybersecurity, data breach, ransomware',
    note: 'Surface risk-factor and incident language',
  },
  {
    label: 'Customer concentration',
    tickers: 'NVDA,PLTR,TSLA',
    query: 'customer concentration, major customer, significant customer',
    note: 'Look for dependency disclosures',
  },
  {
    label: 'Restructuring',
    tickers: 'INTC,DIS,NKE',
    query: 'restructuring, impairment, cost reduction',
    note: 'Track operational turnaround signals',
  },
  {
    label: 'Liquidity stress',
    tickers: 'PARA,WBA,CCL',
    query: 'going concern, substantial doubt, liquidity',
    note: 'Search risk language tied to cash runway',
  },
];

function parseTickers(input) {
  return input
    .split(',')
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean);
}

function parseTerms(input) {
  return input
    .split(',')
    .map((term) => term.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export default function DisclosureScanner({ initialQuery = '', onScanComplete }) {
  const [tickerInput, setTickerInput] = useState('');
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const tickerRef = useRef(null);

  const tickers = useMemo(() => parseTickers(tickerInput), [tickerInput]);
  const terms = useMemo(() => parseTerms(queryInput), [queryInput]);
  const isValid = tickers.length >= 1 && tickers.length <= 5 && terms.length >= 1;

  const runSearch = async (nextTickers, nextQuery, options = {}) => {
    if (scanning || !nextTickers.length || !nextQuery.trim()) return;

    setScanning(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        tickers: nextTickers.join(','),
        query: nextQuery,
        depth: String(options.depth || 35),
      });
      if (options.fresh) params.set('fresh', 'true');

      const response = await fetch(`/api/disclosure-search?${params}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Search failed: HTTP ${response.status}`);
      }

      const data = await response.json();
      onScanComplete?.(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  };

  const handleSubmit = (event) => {
    event?.preventDefault();
    if (!isValid) return;
    runSearch(tickers, queryInput);
  };

  const clearTickers = () => {
    setTickerInput('');
    setError(null);
    tickerRef.current?.focus();
  };

  const applyQuickStart = (item) => {
    if (scanning) return;
    setTickerInput(item.tickers);
    setQueryInput(item.query);
    runSearch(parseTickers(item.tickers), item.query);
  };

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-1">
        <FileSearch className="w-5 h-5 text-amber-500" />
        <h2 className="text-sm uppercase tracking-[0.2em] font-black text-stone-200">
          Disclosure Keyword Search
        </h2>
      </div>
      <p className="text-xs text-stone-400 mb-4 leading-relaxed max-w-3xl">
        Search recent SEC filings for any literal word or phrase. Enter up to 5 public-company
        tickers and one or more comma-separated terms; every match links back to the original
        filing on SEC.gov.
      </p>

      <form onSubmit={handleSubmit} className="mb-4 space-y-3">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] gap-2">
          <label className="block">
            <span className="block mb-1 text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
              Companies
            </span>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500 pointer-events-none" />
              <input
                ref={tickerRef}
                type="text"
                value={tickerInput}
                onChange={(event) => {
                  setTickerInput(event.target.value.toUpperCase());
                  setError(null);
                }}
                placeholder="AAPL,NVDA,JPM"
                className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-10 pr-10 py-3 text-sm font-bold tracking-wider placeholder-stone-600 transition-colors"
                autoComplete="off"
                spellCheck="false"
                disabled={scanning}
              />
              {tickerInput && !scanning && (
                <button
                  type="button"
                  onClick={clearTickers}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
                  aria-label="Clear tickers"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </label>

          <label className="block">
            <span className="block mb-1 text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
              Keywords or phrases
            </span>
            <input
              type="text"
              value={queryInput}
              onChange={(event) => {
                setQueryInput(event.target.value);
                setError(null);
              }}
              placeholder="tariffs, customer concentration, cyber attack"
              className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none px-3 py-3 text-sm font-bold placeholder-stone-600 transition-colors"
              autoComplete="off"
              spellCheck="false"
              disabled={scanning}
            />
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={!isValid || scanning}
              className="w-full lg:w-auto px-5 py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors flex items-center justify-center gap-2 border-2 border-amber-500 disabled:border-stone-800"
            >
              {scanning ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Searching
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  Search
                </>
              )}
            </button>
          </div>
        </div>

        {(tickers.length > 0 || terms.length > 0) && !scanning && (
          <div className="text-[10px] font-mono uppercase tracking-wider text-stone-500">
            {tickers.length > 5
              ? `Too many companies: ${tickers.length}. Max 5.`
              : tickers.length > 0
                ? `Companies: ${tickers.join(', ')}`
                : 'Add at least 1 company'}
            <span className="mx-2 text-stone-700">/</span>
            {terms.length > 0 ? `Terms: ${terms.slice(0, 4).join(', ')}${terms.length > 4 ? '...' : ''}` : 'Add at least 1 term'}
          </div>
        )}
      </form>

      {scanning && (
        <div className="mb-4 border-2 border-amber-700/40 bg-amber-950/20 p-4 flex items-start gap-3">
          <Loader2 className="w-5 h-5 text-amber-400 shrink-0 mt-0.5 animate-spin" />
          <div className="flex-1">
            <div className="text-sm text-amber-200 font-bold mb-1">
              Searching SEC filings for {tickers.length} {tickers.length === 1 ? 'company' : 'companies'}...
            </div>
            <div className="text-xs text-amber-100/80 leading-relaxed">
              The scanner fetches recent 10-K, 10-Q, 8-K, proxy, registration, foreign issuer, and
              fund filings, converts them to text, and returns paragraph-level excerpts with direct
              SEC source links.
            </div>
          </div>
        </div>
      )}

      {error && !scanning && (
        <div className="mb-4 border-2 border-rose-800/60 bg-rose-950/30 p-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-xs text-rose-200 font-bold">Search failed</div>
            <div className="text-xs text-rose-300 mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {!scanning && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-3 h-3 text-stone-500" />
            <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
              Research prompts
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {QUICK_STARTS.map((item) => (
              <button
                key={item.label}
                onClick={() => applyQuickStart(item)}
                className="group flex items-start gap-3 p-3 border-2 border-stone-800 bg-stone-900/30 hover:border-amber-500 hover:bg-amber-500/5 transition-colors text-left"
                type="button"
              >
                <FileSearch className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-black tracking-wider text-stone-100 group-hover:text-amber-300 transition-colors">
                      {item.label}
                    </span>
                    <ChevronRight className="w-3 h-3 text-stone-700 group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all" />
                  </div>
                  <div className="text-[10px] text-stone-400 font-bold truncate">{item.tickers}</div>
                  <div className="text-[9px] uppercase tracking-widest text-stone-600 mt-0.5">
                    {item.note}
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
