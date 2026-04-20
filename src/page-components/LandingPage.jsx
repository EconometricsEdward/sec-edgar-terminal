import React, { useState, useEffect, useContext, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight, FileText, BarChart3, GitCompare, Users, LineChart, Percent,
  Search, Database, Shield, Zap, ExternalLink, Info,
  Bitcoin, Wallet, Building2, X, AlertCircle, GitCompare as GitCompareIcon,
  FileSearch, Cpu, Landmark, Plane,
} from 'lucide-react';
import SEO from '../components/SEO.jsx';
import { TickerContext } from '../App.jsx';
import { loadClassifiedTickerMap } from '../utils/tickerMapLoader.js';
import {
  routeSearch,
  getSuggestions,
  parseActiveSegment,
  pushRecentSearch,
} from '../utils/searchRouter.js';

const FEATURED_TICKERS = [
  { ticker: 'AAPL', name: 'Apple Inc.', industry: 'Tech', caption: 'Mega-cap tech', accent: 'amber' },
  { ticker: 'JPM', name: 'JPMorgan Chase', industry: 'Banking', caption: 'Big bank — NIM + efficiency ratios', accent: 'sky' },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', industry: 'Semiconductors', caption: 'Growth + insider activity', accent: 'emerald' },
  { ticker: 'XOM', name: 'Exxon Mobil', industry: 'Energy', caption: 'Oil & gas', accent: 'rose' },
];

const FEATURE_GRID = [
  { icon: FileText, title: 'Complete Filing History', description: 'Every 10-K, 10-Q, 8-K, Form 4, and proxy filed with the SEC. Grouped by year and quarter, filterable by form type, one click to the original document.', link: '/filings/AAPL', linkLabel: "See Apple's filings →" },
  { icon: BarChart3, title: 'Financial Analysis', description: 'Income statement, balance sheet, cash flow, and calculated ratios across 10 fiscal years. Every value links to its source XBRL tag on SEC.gov.', link: '/analysis/JPM', linkLabel: 'Analyze JPMorgan →' },
  { icon: Percent, title: 'Industry-Aware Ratios', description: "Banks get NIM, Efficiency Ratio, and NPL. Tech gets Rule of 40 and R&D intensity. Retail gets inventory turnover. Ratios automatically match each company's industry.", link: '/analysis/C', linkLabel: 'See banking ratios →' },
  { icon: LineChart, title: 'Stock Price with Filing Markers', description: '10 years of stock price history, with 10-K and 10-Q filing dates marked. Click any marker to open that filing. Insider buys and sells overlaid.', link: '/analysis/TSLA', linkLabel: "See Tesla's chart →" },
  { icon: Users, title: 'Insider Trading', description: 'Parsed from SEC Form 4 XML filings. See which executives are buying or selling, when, at what price, and how it relates to filing dates.', link: '/analysis/NVDA', linkLabel: 'NVIDIA insiders →' },
  { icon: GitCompare, title: 'Peer Comparison', description: 'Compare up to 5 companies side-by-side. Normalize by index-to-100, per-share, or % of revenue. Head-to-head snapshot table with color-coded leaders.', link: '/compare/AAPL,MSFT,GOOGL,META,AMZN', linkLabel: 'Compare Big Tech →' },
  { icon: FileSearch, title: 'Crypto Disclosure Scanner', description: "Scan any company's SEC filings for bitcoin, cryptocurrency, and digital asset mentions. Paragraph-level excerpts with direct links to source filings. Compare crypto exposure across up to 5 tickers.", link: '/crypto', linkLabel: 'Scan MSTR, COIN, MARA →' },
];

