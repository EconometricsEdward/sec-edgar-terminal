'use client';

import { useState, useContext, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight, Search, Bitcoin, Building2, Wallet, X, AlertCircle,
  GitCompare as GitCompareIcon, FileText, BarChart3,
} from 'lucide-react';
import { TickerContext } from '../contexts/TickerContext';
import { loadClassifiedTickerMap } from '../utils/tickerMapLoader.js';
import {
  routeSearch,
  getSuggestions,
  parseActiveSegment,
  pushRecentSearch,
} from '../utils/searchRouter.js';

// ============================================================================
// Types
// ============================================================================
interface Suggestion {
  ticker: string;
  name: string;
  type: 'crypto' | 'fund' | 'company' | string;
}

interface DisambiguationOption {
  type: string;
  label: string;
  path: string;
}

interface Disambiguation {
  ticker: string;
  name?: string;
  options: DisambiguationOption[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyValue = any;

// ============================================================================
// HeroSearch — the big search input on the landing page hero
//
// Structurally similar to GlobalSearchBar but with different styling and
// without the recent-searches dropdown (this is for first-time visitors who
// don't have history yet). Some duplication with GlobalSearchBar is by
// design here — refactoring to a shared component is a Phase 3 cleanup.
// ============================================================================
export default function HeroSearch() {
  const router = useRouter();
  const ctx = useContext(TickerContext);
  const tickerMap = ctx?.tickerMap ?? null;
  const setTickerMap = ctx?.setTickerMap ?? (() => {});

  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [disambiguation, setDisambiguation] = useState<Disambiguation | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Load classified ticker map on mount if not already loaded
  useEffect(() => {
    if (tickerMap && Object.keys(tickerMap).length > 0) return;
    (async () => {
      try {
        const map = await loadClassifiedTickerMap();
        setTickerMap(map);
      } catch {
        // Silent — search still works for crypto without ticker map
      }
    })();
  }, [tickerMap, setTickerMap]);

  // Click outside closes dropdowns
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
        setDisambiguation(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Clear error when input changes
  useEffect(() => {
    if (error) setError(null);
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  const { suggestions, active, completed } = getSuggestions(input, tickerMap, 8);
  const isCompareMode = input.includes(',');

  const performNavigation = useCallback((path: string, originalQuery: string) => {
    setInput('');
    setShowSuggestions(false);
    setError(null);
    setDisambiguation(null);
    pushRecentSearch({ query: originalQuery, path });
    router.push(path);
  }, [router]);

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

  const handleRowDefaultClick = (suggestion: Suggestion) => {
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

  const handleSuggestionAction = (suggestion: Suggestion, actionType: string) => {
    if (isCompareMode) {
      handleRowDefaultClick(suggestion);
      return;
    }
    let path: string | undefined;
    if (actionType === 'crypto') path = '/crypto';
    else if (actionType === 'filings') path = `/filings/${suggestion.ticker}`;
    else if (actionType === 'fund') path = `/fund/${suggestion.ticker}`;
    else if (actionType === 'analysis') path = `/analysis/${suggestion.ticker}`;
    else return;
    performNavigation(path, suggestion.ticker);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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

  const handleDisambiguationPick = (path: string) => {
    setDisambiguation(null);
    pushRecentSearch({ query: input, path });
    setInput('');
    router.push(path);
  };

  const clearInput = () => {
    setInput('');
    setError(null);
    setDisambiguation(null);
    inputRef.current?.focus();
  };

  return (
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
              &quot;{disambiguation.ticker}&quot;{disambiguation.name ? ` · ${disambiguation.name}` : ''} — pick destination
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
          {suggestions.map((s: Suggestion, i: number) => (
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
            No matches for &quot;{active}&quot;. Try a different ticker or company name.
          </span>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SuggestionRow — single row in the suggestions dropdown
// ============================================================================
interface SuggestionRowProps {
  suggestion: Suggestion;
  highlighted: boolean;
  isCompareMode: boolean;
  onHover: () => void;
  onRowClick: () => void;
  onActionClick: (action: string) => void;
}

function SuggestionRow({ suggestion: s, highlighted, isCompareMode, onHover, onRowClick, onActionClick }: SuggestionRowProps) {
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

// ============================================================================
// ActionBtn — small destination-specific button on each suggestion row
// ============================================================================
interface ActionBtnProps {
  onClick: () => void;
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: AnyValue;
  color: 'amber' | 'sky' | 'emerald';
}

function ActionBtn({ onClick, label, icon: Icon, color }: ActionBtnProps) {
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
