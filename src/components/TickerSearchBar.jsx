import React, { useContext, useEffect, useState } from 'react';
import { Search, Loader2, AlertCircle, Building2 } from 'lucide-react';
import { TickerContext } from '../App.jsx';
import { secFilesUrl } from '../utils/secApi.js';

export default function TickerSearchBar({ onFetch, loading, error, setError }) {
  const { ticker, setTicker, tickerMap, setTickerMap, company, setCompany } = useContext(TickerContext);
  const [input, setInput] = useState(ticker);
  const [mapLoading, setMapLoading] = useState(false);

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

  const handleSubmit = () => {
    if (!input.trim()) return;
    if (!tickerMap) {
      setError('Ticker database still loading. Please wait a moment.');
      return;
    }
    const symbol = input.trim().toUpperCase();

    let entry = tickerMap[symbol];
    if (!entry && /^\d{1,10}$/.test(symbol)) {
      const padded = symbol.padStart(10, '0');
      const match = Object.values(tickerMap).find((e) => e.cik === padded);
      if (match) entry = match;
    }

    if (!entry) {
      setError(`No SEC registrant found for "${symbol}". Try a valid ticker or CIK.`);
      setCompany(null);
      return;
    }

    setTicker(symbol);
    setError(null);
    onFetch(entry);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSubmit();
  };

  return (
    <>
      <div className="mb-8">
        <label className="block text-[10px] uppercase tracking-[0.25em] text-stone-400 mb-2">
          Enter ticker symbol or CIK
        </label>
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-stone-500" />
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value.toUpperCase())}
              onKeyDown={handleKeyDown}
              placeholder="AAPL, TSLA, MSFT, 0000320193..."
              className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-12 pr-4 py-4 text-xl font-bold tracking-wider placeholder-stone-600 transition-colors"
              autoFocus
            />
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

      {company && (
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
            {company.extra && <InfoField label={company.extra.label} value={company.extra.value} highlight />}
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
