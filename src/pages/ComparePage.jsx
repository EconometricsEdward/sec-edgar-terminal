import React, { useState, useEffect, useContext, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GitCompare, X, Plus, Loader2, AlertCircle, Search, Link as LinkIcon, AlertTriangle } from 'lucide-react';
import { TickerContext } from '../App.jsx';
import { ComparisonChart } from '../components/MetricChart.jsx';
import { secDataUrl, secFilesUrl } from '../utils/secApi.js';
import {
  extractAnnualPeriods,
  buildMetricRow,
} from '../utils/xbrlParser.js';

const COMPARE_METRICS = [
  { key: 'revenue', label: 'Revenue', format: 'currency' },
  { key: 'netIncome', label: 'Net Income', format: 'currency' },
  { key: 'operatingIncome', label: 'Operating Income', format: 'currency' },
  { key: 'totalAssets', label: 'Total Assets', format: 'currency' },
  { key: 'stockholdersEquity', label: "Stockholders' Equity", format: 'currency' },
  { key: 'operatingCashFlow', label: 'Operating Cash Flow', format: 'currency' },
];

const MAX_COMPANIES = 5;

export default function ComparePage() {
  const { tickers: urlTickers } = useParams();
  const navigate = useNavigate();
  const { tickerMap, setTickerMap } = useContext(TickerContext);

  const [companies, setCompanies] = useState([]);
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [globalError, setGlobalError] = useState(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (tickerMap) return;
    (async () => {
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
        setGlobalError('Could not load ticker database.');
      }
    })();
  }, [tickerMap, setTickerMap]);

  useEffect(() => {
    if (initialized || !tickerMap) return;
    setInitialized(true);
    if (urlTickers) {
      const list = urlTickers.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      list.slice(0, MAX_COMPANIES).forEach((t) => {
        const entry = tickerMap[t];
        if (entry) addCompany(entry, false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickerMap, initialized]);

  const updateUrl = (cmps) => {
    const tickers = cmps.map((c) => c.ticker).join(',');
    if (tickers) navigate(`/compare/${tickers}`, { replace: true });
    else navigate('/compare', { replace: true });
  };

  const addCompany = async (entry, updateUrlAfter = true) => {
    if (companies.find((c) => c.ticker === entry.ticker)) return;
    if (companies.length >= MAX_COMPANIES) {
      setGlobalError(`Maximum of ${MAX_COMPANIES} companies at once.`);
      return;
    }

    const newCompany = { ticker: entry.ticker, name: entry.name, cik: entry.cik, facts: null, sicCode: null, loading: true, error: null };
    setCompanies((prev) => {
      const next = [...prev, newCompany];
      if (updateUrlAfter) updateUrl(next);
      return next;
    });

    try {
      // Need both submissions (for SIC) and facts
      const [submissionsRes, factsRes] = await Promise.all([
        fetch(secDataUrl(`/submissions/CIK${entry.cik}.json`)),
        fetch(secDataUrl(`/api/xbrl/companyfacts/CIK${entry.cik}.json`)),
      ]);

      if (!factsRes.ok) {
        if (factsRes.status === 404) throw new Error('No XBRL financial data available');
        throw new Error(`SEC API ${factsRes.status}`);
      }
      const factsData = await factsRes.json();
      let sicCode = null;
      if (submissionsRes.ok) {
        const sub = await submissionsRes.json();
        sicCode = sub.sic;
      }
      setCompanies((prev) => prev.map((c) =>
        c.ticker === entry.ticker ? { ...c, facts: factsData.facts || {}, sicCode, loading: false } : c
      ));
    } catch (err) {
      setCompanies((prev) => prev.map((c) =>
        c.ticker === entry.ticker ? { ...c, loading: false, error: err.message } : c
      ));
    }
  };

  const removeCompany = (ticker) => {
    setCompanies((prev) => {
      const next = prev.filter((c) => c.ticker !== ticker);
      updateUrl(next);
      return next;
    });
  };

  const copyShareLink = () => {
    if (!companies.length) return;
    const url = `${window.location.origin}/#/compare/${companies.map((c) => c.ticker).join(',')}`;
    navigator.clipboard.writeText(url);
  };

  const suggestions = useMemo(() => {
    if (!tickerMap || !input.trim()) return [];
    const q = input.trim().toUpperCase();
    const scored = [];
    for (const e of Object.values(tickerMap)) {
      if (companies.find((c) => c.ticker === e.ticker)) continue;
      let score = 0;
      if (e.ticker === q) score = 1000;
      else if (e.ticker.startsWith(q)) score = 500 - (e.ticker.length - q.length);
      else if (e.name.toUpperCase().startsWith(q)) score = 300;
      else if (e.name.toUpperCase().includes(q)) score = 100;
      if (score > 0) scored.push({ ...e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8);
  }, [input, tickerMap, companies]);

  const handleSubmit = () => {
    if (!input.trim() || !suggestions.length) return;
    addCompany(suggestions[highlightedIdx] || suggestions[0]);
    setInput('');
    setShowSuggestions(false);
    setHighlightedIdx(0);
  };

  const annualPeriods = useMemo(() => {
    const allYears = new Map();
    companies.forEach((c) => {
      if (c.facts) {
        extractAnnualPeriods(c.facts).forEach((p) => {
          if (!allYears.has(p.fy)) allYears.set(p.fy, p);
        });
      }
    });
    return Array.from(allYears.values()).sort((a, b) => b.fy - a.fy).slice(0, 10);
  }, [companies]);

  const buildSeries = (metricKey) => {
    return companies
      .filter((c) => c.facts && !c.error)
      .map((c) => {
        // Build periods matched to each company's own data
        const companyPeriods = extractAnnualPeriods(c.facts).slice(0, 10);
        const data = buildMetricRow(c.facts, metricKey, '', companyPeriods, 'currency', c.sicCode).values;
        return { name: c.name, ticker: c.ticker, data };
      });
  };

  const allLoaded = companies.length > 0 && companies.every((c) => !c.loading);

  // Detect mixed industries — warn user
  const industryGroups = new Set(
    companies
      .filter((c) => c.sicCode)
      .map((c) => {
        const sic = parseInt(c.sicCode, 10) || 0;
        if (sic >= 6000 && sic <= 6299) return 'banking';
        if (sic >= 6300 && sic <= 6411) return 'insurance';
        return 'general';
      })
  );
  const mixedIndustries = industryGroups.size > 1;

  return (
    <>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-4">
          <GitCompare className="w-5 h-5 text-amber-500" />
          <h2 className="text-xl font-black uppercase tracking-tight">Peer Comparison</h2>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed">
          Add up to {MAX_COMPANIES} public companies to compare their annual financials side-by-side.
          Each chart overlays data from all selected companies across the last 10 fiscal years.
        </p>
      </div>

      {companies.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {companies.map((c) => (
            <div
              key={c.ticker}
              className={`flex items-center gap-2 px-3 py-2 border-2 ${
                c.error
                  ? 'border-rose-800/60 bg-rose-950/30 text-rose-300'
                  : c.loading
                  ? 'border-stone-700 bg-stone-900 text-stone-400'
                  : 'border-amber-500/50 bg-amber-500/10 text-amber-200'
              }`}
            >
              <span className="text-xs font-black tracking-wider">{c.ticker}</span>
              <span className="text-[11px] text-stone-400 truncate max-w-[180px]">{c.name}</span>
              {c.loading && <Loader2 className="w-3 h-3 animate-spin" />}
              {c.error && <AlertCircle className="w-3 h-3" title={c.error} />}
              <button
                onClick={() => removeCompany(c.ticker)}
                className="text-stone-500 hover:text-rose-400 ml-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {companies.length < MAX_COMPANIES && (
        <div className="mb-6 relative">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500" />
              <input
                type="text"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value.toUpperCase());
                  setShowSuggestions(true);
                  setHighlightedIdx(0);
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightedIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightedIdx((i) => Math.max(i - 1, 0)); }
                  else if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
                  else if (e.key === 'Escape') setShowSuggestions(false);
                }}
                placeholder={companies.length === 0 ? 'Add first company (AAPL, Tesla, etc.)' : 'Add another company...'}
                className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-10 pr-4 py-3 text-base font-bold tracking-wider placeholder-stone-600 transition-colors"
                autoComplete="off"
              />

              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-stone-700 z-50 max-h-80 overflow-y-auto shadow-2xl">
                  {suggestions.map((s, i) => (
                    <button
                      key={s.cik}
                      onMouseEnter={() => setHighlightedIdx(i)}
                      onClick={() => { addCompany(s); setInput(''); setShowSuggestions(false); }}
                      className={`w-full flex items-center justify-between px-3 py-2.5 text-left border-b border-stone-800 last:border-b-0 transition-colors ${
                        i === highlightedIdx ? 'bg-amber-500/10 border-l-2 border-l-amber-500' : 'hover:bg-stone-800/50'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-stone-100 truncate">{s.name}</div>
                      </div>
                      <div className="shrink-0 text-sm font-black text-amber-400 tracking-wider">{s.ticker}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={handleSubmit}
              disabled={!suggestions.length}
              className="px-5 py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
            {companies.length > 0 && (
              <button
                onClick={copyShareLink}
                className="px-3 py-3 border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors"
                title="Copy shareable link"
              >
                <LinkIcon className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {globalError && (
        <div className="mb-6 border-2 border-rose-800/60 bg-rose-950/30 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="text-sm text-rose-200">{globalError}</div>
        </div>
      )}

      {/* Mixed-industry warning */}
      {mixedIndustries && (
        <div className="mb-6 border-2 border-amber-700/40 bg-amber-950/20 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-100/90 leading-relaxed">
            <span className="font-bold text-amber-300">Comparing across industries.</span>{' '}
            You've added companies from different industry groups (e.g. banks, insurance, general corporations).
            "Revenue" means different things — bank revenue is interest + fee income, while a retailer's is net sales.
            Interpret comparisons accordingly.
          </div>
        </div>
      )}

      {allLoaded && companies.filter((c) => c.facts).length >= 1 && annualPeriods.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {COMPARE_METRICS.map((m) => (
            <ComparisonChart
              key={m.key}
              title={m.label}
              series={buildSeries(m.key)}
              format={m.format}
              height={280}
            />
          ))}
        </div>
      )}

      {companies.length === 0 && (
        <div className="border-2 border-dashed border-stone-800 p-12 text-center">
          <GitCompare className="w-12 h-12 text-stone-700 mx-auto mb-4" />
          <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">Add Companies To Compare</p>
          <p className="text-stone-600 text-xs max-w-md mx-auto">
            Type a ticker or company name above to start building a peer group.
            Common peer groups: AAPL, MSFT, GOOGL, META · TSLA, F, GM, RIVN · JPM, BAC, WFC, C
          </p>
        </div>
      )}

      {companies.length > 0 && (
        <p className="mt-6 text-[11px] text-stone-500 leading-relaxed">
          Source: SEC XBRL Company Facts. Values are as originally reported in 10-K filings.
          Gaps in lines indicate missing data for that company in that fiscal year.
          Share this comparison by copying the link above.
        </p>
      )}
    </>
  );
}
