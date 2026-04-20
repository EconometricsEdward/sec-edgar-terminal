import React, { useState, useEffect, useRef, useContext, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Search, X, AlertCircle, Bitcoin, Building2, Wallet as WalletIcon,
  ArrowRight, Clock, Command, GitCompare, FileText, BarChart3,
} from 'lucide-react';
import { TickerContext } from '../App.jsx';
import { loadClassifiedTickerMap } from '../utils/tickerMapLoader.js';
import {
  routeSearch,
  getSuggestions,
  parseActiveSegment,
  loadRecentSearches,
  pushRecentSearch,
  clearRecentSearches,
  buildDestinationOptions,
  CRYPTO_TICKERS,
  CRYPTO_NAMES,
} from '../utils/searchRouter.js';

export default function GlobalSearchBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { tickerMap, setTickerMap } = useContext(TickerContext);

  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [error, setError] = useState(null);
  const [disambiguation, setDisambiguation] = useState(null);
  const [recentSearches, setRecentSearches] = useState([]);
  const [showRecent, setShowRecent] = useState(false);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  // Load classified ticker map on mount
  useEffect(() => {
    if (tickerMap && Object.keys(tickerMap).length > 0) return;
    (async () => {
      try {
        const map = await loadClassifiedTickerMap();
        setTickerMap(map);
      } catch (err) {
        console.warn('GlobalSearchBar: Could not load ticker map', err);
      }
    })();
  }, [tickerMap, setTickerMap]);

  useEffect(() => {
    setRecentSearches(loadRecentSearches());
  }, []);

  useEffect(() => {
    const handleClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowSuggestions(false);
        setDisambiguation(null);
        setShowRecent(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (error) setError(null);
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+K / Cmd+K focuses the search bar
  useEffect(() => {
    const handler = (e) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isCmdK) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Clear input when navigating
  useEffect(() => {
    setInput('');
    setShowSuggestions(false);
    setDisambiguation(null);
    setShowRecent(false);
  }, [location.pathname]);

  const { suggestions, active, completed } = getSuggestions(input, tickerMap, 10);

  const performNavigation = useCallback(
    (path, originalQuery) => {
      setInput('');
      setShowSuggestions(false);
      setShowRecent(false);
      setError(null);
      setDisambiguation(null);
      pushRecentSearch({ query: originalQuery, path });
      setRecentSearches(loadRecentSearches());
      navigate(path);
    },
    [navigate]
  );

  // When a user picks a suggestion with a specific destination button
  const handleSuggestionAction = (suggestion, actionType) => {
    const isCompareMode = input.includes(',');
    if (isCompareMode) {
      // In compare mode, ADD to list regardless of action type
      const parsed = parseActiveSegment(input);
      const newCompleted = [...parsed.completed, suggestion.ticker];
      const newInput = newCompleted.join(',') + ',';
      setInput(newInput);
      setShowSuggestions(true);
      setHighlightedIdx(0);
      inputRef.current?.focus();
      return;
    }

    // Single mode: navigate based on actionType
    let path;
    if (actionType === 'crypto') path = '/crypto';
    else if (actionType === 'filings') path = `/filings/${suggestion.ticker}`;
    else if (actionType === 'fund') path = `/fund/${suggestion.ticker}`;
    else if (actionType === 'analysis') path = `/analysis/${suggestion.ticker}`;
    else {
      // Default click on row body — use disambiguation flow
      handleRowDefaultClick(suggestion);
      return;
    }
    performNavigation(path, suggestion.ticker);
  };

  // Default click on suggestion row (not on an action button)
  const handleRowDefaultClick = (suggestion) => {
    const isCompareMode = input.includes(',');
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

    // Single mode — open disambiguation for the chosen ticker
    const decision = routeSearch(suggestion.ticker, tickerMap);
    if (decision.path) {
      performNavigation(decision.path, suggestion.ticker);
    } else if (decision.disambiguate) {
      setShowSuggestions(false);
      setDisambiguation(decision.disambiguate);
    } else if (decision.error) {
      // Shouldn't happen for a suggestion, but handle gracefully
      setError(decision.error);
    }
  };

  const handleSubmit = () => {
    const decision = routeSearch(input, tickerMap);
    if (decision.path) {
      performNavigation(decision.path, input);
    } else if (decision.disambiguate) {
      setShowSuggestions(false);
      setShowRecent(false);
      setDisambiguation(decision.disambiguate);
    } else if (decision.error) {
      setError(decision.error);
      setShowSuggestions(false);
      setShowRecent(false);
    }
  };

  const handleRecentClick = (recent) => {
    performNavigation(recent.path, recent.query);
  };

  const handleClearRecent = () => {
    clearRecentSearches();
    setRecentSearches([]);
  };

  const handleKeyDown = (e) => {
    const activeList = showRecent && !input ? recentSearches : showSuggestions ? suggestions : [];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (showRecent || showSuggestions) {
        setHighlightedIdx((i) => Math.min(i + 1, activeList.length - 1));
      } else if (!input && recentSearches.length > 0) {
        setShowRecent(true);
        setHighlightedIdx(0);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (showRecent || showSuggestions) {
        setHighlightedIdx((i) => Math.max(i - 1, 0));
      } else if (!input && recentSearches.length > 0) {
        setShowRecent(true);
        setHighlightedIdx(0);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (showRecent && recentSearches.length > 0 && highlightedIdx < recentSearches.length) {
        handleRecentClick(recentSearches[highlightedIdx]);
      } else if (showSuggestions && suggestions.length > 0 && highlightedIdx < suggestions.length) {
        // Pick the highlighted suggestion with default routing
        handleRowDefaultClick(suggestions[highlightedIdx]);
      } else {
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setShowRecent(false);
      setDisambiguation(null);
      inputRef.current?.blur();
    } else if (e.key === 'Tab' && showSuggestions && suggestions.length > 0) {
      e.preventDefault();
      handleRowDefaultClick(suggestions[highlightedIdx]);
    }
  };

  const handleDisambiguationPick = (path) => {
    setDisambiguation(null);
    pushRecentSearch({ query: input, path });
    setRecentSearches(loadRecentSearches());
    setInput('');
    navigate(path);
  };

  const clearInput = () => {
    setInput('');
    setError(null);
    setDisambiguation(null);
    inputRef.current?.focus();
  };

  const handleFocus = () => {
    if (input) {
      setShowSuggestions(true);
    } else if (recentSearches.length > 0) {
      setShowRecent(true);
    }
  };

  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  const isCompareMode = input.includes(',');
  const syntaxHint = computeSyntaxHint(input, tickerMap, completed);
  const showingDropdown =
    (showSuggestions && suggestions.length > 0) ||
    (showRecent && recentSearches.length > 0) ||
    disambiguation ||
    (showSuggestions && input.trim() && suggestions.length === 0 && active);

  return (
    <div ref={containerRef} className="relative">
      <div className="flex gap-0">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value.toUpperCase());
              setShowSuggestions(true);
              setShowRecent(false);
              setHighlightedIdx(0);
            }}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            placeholder="Search any ticker (AAPL, BTC, SPY) or company name — comma-separate for compare"
            className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-10 pr-24 py-2.5 text-sm font-bold tracking-wider placeholder-stone-600 transition-colors"
            autoComplete="off"
            spellCheck="false"
          />
          {!input && (
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden sm:flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider text-stone-500 border border-stone-700 bg-stone-950 pointer-events-none">
              <Command className="w-2.5 h-2.5" />
              {isMac ? 'K' : 'Ctrl+K'}
            </kbd>
          )}
          {input && (
            <button
              onClick={clearInput}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
              aria-label="Clear search"
              type="button"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <button
          onClick={handleSubmit}
          disabled={!input.trim()}
          className="px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors flex items-center gap-1.5 border-2 border-amber-500 disabled:border-stone-800"
          type="button"
        >
          Go
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Syntax hint */}
      {syntaxHint && !showingDropdown && (
        <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
          <span className={`inline-flex items-center gap-1.5 px-2 py-1 border ${syntaxHint.color}`}>
            {syntaxHint.icon}
            {syntaxHint.label}
          </span>
          <span className="text-stone-600">{syntaxHint.tip}</span>
        </div>
      )}

      {/* Error */}
      {error && !disambiguation && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-rose-950/80 border-2 border-rose-800 px-3 py-2 flex items-center gap-2 z-40">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span className="text-xs text-rose-200">{error}</span>
        </div>
      )}

      {/* Disambiguation */}
      {disambiguation && (
        <DisambiguationPopover
          disambiguation={disambiguation}
          onPick={handleDisambiguationPick}
        />
      )}

      {/* Recent */}
      {showRecent && !input && recentSearches.length > 0 && !disambiguation && (
        <RecentDropdown
          recentSearches={recentSearches}
          highlightedIdx={highlightedIdx}
          setHighlightedIdx={setHighlightedIdx}
          onRecentClick={handleRecentClick}
          onClear={handleClearRecent}
        />
      )}

      {/* Suggestions */}
      {showSuggestions && !disambiguation && suggestions.length > 0 && (
        <SuggestionsDropdown
          suggestions={suggestions}
          highlightedIdx={highlightedIdx}
          setHighlightedIdx={setHighlightedIdx}
          isCompareMode={isCompareMode}
          completed={completed}
          onRowClick={handleRowDefaultClick}
          onActionClick={handleSuggestionAction}
        />
      )}

      {/* No results */}
      {showSuggestions && !disambiguation && input.trim() && suggestions.length === 0 && active && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-stone-700 px-3 py-3 z-40">
          <span className="text-xs text-stone-500">
            No matches for "{active}". Try a different ticker or company name.
          </span>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function DisambiguationPopover({ disambiguation, onPick }) {
  return (
    <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-amber-700 shadow-2xl z-50">
      <div className="px-3 py-2 border-b-2 border-stone-800 bg-amber-950/30">
        <span className="text-[10px] uppercase tracking-[0.2em] text-amber-300 font-bold">
          "{disambiguation.ticker}"{disambiguation.name ? ` · ${disambiguation.name}` : ''} — pick destination
        </span>
      </div>
      <div className="divide-y divide-stone-800">
        {disambiguation.options.map((opt, i) => {
          const { TypeIcon, color } = getTypeVisuals(opt.type);
          return (
            <button
              key={i}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(opt.path);
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-stone-800/60 transition-colors group"
              type="button"
            >
              <TypeIcon className={`w-4 h-4 shrink-0 ${color}`} />
              <span className="flex-1 text-sm text-stone-200 group-hover:text-stone-100">
                {opt.label}
              </span>
              <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-amber-400 shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RecentDropdown({ recentSearches, highlightedIdx, setHighlightedIdx, onRecentClick, onClear }) {
  return (
    <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-stone-700 shadow-2xl z-50 max-h-96 overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-1.5 border-b-2 border-stone-800 bg-stone-950/40">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
          <Clock className="w-3 h-3" />
          Recent
        </span>
        <button
          onMouseDown={(e) => { e.preventDefault(); onClear(); }}
          className="text-[10px] uppercase tracking-wider text-stone-600 hover:text-stone-400"
          type="button"
        >
          Clear
        </button>
      </div>
      {recentSearches.map((r, i) => (
        <button
          key={`${r.query}-${r.ts}`}
          onMouseEnter={() => setHighlightedIdx(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onRecentClick(r);
          }}
          className={`w-full flex items-center gap-3 px-3 py-2 text-left border-b border-stone-800 last:border-b-0 transition-colors ${
            i === highlightedIdx
              ? 'bg-amber-500/10 border-l-2 border-l-amber-500 pl-[10px]'
              : 'hover:bg-stone-800/50'
          }`}
          type="button"
        >
          <Clock className="w-3.5 h-3.5 shrink-0 text-stone-500" />
          <span className="flex-1 text-sm font-bold tracking-wider text-stone-200">{r.query}</span>
          <span className="text-[10px] uppercase tracking-wider text-stone-600">
            {r.path.replace(/^\//, '').split('/')[0]}
          </span>
        </button>
      ))}
    </div>
  );
}

function SuggestionsDropdown({
  suggestions,
  highlightedIdx,
  setHighlightedIdx,
  isCompareMode,
  completed,
  onRowClick,
  onActionClick,
}) {
  return (
    <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-stone-700 shadow-2xl z-50 max-h-[32rem] overflow-y-auto">
      {isCompareMode && completed.length > 0 && (
        <div className="px-3 py-1.5 border-b-2 border-stone-800 bg-emerald-950/30 flex items-center gap-2">
          <GitCompare className="w-3 h-3 text-emerald-400" />
          <span className="text-[10px] uppercase tracking-[0.2em] text-emerald-300 font-bold">
            Compare mode · {completed.length}/5 added · pick next
          </span>
        </div>
      )}
      {suggestions.map((s, i) => {
        const { TypeIcon, color, badgeColor, badgeLabel } = getTypeVisuals(s.type);
        return (
          <div
            key={`${s.type}-${s.ticker}`}
            onMouseEnter={() => setHighlightedIdx(i)}
            className={`flex items-center gap-2 px-3 py-2 border-b border-stone-800 last:border-b-0 transition-colors ${
              i === highlightedIdx
                ? 'bg-amber-500/10 border-l-2 border-l-amber-500 pl-[10px]'
                : 'hover:bg-stone-800/50'
            }`}
          >
            {/* Row body: clicking here uses default routing (disambiguation in single mode, add in compare mode) */}
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                onRowClick(s);
              }}
              className="flex-1 flex items-center gap-3 min-w-0 text-left"
              type="button"
            >
              <TypeIcon className={`w-3.5 h-3.5 shrink-0 ${color}`} />
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <span className="text-sm font-black tracking-wider text-stone-100 shrink-0">
                  {s.ticker}
                </span>
                <span className="text-xs text-stone-400 truncate">{s.name}</span>
              </div>
              {badgeLabel && (
                <span
                  className={`shrink-0 text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 border ${badgeColor}`}
                >
                  {badgeLabel}
                </span>
              )}
            </button>

            {/* Inline action buttons (only in single mode) */}
            {!isCompareMode && (
              <div className="flex items-center gap-1 shrink-0">
                {s.type === 'crypto' ? (
                  <ActionButton
                    onClick={() => onActionClick(s, 'crypto')}
                    label="Crypto"
                    icon={Bitcoin}
                    color="amber"
                  />
                ) : (
                  <>
                    <ActionButton
                      onClick={() => onActionClick(s, 'filings')}
                      label="Filings"
                      icon={FileText}
                      color="sky"
                    />
                    {s.type === 'fund' ? (
                      <ActionButton
                        onClick={() => onActionClick(s, 'fund')}
                        label="Fund"
                        icon={WalletIcon}
                        color="emerald"
                      />
                    ) : (
                      <ActionButton
                        onClick={() => onActionClick(s, 'analysis')}
                        label="Analysis"
                        icon={BarChart3}
                        color="amber"
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ActionButton({ onClick, label, icon: Icon, color }) {
  const colorClasses = {
    amber: 'border-amber-800/60 text-amber-300 hover:bg-amber-500 hover:text-stone-950 hover:border-amber-500',
    sky: 'border-sky-800/60 text-sky-300 hover:bg-sky-500 hover:text-stone-950 hover:border-sky-500',
    emerald: 'border-emerald-800/60 text-emerald-300 hover:bg-emerald-500 hover:text-stone-950 hover:border-emerald-500',
  };
  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={`flex items-center gap-1 px-2 py-1 border text-[10px] font-bold uppercase tracking-wider transition-colors ${colorClasses[color]}`}
      type="button"
      title={`Go to ${label}`}
    >
      <Icon className="w-2.5 h-2.5" />
      {label}
    </button>
  );
}

// ============================================================================
// Visual helpers
// ============================================================================

function getTypeVisuals(type) {
  if (type === 'crypto') {
    return {
      TypeIcon: Bitcoin,
      color: 'text-amber-400',
      badgeColor: 'bg-amber-900/60 text-amber-300 border-amber-700/60',
      badgeLabel: 'CRYPTO',
    };
  }
  if (type === 'fund') {
    return {
      TypeIcon: WalletIcon,
      color: 'text-emerald-400',
      badgeColor: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/60',
      badgeLabel: 'FUND',
    };
  }
  if (type === 'filings') {
    return {
      TypeIcon: FileText,
      color: 'text-sky-400',
      badgeColor: '',
      badgeLabel: null,
    };
  }
  if (type === 'analysis') {
    return {
      TypeIcon: BarChart3,
      color: 'text-amber-400',
      badgeColor: '',
      badgeLabel: null,
    };
  }
  return {
    TypeIcon: Building2,
    color: 'text-sky-400',
    badgeColor: '',
    badgeLabel: null,
  };
}

function computeSyntaxHint(input, tickerMap, completed) {
  if (!input || !input.trim()) return null;

  const isCompareMode = input.includes(',');
  if (isCompareMode) {
    const count = completed.length;
    if (count >= 5) {
      return {
        label: `${count}/5 tickers`,
        icon: <GitCompare className="w-2.5 h-2.5" />,
        tip: 'Max reached — press Enter to compare',
        color: 'bg-rose-950/40 text-rose-300 border-rose-800',
      };
    }
    return {
      label: `Compare · ${count}/5`,
      icon: <GitCompare className="w-2.5 h-2.5" />,
      tip: count >= 2 ? 'Press Enter to compare, or add more' : 'Add at least 2 tickers',
      color: 'bg-emerald-950/40 text-emerald-300 border-emerald-800',
    };
  }

  const normalized = input.trim().toUpperCase();
  if (CRYPTO_TICKERS.has(normalized)) {
    const alsoSEC = tickerMap?.[normalized];
    if (alsoSEC) {
      return {
        label: 'Ambiguous',
        icon: <AlertCircle className="w-2.5 h-2.5" />,
        tip: 'Matches crypto AND a SEC ticker — press Enter to pick',
        color: 'bg-amber-950/40 text-amber-300 border-amber-800',
      };
    }
    return {
      label: 'Crypto',
      icon: <Bitcoin className="w-2.5 h-2.5" />,
      tip: 'Press Enter → crypto page',
      color: 'bg-amber-950/40 text-amber-300 border-amber-800',
    };
  }

  const entry = tickerMap?.[normalized];
  if (entry?.isFund) {
    return {
      label: 'Fund',
      icon: <WalletIcon className="w-2.5 h-2.5" />,
      tip: `${entry.name} — press Enter to pick Filings or Fund page`,
      color: 'bg-emerald-950/40 text-emerald-300 border-emerald-800',
    };
  }
  if (entry) {
    return {
      label: 'Company',
      icon: <Building2 className="w-2.5 h-2.5" />,
      tip: `${entry.name} — press Enter to pick Filings or Analysis`,
      color: 'bg-sky-950/40 text-sky-300 border-sky-800',
    };
  }

  return {
    label: 'Searching',
    icon: <Search className="w-2.5 h-2.5" />,
    tip: 'Pick a suggestion or press Enter',
    color: 'bg-stone-900 text-stone-500 border-stone-700',
  };
}
