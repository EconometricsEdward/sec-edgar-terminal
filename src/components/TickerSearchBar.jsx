import React, { useContext, useEffect, useState, useRef, useMemo } from 'react';
import { Search, Loader2, AlertCircle, Building2, X } from 'lucide-react';
import { TickerContext } from '../App.jsx';
import { secFilesUrl } from '../utils/secApi.js';

export default function TickerSearchBar({ onFetch, loading, error, setError, initialTicker, showProfile = true }) {
  const { ticker, setTicker, tickerMap, setTickerMap, company, setCompany } = useContext(TickerContext);
  const [input, setInput] = useState(initialTicker || ticker || '');
  const [mapLoading, setMapLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const containerRef = useRef(null);

  useEffect(() => {
    if (tickerMap) return;
    const loadTickers = async () => {
      setMapLoading(true);
      try {
        const res = await fetch(secFilesUrl('company_tickers.json'));
        if (!res.ok) throw new Error('Failed to load ticker database');
        const data = await res.json();
        const map = {};
        Object.values(data).forEach((entry) => {
          map[entry.ticker.toUpperCase()] = {
            cik: String(entry.cik_str).padStart(10, '0'),
            name: entry.title,
            ticker: entry.ticker.toUpperCase(),
          };
        });
        setTickerMap(map);
      } catch (err) {
        setError('Could not initialize ticker database. Check your connection and try again.');
      } finally {
        setMapLoading(false);
      }
    };
    loadTickers();
  }, [tickerMap, setTickerMap, setError]);

  const suggestions = useMemo(() => {
    if (!tickerMap || !input.trim() || input.length < 1) return [];
    const query = input.trim().toUpperCase();
    const entries = Object.values(tickerMap);

    const scored = [];
    for (const e of entries) {
      const t = e.ticker;
      const n = e.name.toUpperCase();
      let score = 0;
      if (t === query) score = 1000;
      else if (t.startsWith(query)) score = 500 - (t.length - query.length);
      else if (n.startsWith(query)) score = 300 - (n.length - query.length) / 10;
      else if (t.includes(query)) score = 150;
      else if (n.includes(` ${query}`) || n.includes(query)) score = 100;
      if (score > 0) scored.push({ ...e, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8);
  }, [input, tickerMap]);

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const resolveSymbol = (symbol) => {
    if (!tickerMap) return null;
    const s = symbol.trim().toUpperCase();
    let entry = tickerMap[s];
    if (!entry && /^\d{1,10}$/.test(s)) {
      const padded = s.padStart(10, '0');
      const match = Object.values(tickerMap).find((e) => e.cik === padded);
      if (match) entry = match;
    }
    return entry;
  };

  const submitEntry = (entry) => {
    setTicker(entry.ticker);
    setInput(entry.ticker);
    setError(null);
    setShowSuggestions(false);
    onFetch(entry);
  };

  const handleSubmit = () => {
    if (!input.trim()) return;
    if (!tickerMap) {
      setError('Ticker database still loading. Please wait a moment.');
      return;
    }
    if (suggestions.length > 0) {
      submitEntry(suggestions[0]);
      return;
    }
    const entry = resolveSymbol(input);
    if (!entry) {
      setError(`No SEC registrant found for "${input.toUpperCase()}". Try a valid ticker, CIK, or company name.`);
      return;
    }
    submitEntry(entry);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIdx((i) => Math.min(i + 1, suggestions.length - 1));
      setShowSuggestions(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (showSuggestions && suggestions[highlightedIdx]) {
        submitEntry(suggestions[highlightedIdx]);
      } else {
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  useEffect(() => {
    if (initialTicker && tickerMap && !company) {
      const entry = resolveSymbol(initialTicker);
      if (entry) {
        setTicker(entry.ticker);
        onFetch(entry);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTicker, tickerMap]);

  return (
    <>
      <div className="mb-8" ref={containerRef}>
        <label className="block text-[10px] uppercase tracking-[0.25em] text-stone-400 mb-2">
          Enter ticker symbol, CIK, or company name
        </label>
        <div className="flex gap-2 relative">
          <div className="flex-1 relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-stone-500" />
            <input
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value.toUpperCase());
                setShowSuggestions(true);
                setHighlightedIdx(0);
              }}
              onFocus={() => setShowSuggestions(true)}
              onKeyDown={handleKeyDown}
              placeholder="AAPL, Tesla, Microsoft, 0000320193..."
              className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-12 pr-10 py-4 text-xl font-bold tracking-wider placeholder-stone-600 transition-colors"
              autoFocus
              autoComplete="off"
              spellCheck="false"
            />
            {input && (
              <button
                onClick={() => {
                  setInput('');
                  setShowSuggestions(false);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
                title="Clear"
              >
                <X className="w-4 h-4" />
              </button>
            )}

            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-stone-700 z-50 max-h-96 overflow-y-auto shadow-2xl">
                {suggestions.map((s, i) => (
                  <button
                    key={s.cik}
                    onMouseEnter={() => setHighlightedIdx(i)}
                    onClick={() => submitEntry(s)}
                    className={`w-full flex items-center justify-between px-4 py-3 text-left border-b border-stone-800 last:border-b-0 transition-colors ${
                      i === highlightedIdx ? 'bg-amber-500/10 border-l-2 border-l-amber-500' : 'hover:bg-stone-800/50'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-stone-100 truncate">{s.name}</div>
                      <div className="text-[10px] uppercase tracking-widest text-stone-500">CIK {s.cik}</div>
                    </div>
                    <div className="shrink-0 text-sm font-black text-amber-400 tracking-wider">{s.ticker}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            className="px-8 py-4 bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 font-black uppercase tracking-widest transition-colors flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Fetch'}
          </button>
        </div>
        {mapLoading && (
          <div className="mt-2 text-xs text-stone-500 flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading ticker database...
          </div>
        )}
      </div>

      {error && (
        <div className="mb-8 border-2 border-rose-800/60 bg-rose-950/30 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="text-sm text-rose-200">{error}</div>
        </div>
      )}

      {showProfile && company && (
        <div className="mb-8 border-2 border-stone-800 bg-stone-900/50">
          <div className="border-b border-stone-800 px-5 py-3 flex items-center gap-2 bg-stone-900">
            <Building2 className="w-4 h-4 text-amber-500" />
            <h2 className="text-xs uppercase tracking-[0.25em] font-bold">Registrant Profile</h2>
          </div>
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <InfoField label="Company" value={company.name} highlight />
            <InfoField label="CIK" value={company.cik} />
            <InfoField label="Tickers" value={company.tickers} />
            <InfoField label="Exchange" value={company.exchanges} />
            <InfoField label="SIC Industry" value={company.sic} />
            <InfoField label="Fiscal Year End" value={company.fiscalYearEnd} />
            <InfoField label="State of Inc." value={company.stateOfIncorporation || 'N/A'} />
            <InfoField label="EIN" value={company.ein || 'N/A'} />
          </div>
        </div>
      )}
    </>
  );
}

function InfoField({ label, value, highlight }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.25em] text-stone-500 mb-1">{label}</div>
      <div className={`text-sm font-bold break-words ${highlight ? 'text-amber-400' : 'text-stone-100'}`}>
        {value}
      </div>
    </div>
  );
}