const PEER_GROUP_SAMPLES = [
  { label: 'Big Tech', tickers: 'AAPL,MSFT,GOOGL,META,AMZN', icon: Cpu },
  { label: 'Big Banks', tickers: 'JPM,BAC,WFC,C,GS', icon: Landmark },
  { label: 'Semiconductors', tickers: 'NVDA,AMD,INTC,AVGO,QCOM', icon: Cpu },
  { label: 'U.S. Airlines', tickers: 'DAL,UAL,AAL,LUV', icon: Plane },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const { tickerMap, setTickerMap } = useContext(TickerContext);

  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [error, setError] = useState(null);
  const [disambiguation, setDisambiguation] = useState(null);
  const inputRef = useRef(null);
  const searchContainerRef = useRef(null);

  useEffect(() => {
    if (tickerMap && Object.keys(tickerMap).length > 0) return;
    (async () => {
      try {
        const map = await loadClassifiedTickerMap();
        setTickerMap(map);
      } catch {
        // Silent
      }
    })();
  }, [tickerMap, setTickerMap]);

  useEffect(() => {
    const handleClick = (e) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target)) {
        setShowSuggestions(false);
        setDisambiguation(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (error) setError(null);
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  const { suggestions, active, completed } = getSuggestions(input, tickerMap, 8);
  const isCompareMode = input.includes(',');

  const performNavigation = useCallback((path, originalQuery) => {
    setInput('');
    setShowSuggestions(false);
    setError(null);
    setDisambiguation(null);
    pushRecentSearch({ query: originalQuery, path });
    navigate(path);
  }, [navigate]);

  const handleSubmit = () => {
    const decision = routeSearch(input, tickerMap);
    if (decision.path) {
      performNavigation(decision.path, input);
    } else if (decision.disambiguate) {
      setShowSuggestions(false);
      setDisambiguation(decision.disambiguate);
    } else if (decision.error) {
      setError(decision.error);
      setShowSuggestions(false);
    }
  };

  const handleRowDefaultClick = (suggestion) => {
    if (isCompareMode) {
      const parsed = parseActiveSegment(input);
      const newCompleted = [...parsed.completed, suggestion.ticker];
      const newInput = newCompleted.join(',') + ',';
      setInput(newInput);
      setShowSuggestions(true);
      setHighlightedIdx(0);
      inputRef.current?.focus();
      return;
    }
    const decision = routeSearch(suggestion.ticker, tickerMap);
    if (decision.path) {
      performNavigation(decision.path, suggestion.ticker);
    } else if (decision.disambiguate) {
      setShowSuggestions(false);
      setDisambiguation(decision.disambiguate);
    }
  };

  const handleSuggestionAction = (suggestion, actionType) => {
    if (isCompareMode) {
      handleRowDefaultClick(suggestion);
      return;
    }
    let path;
    if (actionType === 'crypto') path = '/crypto';
    else if (actionType === 'filings') path = `/filings/${suggestion.ticker}`;
    else if (actionType === 'fund') path = `/fund/${suggestion.ticker}`;
    else if (actionType === 'analysis') path = `/analysis/${suggestion.ticker}`;
    else return;
    performNavigation(path, suggestion.ticker);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (showSuggestions) setHighlightedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (showSuggestions) setHighlightedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (showSuggestions && suggestions.length > 0 && highlightedIdx < suggestions.length) {
        handleRowDefaultClick(suggestions[highlightedIdx]);
      } else {
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setDisambiguation(null);
    } else if (e.key === 'Tab' && showSuggestions && suggestions.length > 0) {
      e.preventDefault();
      handleRowDefaultClick(suggestions[highlightedIdx]);
    }
  };

  const handleDisambiguationPick = (path) => {
    setDisambiguation(null);
    pushRecentSearch({ query: input, path });
    setInput('');
    navigate(path);
  };

  const clearInput = () => {
    setInput('');
    setError(null);
    setDisambiguation(null);
    inputRef.current?.focus();
  };

  return (
    <>
      <SEO
        title=""
        description="Free, source-linked SEC filings explorer for every publicly traded U.S. company. Read actual 10-Ks, 10-Qs, 8-Ks, and Form 4s. Scan any company's filings for crypto disclosures. Every financial value cites its XBRL source on SEC.gov."
        path="/"
      />

      <section className="py-8 md:py-12 border-b-2 border-stone-800 mb-8">
        <div className="max-w-4xl">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] uppercase tracking-[0.3em] text-amber-400 font-bold">SEC Public Filings Explorer</span>
            <span className="text-stone-700">•</span>
            <span className="text-[10px] uppercase tracking-[0.3em] text-stone-500">Direct From data.sec.gov</span>
          </div>

          <h1 className="text-3xl md:text-5xl font-black tracking-tight text-stone-100 mb-4 leading-tight">
            SEC filings and financial data,{' '}
            <span className="text-amber-400">without the noise.</span>
          </h1>

          <p className="text-base md:text-lg text-stone-400 leading-relaxed mb-6 max-w-3xl">
            A transparent, source-linked explorer for every publicly traded U.S. company.
            Read the actual filings. See the reported financials. Compare peers. Track insiders.
            Scan crypto disclosures. Every number cites its XBRL source on SEC.gov.
          </p>

          {/* Hero search with dropdown and disambiguation */}
          <div ref={searchContainerRef} className="relative mb-6 max-w-2xl">
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-stone-500 pointer-events-none" />
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value.toUpperCase());
                    setShowSuggestions(true);
                    setHighlightedIdx(0);
                  }}
                  onFocus={() => input && setShowSuggestions(true)}
                  onKeyDown={handleKeyDown}
                  placeholder="Enter any ticker (AAPL, BTC, SPY) or multiple for compare (AAPL,MSFT)"
                  className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-11 pr-11 py-3.5 text-base font-bold tracking-wider placeholder-stone-600 transition-colors"
                  autoComplete="off"
                  autoFocus
                  spellCheck="false"
                />
                {input && (
                  <button
                    onClick={clearInput}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
                    type="button"
                    aria-label="Clear"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              <button
                onClick={handleSubmit}
                disabled={!input.trim()}
                className="px-6 py-3.5 bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors flex items-center justify-center gap-2"
                type="button"
              >
                Analyze
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            {error && !disambiguation && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-rose-950/80 border-2 border-rose-800 px-3 py-2 flex items-center gap-2 z-40">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span className="text-xs text-rose-200">{error}</span>
              </div>
            )}

            {disambiguation && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-amber-700 shadow-2xl z-50">
                <div className="px-3 py-2 border-b-2 border-stone-800 bg-amber-950/30">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-amber-300 font-bold">
                    "{disambiguation.ticker}"{disambiguation.name ? ` · ${disambiguation.name}` : ''} — pick destination
                  </span>
                </div>
                <div className="divide-y divide-stone-800">
                  {disambiguation.options.map((opt, i) => {
                    const Icon = opt.type === 'crypto' ? Bitcoin
                      : opt.type === 'fund' ? Wallet
                      : opt.type === 'filings' ? FileText
                      : opt.type === 'analysis' ? BarChart3
                      : Building2;
                    const color = opt.type === 'crypto' ? 'text-amber-400'
                      : opt.type === 'fund' ? 'text-emerald-400'
                      : opt.type === 'filings' ? 'text-sky-400'
                      : 'text-amber-400';
                    return (
                      <button
                        key={i}
                        onMouseDown={(e) => { e.preventDefault(); handleDisambiguationPick(opt.path); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-stone-800/60 transition-colors group"
                        type="button"
                      >
                        <Icon className={`w-4 h-4 shrink-0 ${color}`} />
                        <span className="flex-1 text-sm text-stone-200 group-hover:text-stone-100">{opt.label}</span>
                        <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-amber-400 shrink-0" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {showSuggestions && !disambiguation && suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-stone-700 shadow-2xl z-50 max-h-[28rem] overflow-y-auto">
                {isCompareMode && completed.length > 0 && (
                  <div className="px-3 py-1.5 border-b-2 border-stone-800 bg-emerald-950/30 flex items-center gap-2">
                    <GitCompareIcon className="w-3 h-3 text-emerald-400" />
                    <span className="text-[10px] uppercase tracking-[0.2em] text-emerald-300 font-bold">
                      Compare mode · {completed.length}/5 added · pick next
                    </span>
                  </div>
                )}
                {suggestions.map((s, i) => (
                  <SuggestionRow
                    key={`${s.type}-${s.ticker}`}
                    suggestion={s}
                    highlighted={i === highlightedIdx}
                    isCompareMode={isCompareMode}
                    onHover={() => setHighlightedIdx(i)}
                    onRowClick={() => handleRowDefaultClick(s)}
                    onActionClick={(action) => handleSuggestionAction(s, action)}
                  />
                ))}
              </div>
            )}

            {showSuggestions && !disambiguation && input.trim() && suggestions.length === 0 && active && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-stone-700 px-3 py-3 z-40">
                <span className="text-xs text-stone-500">
                  No matches for "{active}". Try a different ticker or company name.
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11px] uppercase tracking-wider text-stone-500">
            <span className="flex items-center gap-1.5"><Database className="w-3.5 h-3.5 text-amber-500" />Live data from SEC.gov</span>
            <span className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5 text-emerald-500" />No tracking, no accounts</span>
            <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-sky-500" />Every value source-linked</span>
            <span className="flex items-center gap-1.5"><ExternalLink className="w-3.5 h-3.5 text-violet-500" />Free forever</span>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <div className="flex items-end justify-between mb-4 flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">Start here</div>
            <h2 className="text-xl md:text-2xl font-black text-stone-100">Try it with a familiar company</h2>
          </div>
          <span className="text-xs text-stone-500">One click → full financial analysis, industry-specific ratios, filings, insiders</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {FEATURED_TICKERS.map((t) => {
            const accentClass = {
              amber: 'hover:border-amber-500 hover:text-amber-300',
              sky: 'hover:border-sky-500 hover:text-sky-300',
              emerald: 'hover:border-emerald-500 hover:text-emerald-300',
              rose: 'hover:border-rose-500 hover:text-rose-300',
            }[t.accent];
            return (
              <Link key={t.ticker} to={`/analysis/${t.ticker}`} className={`group block border-2 border-stone-800 bg-stone-900/30 p-4 transition-colors ${accentClass}`}>
                <div className="flex items-start justify-between mb-2">
                  <span className="text-xl md:text-2xl font-black tracking-wider text-stone-100 group-hover:text-current transition-colors">{t.ticker}</span>
                  <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-current transition-colors" />
                </div>
                <div className="text-[11px] text-stone-400 mb-1 font-bold truncate">{t.name}</div>
                <div className="text-[9px] uppercase tracking-widest text-stone-600 mb-2">{t.industry}</div>
                <div className="text-[10px] text-stone-500 leading-tight">{t.caption}</div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mb-12">
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">What you can do</div>
          <h2 className="text-xl md:text-2xl font-black text-stone-100">Seven ways to explore any company</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURE_GRID.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="border-2 border-stone-800 bg-stone-900/30 p-5 hover:border-amber-500/50 transition-colors group">
                <Icon className="w-6 h-6 text-amber-400 mb-3" />
                <h3 className="text-sm font-black uppercase tracking-wider text-stone-100 mb-2">{feature.title}</h3>
                <p className="text-xs text-stone-400 leading-relaxed mb-3">{feature.description}</p>
                <Link to={feature.link} className="text-xs text-amber-400 hover:text-amber-300 font-bold uppercase tracking-wider inline-flex items-center gap-1 group-hover:gap-2 transition-all">
                  {feature.linkLabel}
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mb-12">
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">Compare peer groups instantly</div>
          <h2 className="text-xl md:text-2xl font-black text-stone-100">Side-by-side in one click</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {PEER_GROUP_SAMPLES.map((g) => {
            const Icon = g.icon;
            return (
              <Link key={g.label} to={`/compare/${g.tickers}`} className="flex items-center gap-3 p-4 border-2 border-stone-800 bg-stone-900/30 hover:border-amber-500 hover:bg-amber-500/5 transition-colors group">
                <Icon className="w-5 h-5 text-amber-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black uppercase tracking-wider text-stone-100 group-hover:text-amber-300 transition-colors truncate">{g.label}</div>
                  <div className="text-[10px] text-stone-500 truncate">{g.tickers}</div>
                </div>
                <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-amber-400 transition-colors shrink-0" />
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mb-12">
        <div className="border-2 border-stone-800 bg-stone-900/30 p-6 md:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-10">
            <div>
              <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-2">Why another SEC tool?</div>
              <h2 className="text-lg md:text-xl font-black text-stone-100 mb-3">Built for people who want to check the footnotes.</h2>
              <p className="text-sm text-stone-400 leading-relaxed">
                Most financial tools tell you what the numbers are. This one shows you where they
                came from. Every value on every page links to the exact XBRL tag, filing, and
                accession number on SEC.gov. Hover any number to see its source.
              </p>
            </div>
            <div className="space-y-3">
              <DifferentiatorRow label="Source-linked" text="Every value shows its XBRL tag, filing date, and accession number" />
              <DifferentiatorRow label="Industry-aware" text="Banks get bank ratios, tech gets tech ratios, retail gets retail ratios" />
              <DifferentiatorRow label="No account needed" text="No sign-up, no email capture, no paywalls — just the data" />
              <DifferentiatorRow label="Research-grade" text="Built for analysts, students, and curious readers of 10-Ks" />
            </div>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <div className="border-2 border-amber-700/40 bg-amber-950/20 p-6 md:p-8 text-center">
          <h2 className="text-xl md:text-2xl font-black text-amber-300 mb-2">Pick any ticker to begin.</h2>
          <p className="text-sm text-stone-300 mb-5 max-w-2xl mx-auto">
            There are over 10,000 publicly traded U.S. companies in the SEC database.
            Type any of them above, or start with a featured example.
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            <Link to="/filings/AAPL" className="inline-flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors">
              <FileText className="w-4 h-4" />Browse Filings
            </Link>
            <Link to="/analysis/AAPL" className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors">
              <BarChart3 className="w-4 h-4" />View Analysis
            </Link>
            <Link to="/compare/AAPL,MSFT,GOOGL,META,AMZN" className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors">
              <GitCompare className="w-4 h-4" />Compare Peers
            </Link>
            <Link to="/crypto" className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors">
              <FileSearch className="w-4 h-4" />Scan Crypto Disclosures
            </Link>
          </div>
        </div>
      </section>

      <section className="mb-4">
        <div className="flex items-start gap-3 p-4 border border-stone-800 bg-stone-950/50">
          <Info className="w-4 h-4 text-stone-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-stone-500 leading-relaxed">
            <span className="font-bold text-stone-400">For research and educational use only.</span>{' '}
            Not investment advice. Data from SEC public APIs — verify critical numbers against
            original filings. See the <Link to="/about" className="text-amber-400 hover:underline">About page</Link> for
            methodology, limitations, and data sources.
          </p>
        </div>
      </section>
    </>
  );
}

function SuggestionRow({ suggestion: s, highlighted, isCompareMode, onHover, onRowClick, onActionClick }) {
  const Icon = s.type === 'crypto' ? Bitcoin : s.type === 'fund' ? Wallet : Building2;
  const color = s.type === 'crypto' ? 'text-amber-400' : s.type === 'fund' ? 'text-emerald-400' : 'text-sky-400';
  const badgeLabel = s.type === 'crypto' ? 'CRYPTO' : s.type === 'fund' ? 'FUND' : null;
  const badgeColor = s.type === 'crypto'
    ? 'bg-amber-900/60 text-amber-300 border-amber-700/60'
    : 'bg-emerald-900/60 text-emerald-300 border-emerald-700/60';

  return (
    <div
      onMouseEnter={onHover}
      className={`flex items-center gap-2 px-3 py-2 border-b border-stone-800 last:border-b-0 transition-colors ${
        highlighted ? 'bg-amber-500/10 border-l-2 border-l-amber-500 pl-[10px]' : 'hover:bg-stone-800/50'
      }`}
    >
      <button
        onMouseDown={(e) => { e.preventDefault(); onRowClick(); }}
        className="flex-1 flex items-center gap-3 min-w-0 text-left"
        type="button"
      >
        <Icon className={`w-3.5 h-3.5 shrink-0 ${color}`} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-sm font-black tracking-wider text-stone-100 shrink-0">{s.ticker}</span>
          <span className="text-xs text-stone-400 truncate">{s.name}</span>
        </div>
        {badgeLabel && (
          <span className={`shrink-0 text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 border ${badgeColor}`}>
            {badgeLabel}
          </span>
        )}
      </button>

      {!isCompareMode && (
        <div className="flex items-center gap-1 shrink-0">
          {s.type === 'crypto' ? (
            <ActionBtn onClick={() => onActionClick('crypto')} label="Crypto" icon={Bitcoin} color="amber" />
          ) : (
            <>
              <ActionBtn onClick={() => onActionClick('filings')} label="Filings" icon={FileText} color="sky" />
              {s.type === 'fund' ? (
                <ActionBtn onClick={() => onActionClick('fund')} label="Fund" icon={Wallet} color="emerald" />
              ) : (
                <ActionBtn onClick={() => onActionClick('analysis')} label="Analysis" icon={BarChart3} color="amber" />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ onClick, label, icon: Icon, color }) {
  const colorClasses = {
    amber: 'border-amber-800/60 text-amber-300 hover:bg-amber-500 hover:text-stone-950 hover:border-amber-500',
    sky: 'border-sky-800/60 text-sky-300 hover:bg-sky-500 hover:text-stone-950 hover:border-sky-500',
    emerald: 'border-emerald-800/60 text-emerald-300 hover:bg-emerald-500 hover:text-stone-950 hover:border-emerald-500',
  };
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      className={`flex items-center gap-1 px-2 py-1 border text-[10px] font-bold uppercase tracking-wider transition-colors ${colorClasses[color]}`}
      type="button"
    >
      <Icon className="w-2.5 h-2.5" />
      {label}
    </button>
  );
}

function DifferentiatorRow({ label, text }) {
  return (
    <div className="flex items-start gap-3">
      <span className="shrink-0 inline-block w-20 text-[10px] uppercase tracking-widest text-amber-400 font-bold pt-0.5">{label}</span>
      <span className="text-xs text-stone-300 leading-relaxed">{text}</span>
    </div>
  );
}
