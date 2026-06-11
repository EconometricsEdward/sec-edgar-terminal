import React, { useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ChevronRight, Clock, Database, FileSearch, Loader2, Search, Sparkles, X,
  FileText, Hash, ShieldCheck,
} from 'lucide-react';
import { DISCLOSURE_MARKET_MAP, DISCLOSURE_UNIVERSES } from '../utils/disclosureUniverses.js';

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

const INDEX_QUICK_STARTS = [
  {
    label: 'AI infrastructure',
    query: 'artificial intelligence, generative AI, GPU, data center',
    months: 12,
    formPresetId: 'reports',
    limit: 50,
    note: 'Find fresh AI demand, capex, and risk language across company reports',
  },
  {
    label: 'Tariff exposure',
    query: 'tariff, tariffs, trade restrictions, supply chain disruption',
    months: 36,
    formPresetId: 'reports',
    limit: 50,
    note: 'Surface import-cost and supply-chain sensitivity across public companies',
  },
  {
    label: 'Cyber incidents',
    query: 'cybersecurity incident, data breach, ransomware, unauthorized access',
    months: 36,
    formPresetId: 'broad',
    limit: 100,
    note: 'Search risk factors, event filings, and company incident disclosures',
  },
  {
    label: 'Liquidity pressure',
    query: 'going concern, substantial doubt, liquidity, covenant breach',
    months: 36,
    formPresetId: 'reports',
    limit: 100,
    note: 'Screen for stress signals in annual and quarterly reports',
  },
  {
    label: 'Restructuring cycle',
    query: 'restructuring, impairment, cost reduction, workforce reduction',
    months: 24,
    formPresetId: 'broad',
    limit: 100,
    note: 'Find turnaround, layoff, and asset write-down language across filings',
  },
  {
    label: 'Customer concentration',
    query: 'customer concentration, major customer, significant customer',
    months: 36,
    formPresetId: 'reports',
    limit: 50,
    note: 'Identify issuers disclosing customer dependency or revenue concentration',
  },
];

const INDEX_RESEARCH_PLAYBOOKS = [
  {
    label: 'Solvency Watch',
    query: 'going concern, substantial doubt, covenant breach, debt default',
    months: 36,
    formPresetId: 'reports',
    limit: 100,
    matchMode: 'any',
    tone: 'rose',
    note: 'Cash runway, covenant, and default language',
  },
  {
    label: 'Restatement Watch',
    query: 'non-reliance, restatement, material weakness, change in accountant',
    months: 36,
    formPresetId: 'broad',
    limit: 100,
    matchMode: 'any',
    tone: 'rose',
    note: 'Accounting, controls, and auditor-change signals',
  },
  {
    label: 'Tariff + Supply Chain',
    query: 'tariff, supply chain',
    months: 36,
    formPresetId: 'reports',
    limit: 50,
    matchMode: 'all',
    tone: 'amber',
    note: 'Requires both cost and logistics language',
  },
  {
    label: 'Customer Dependency',
    query: 'customer concentration, major customer, significant customer',
    months: 36,
    formPresetId: 'reports',
    limit: 50,
    matchMode: 'any',
    tone: 'amber',
    note: 'Revenue concentration and dependency disclosures',
  },
  {
    label: 'AI Capex Demand',
    query: 'artificial intelligence, data center, GPU, capital expenditures',
    months: 12,
    formPresetId: 'reports',
    limit: 100,
    matchMode: 'any',
    tone: 'sky',
    note: 'AI demand, infrastructure, and spend intensity',
  },
  {
    label: 'Power Constraints',
    query: 'power availability, electricity, grid interconnection, data center',
    months: 24,
    formPresetId: 'reports',
    limit: 50,
    matchMode: 'any',
    tone: 'sky',
    note: 'Energy availability and compute buildout friction',
  },
  {
    label: 'Cyber Incident Trail',
    query: 'cybersecurity incident, unauthorized access, ransomware, data breach',
    months: 36,
    formPresetId: 'broad',
    limit: 100,
    matchMode: 'any',
    tone: 'emerald',
    note: 'Incident, breach, and control-response language',
  },
  {
    label: 'Regulatory Pressure',
    query: 'investigation, subpoena, enforcement action, consent order',
    months: 36,
    formPresetId: 'broad',
    limit: 100,
    matchMode: 'any',
    tone: 'emerald',
    note: 'Government, regulator, and legal-process signals',
  },
];

const INDEX_RANGES = [
  { label: 'Last 90 Days', months: 3 },
  { label: 'Last 12 Months', months: 12 },
  { label: 'Last 36 Months', months: 36 },
  { label: 'Last 10 Years', months: 120 },
];

const INDEX_FORM_PRESETS = [
  {
    id: 'broad',
    label: 'Broad',
    detail: '10-K, 10-Q, 8-K, registration, proxy, foreign issuer, and fund reports',
    forms: ['10-K', '10-Q', '8-K', 'S-1', 'S-3', 'S-4', 'DEF 14A', 'DEFM14A', '20-F', '40-F', 'N-CSR', 'NPORT-P'],
  },
  {
    id: 'reports',
    label: 'Reports',
    detail: 'Annual and quarterly reports only',
    forms: ['10-K', '10-Q'],
  },
  {
    id: 'events',
    label: 'Events',
    detail: 'Material event filings only',
    forms: ['8-K'],
  },
  {
    id: 'deals',
    label: 'Deals + Proxy',
    detail: 'Registration statements, merger proxies, and annual proxies',
    forms: ['S-1', 'S-3', 'S-4', 'DEF 14A', 'DEFM14A'],
  },
  {
    id: 'foreign-funds',
    label: 'Foreign + Funds',
    detail: 'Foreign issuer, shareholder, and fund portfolio reports',
    forms: ['20-F', '40-F', 'N-CSR', 'NPORT-P'],
  },
];

const INDEX_RESULT_LIMITS = [25, 50, 100];

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

function indexFormPresetById(id) {
  return INDEX_FORM_PRESETS.find((preset) => preset.id === id) || INDEX_FORM_PRESETS[0];
}

function playbookToneClasses(tone) {
  const classes = {
    rose: {
      card: 'border-rose-900/70 bg-rose-950/20 hover:border-rose-500 hover:bg-rose-500/5',
      icon: 'text-rose-400',
      text: 'group-hover:text-rose-300',
      meta: 'text-rose-300',
      chip: 'border-rose-800/70 bg-rose-950/30 text-rose-200',
    },
    amber: {
      card: 'border-amber-900/70 bg-amber-950/20 hover:border-amber-500 hover:bg-amber-500/5',
      icon: 'text-amber-400',
      text: 'group-hover:text-amber-300',
      meta: 'text-amber-300',
      chip: 'border-amber-800/70 bg-amber-950/30 text-amber-200',
    },
    sky: {
      card: 'border-sky-900/70 bg-sky-950/20 hover:border-sky-500 hover:bg-sky-500/5',
      icon: 'text-sky-400',
      text: 'group-hover:text-sky-300',
      meta: 'text-sky-300',
      chip: 'border-sky-800/70 bg-sky-950/30 text-sky-200',
    },
    emerald: {
      card: 'border-emerald-900/70 bg-emerald-950/20 hover:border-emerald-500 hover:bg-emerald-500/5',
      icon: 'text-emerald-400',
      text: 'group-hover:text-emerald-300',
      meta: 'text-emerald-300',
      chip: 'border-emerald-800/70 bg-emerald-950/30 text-emerald-200',
    },
  };
  return classes[tone] || classes.sky;
}

export default function DisclosureScanner({ initialQuery = '', initialFocus = '', onScanComplete }) {
  const [searchMode, setSearchMode] = useState(initialQuery ? 'index' : 'companies');
  const [tickerInput, setTickerInput] = useState('');
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [universeId, setUniverseId] = useState(DISCLOSURE_UNIVERSES[0]?.id || '');
  const [indexMonths, setIndexMonths] = useState(12);
  const [indexFormPresetId, setIndexFormPresetId] = useState('broad');
  const [indexLimit, setIndexLimit] = useState(50);
  const [indexFocusInput, setIndexFocusInput] = useState(initialFocus);
  const [matchMode, setMatchMode] = useState('any');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const tickerRef = useRef(null);

  const tickers = useMemo(() => parseTickers(tickerInput), [tickerInput]);
  const terms = useMemo(() => parseTerms(queryInput), [queryInput]);
  const selectedUniverse = useMemo(
    () => DISCLOSURE_UNIVERSES.find((universe) => universe.id === universeId) || DISCLOSURE_UNIVERSES[0],
    [universeId],
  );
  const selectedIndexFormPreset = useMemo(
    () => indexFormPresetById(indexFormPresetId),
    [indexFormPresetId],
  );
  const isIndexMode = searchMode === 'index';
  const isUniverseMode = searchMode === 'universe';
  const isMarketMode = searchMode === 'market';
  const scopeCount = isIndexMode
    ? null
    : isMarketMode
    ? (DISCLOSURE_MARKET_MAP?.tickers?.length || 0)
    : isUniverseMode
      ? (selectedUniverse?.tickers?.length || 0)
      : tickers.length;
  const isValid = isIndexMode
    ? terms.length >= 1
    : isMarketMode
    ? terms.length >= 1
    : isUniverseMode
    ? Boolean(selectedUniverse) && terms.length >= 1
    : tickers.length >= 1 && tickers.length <= 5 && terms.length >= 1;

  const runSearch = async (nextTickers, nextQuery, options = {}) => {
    const index = options.index === true;
    const universe = options.universe || null;
    const market = options.market === true;
    if (scanning || (!index && !universe && !market && !nextTickers.length) || !nextQuery.trim()) return;

    setScanning(true);
    setError(null);

    try {
      const params = new URLSearchParams({ query: nextQuery });
      let endpoint = '/api/disclosure-search';
      params.set('match', options.matchMode || matchMode);

      if (index) {
        endpoint = '/api/edgar-index-search';
        params.set('months', String(options.months || indexMonths));
        params.set('limit', String(options.limit || indexLimit));
        const forms = options.forms || selectedIndexFormPreset.forms;
        if (forms?.length) params.set('forms', forms.join(','));
        const focus = options.focus ?? indexFocusInput;
        if (focus?.trim()) params.set('focus', focus.trim());
      } else {
        params.set('depth', String(options.depth || (market ? 2 : universe ? 12 : 35)));
        if (market) params.set('market', 'true');
        else if (universe) params.set('universe', universe);
        else params.set('tickers', nextTickers.join(','));
        if (options.fresh) params.set('fresh', 'true');
      }

      const response = await fetch(`${endpoint}?${params}`);
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
    if (isIndexMode) {
      runSearch([], queryInput, {
        index: true,
        months: indexMonths,
        forms: selectedIndexFormPreset.forms,
        limit: indexLimit,
        focus: indexFocusInput,
        matchMode,
      });
    } else if (isMarketMode) {
      runSearch([], queryInput, { market: true, depth: 2, matchMode });
    } else if (isUniverseMode) {
      runSearch([], queryInput, { universe: selectedUniverse.id, depth: 12, matchMode });
    } else {
      runSearch(tickers, queryInput, { matchMode });
    }
  };

  const clearTickers = () => {
    setTickerInput('');
    setError(null);
    tickerRef.current?.focus();
  };

  const applyQuickStart = (item) => {
    if (scanning) return;
    setSearchMode('companies');
    setMatchMode('any');
    setTickerInput(item.tickers);
    setQueryInput(item.query);
    runSearch(parseTickers(item.tickers), item.query, { matchMode: 'any' });
  };

  const applyIndexQuickStart = (item) => {
    if (scanning) return;
    const formPreset = indexFormPresetById(item.formPresetId);
    setSearchMode('index');
    setMatchMode('any');
    setQueryInput(item.query);
    setIndexMonths(item.months);
    setIndexFormPresetId(formPreset.id);
    setIndexLimit(item.limit);
    setIndexFocusInput('');
    runSearch([], item.query, {
      index: true,
      months: item.months,
      forms: formPreset.forms,
      limit: item.limit,
      focus: '',
      matchMode: 'any',
    });
  };

  const applyIndexPlaybook = (item) => {
    if (scanning) return;
    const formPreset = indexFormPresetById(item.formPresetId);
    const nextMatchMode = item.matchMode === 'all' ? 'all' : 'any';
    setSearchMode('index');
    setMatchMode(nextMatchMode);
    setQueryInput(item.query);
    setIndexMonths(item.months);
    setIndexFormPresetId(formPreset.id);
    setIndexLimit(item.limit);
    setIndexFocusInput('');
    runSearch([], item.query, {
      index: true,
      months: item.months,
      forms: formPreset.forms,
      limit: item.limit,
      focus: '',
      matchMode: nextMatchMode,
    });
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
        tickers, scan a curated sector universe, use Market Map, or search the SEC full-text
        index with company focus plus date, form, and result-count filters; every match links back to the original filing on SEC.gov.
      </p>

      <form onSubmit={handleSubmit} className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-1">
          <ModeButton
            icon={Search}
            label="Companies"
            active={!isIndexMode && !isUniverseMode && !isMarketMode}
            onClick={() => {
              setSearchMode('companies');
              setError(null);
            }}
            disabled={scanning}
          />
          <ModeButton
            icon={FileSearch}
            label="EDGAR Index"
            active={isIndexMode}
            onClick={() => {
              setSearchMode('index');
              setError(null);
            }}
            disabled={scanning}
          />
          <ModeButton
            icon={Database}
            label="Universe"
            active={isUniverseMode}
            onClick={() => {
              setSearchMode('universe');
              setError(null);
            }}
            disabled={scanning}
          />
          <ModeButton
            icon={Activity}
            label="Market Map"
            active={isMarketMode}
            onClick={() => {
              setSearchMode('market');
              setError(null);
            }}
            disabled={scanning}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] gap-2">
          {isIndexMode ? (
            <label className="block">
              <span className="block mb-1 text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
                SEC index range
              </span>
              <div className="relative">
                <FileSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500 pointer-events-none" />
                <select
                  value={indexMonths}
                  onChange={(event) => {
                    setIndexMonths(Number(event.target.value));
                    setError(null);
                  }}
                  className="w-full appearance-none bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-10 pr-8 py-3 text-sm font-bold tracking-wider transition-colors"
                  disabled={scanning}
                >
                  {INDEX_RANGES.map((range) => (
                    <option key={range.months} value={range.months}>
                      {range.label}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          ) : isMarketMode ? (
            <label className="block">
              <span className="block mb-1 text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
                Discovery scope
              </span>
              <div className="flex items-center gap-3 bg-stone-900 border-2 border-stone-800 px-3 py-3 min-h-[50px]">
                <Activity className="w-4 h-4 text-sky-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-black tracking-wider text-stone-100">
                    {DISCLOSURE_MARKET_MAP.label}
                  </div>
                  <div className="text-[10px] uppercase tracking-widest text-stone-500 truncate">
                    {DISCLOSURE_MARKET_MAP.tickers.length} companies / 2 filings each
                  </div>
                </div>
              </div>
            </label>
          ) : isUniverseMode ? (
            <label className="block">
              <span className="block mb-1 text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
                Universe
              </span>
              <div className="relative">
                <Database className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-500 pointer-events-none" />
                <select
                  value={universeId}
                  onChange={(event) => {
                    setUniverseId(event.target.value);
                    setError(null);
                  }}
                  className="w-full appearance-none bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-10 pr-8 py-3 text-sm font-bold tracking-wider transition-colors"
                  disabled={scanning}
                >
                  {DISCLOSURE_UNIVERSES.map((universe) => (
                    <option key={universe.id} value={universe.id}>
                      {universe.label}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          ) : (
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
          )}

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

        <div className="flex flex-wrap items-center gap-2 border-2 border-stone-800 bg-stone-900/30 p-2">
          <span className="px-1 text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
            Match mode
          </span>
          <button
            type="button"
            onClick={() => {
              setMatchMode('any');
              setError(null);
            }}
            disabled={scanning}
            className={`border px-2.5 py-1.5 text-[10px] uppercase tracking-[0.14em] font-black transition-colors ${
              matchMode === 'any'
                ? 'border-amber-400 bg-amber-400 text-stone-950'
                : 'border-stone-700 bg-stone-950/70 text-stone-400 hover:border-amber-500 hover:text-amber-200'
            }`}
          >
            Any term
          </button>
          <button
            type="button"
            onClick={() => {
              setMatchMode('all');
              setError(null);
            }}
            disabled={scanning || terms.length < 2}
            title={terms.length < 2 ? 'Add at least two terms to require all terms' : 'Require every entered term or phrase'}
            className={`border px-2.5 py-1.5 text-[10px] uppercase tracking-[0.14em] font-black transition-colors ${
              matchMode === 'all'
                ? 'border-sky-400 bg-sky-400 text-stone-950'
                : 'border-stone-700 bg-stone-950/70 text-stone-400 hover:border-sky-500 hover:text-sky-200'
            } disabled:opacity-50 disabled:hover:border-stone-700 disabled:hover:text-stone-400`}
          >
            All terms
          </button>
          <span className="text-[10px] leading-relaxed text-stone-500">
            {matchMode === 'all'
              ? 'Only filings matching every entered term are counted.'
              : 'Filings matching any entered term are counted.'}
          </span>
        </div>

        {isIndexMode && !scanning && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)_220px] gap-2">
            <div className="border-2 border-stone-800 bg-stone-900/30 p-3">
              <div className="mb-2 flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-sky-400" />
                <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
                  Filing forms
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {INDEX_FORM_PRESETS.map((preset) => {
                  const active = preset.id === indexFormPresetId;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setIndexFormPresetId(preset.id);
                        setError(null);
                      }}
                      disabled={scanning}
                      title={preset.detail}
                      className={`border px-2.5 py-1.5 text-[10px] uppercase tracking-[0.14em] font-black transition-colors ${
                        active
                          ? 'border-sky-400 bg-sky-400 text-stone-950'
                          : 'border-stone-700 bg-stone-950/70 text-stone-400 hover:border-sky-500 hover:text-sky-200'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 text-[10px] leading-relaxed text-stone-500">
                {selectedIndexFormPreset.detail}
              </div>
            </div>

            <label className="block border-2 border-stone-800 bg-stone-900/30 p-3">
              <span className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
                <Search className="w-3.5 h-3.5 text-sky-400" />
                Company focus
              </span>
              <div className="relative">
                <input
                  type="text"
                  value={indexFocusInput}
                  onChange={(event) => {
                    setIndexFocusInput(event.target.value);
                    setError(null);
                  }}
                  placeholder="Optional: AAPL, Apple, CIK"
                  className="w-full bg-stone-950 border border-stone-700 focus:border-sky-500 outline-none px-3 py-2 pr-8 text-sm font-bold tracking-wider placeholder-stone-600 transition-colors"
                  autoComplete="off"
                  spellCheck="false"
                  disabled={scanning}
                />
                {indexFocusInput && !scanning && (
                  <button
                    type="button"
                    onClick={() => {
                      setIndexFocusInput('');
                      setError(null);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
                    aria-label="Clear company focus"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-2 text-[10px] leading-relaxed text-stone-500">
                Narrow returned index hits to matching ticker, CIK, or company name.
              </div>
            </label>

            <label className="block border-2 border-stone-800 bg-stone-900/30 p-3">
              <span className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
                <Hash className="w-3.5 h-3.5 text-sky-400" />
                Source filings
              </span>
              <select
                value={indexLimit}
                onChange={(event) => {
                  setIndexLimit(Number(event.target.value));
                  setError(null);
                }}
                className="w-full appearance-none bg-stone-950 border border-stone-700 focus:border-sky-500 outline-none px-3 py-2 text-sm font-bold tracking-wider transition-colors"
                disabled={scanning}
              >
                {INDEX_RESULT_LIMITS.map((limit) => (
                  <option key={limit} value={limit}>
                    Up to {limit}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {isIndexMode && !scanning && (
          <div className="border-2 border-sky-800/50 bg-sky-950/20 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-xs font-black text-stone-100">SEC EDGAR full-text index</div>
                <div className="mt-1 text-[10px] uppercase tracking-widest text-stone-500">
                  Broad discovery across indexed SEC filings; open each linked filing to verify exact context.
                </div>
              </div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-sky-300">
                {selectedIndexFormPreset.label} / up to {indexLimit} source filings
                {indexFocusInput.trim() ? ` / focus: ${indexFocusInput.trim()}` : ''}
                {matchMode === 'all' ? ' / all terms' : ' / any term'}
              </div>
            </div>
          </div>
        )}

        {isMarketMode && !scanning && (
          <div className="border-2 border-sky-800/50 bg-sky-950/20 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-xs font-black text-stone-100">{DISCLOSURE_MARKET_MAP.label}</div>
                <div className="mt-1 text-[10px] uppercase tracking-widest text-stone-500">
                  {DISCLOSURE_MARKET_MAP.description}
                </div>
              </div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-sky-300">
                {DISCLOSURE_MARKET_MAP.tickers.length} companies / 2 filings each
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {DISCLOSURE_MARKET_MAP.tickers.map((ticker) => (
                <span
                  key={ticker}
                  className="border border-stone-700 bg-stone-950/70 px-2 py-0.5 text-[10px] font-bold tracking-wider text-stone-300"
                >
                  {ticker}
                </span>
              ))}
            </div>
          </div>
        )}

        {isUniverseMode && selectedUniverse && !scanning && (
          <div className="border-2 border-stone-800 bg-stone-900/30 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-xs font-black text-stone-100">{selectedUniverse.label}</div>
                <div className="mt-1 text-[10px] uppercase tracking-widest text-stone-500">
                  {selectedUniverse.description}
                </div>
              </div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-sky-300">
                {selectedUniverse.tickers.length} companies / 12 filings each
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {selectedUniverse.tickers.map((ticker) => (
                <span
                  key={ticker}
                  className="border border-stone-700 bg-stone-950/70 px-2 py-0.5 text-[10px] font-bold tracking-wider text-stone-300"
                >
                  {ticker}
                </span>
              ))}
            </div>
          </div>
        )}

        {((scopeCount || 0) > 0 || terms.length > 0 || isIndexMode) && !scanning && (
          <div className="text-[10px] font-mono uppercase tracking-wider text-stone-500">
            {isIndexMode
              ? `EDGAR index: ${INDEX_RANGES.find((range) => range.months === indexMonths)?.label || 'Custom range'} / ${selectedIndexFormPreset.label} / max ${indexLimit}${indexFocusInput.trim() ? ` / focus ${indexFocusInput.trim()}` : ''}`
              : isMarketMode
              ? `Market Map: ${scopeCount} companies`
              : isUniverseMode
              ? `Universe: ${selectedUniverse?.label || 'Select a universe'} (${scopeCount} companies)`
              : tickers.length > 5
                ? `Too many companies: ${tickers.length}. Max 5.`
                : tickers.length > 0
                  ? `Companies: ${tickers.join(', ')}`
                  : 'Add at least 1 company'}
            <span className="mx-2 text-stone-700">/</span>
            {terms.length > 0 ? `Terms: ${terms.slice(0, 4).join(', ')}${terms.length > 4 ? '...' : ''}` : 'Add at least 1 term'}
            <span className="mx-2 text-stone-700">/</span>
            {matchMode === 'all' ? 'All terms required' : 'Any term can match'}
          </div>
        )}
      </form>

      {scanning && (
        <div className="mb-4 border-2 border-amber-700/40 bg-amber-950/20 p-4 flex items-start gap-3">
          <Loader2 className="w-5 h-5 text-amber-400 shrink-0 mt-0.5 animate-spin" />
          <div className="flex-1">
            <div className="text-sm text-amber-200 font-bold mb-1">
              {isIndexMode
                ? 'Searching the SEC EDGAR full-text index...'
                : `Searching SEC filings for ${scopeCount} ${scopeCount === 1 ? 'company' : 'companies'}...`}
            </div>
            <div className="text-xs text-amber-100/80 leading-relaxed">
              {isIndexMode
                ? `The index search asks SEC for ${matchMode === 'all' ? 'filings that include every entered term' : 'filings that include any entered term'} across ${selectedIndexFormPreset.label.toLowerCase()} filings${indexFocusInput.trim() ? `, narrows returned hits to ${indexFocusInput.trim()}` : ''}, then returns direct SEC archive links for verification.`
                : `The scanner fetches recent 10-K, 10-Q, 8-K, proxy, registration, foreign issuer, and fund filings, converts them to text, and returns paragraph-level excerpts with direct SEC source links. ${matchMode === 'all' ? 'Only filings containing every entered term are counted.' : 'Filings containing any entered term are counted.'}`}
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
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <ShieldCheck className="w-3 h-3 text-stone-500" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
                Analyst playbooks
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
              {INDEX_RESEARCH_PLAYBOOKS.map((item) => {
                const formPreset = indexFormPresetById(item.formPresetId);
                const rangeLabel =
                  INDEX_RANGES.find((range) => range.months === item.months)?.label ||
                  `${item.months} months`;
                const tone = playbookToneClasses(item.tone);
                const matchLabel = item.matchMode === 'all' ? 'All terms' : 'Any term';
                return (
                  <button
                    key={item.label}
                    onClick={() => applyIndexPlaybook(item)}
                    className={`group flex min-h-[146px] flex-col justify-between p-3 border-2 transition-colors text-left ${tone.card}`}
                    type="button"
                  >
                    <div>
                      <div className="flex items-start gap-2">
                        <ShieldCheck className={`w-4 h-4 shrink-0 mt-0.5 ${tone.icon}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-sm font-black tracking-wider text-stone-100 transition-colors ${tone.text}`}>
                              {item.label}
                            </span>
                            <ChevronRight className={`w-3 h-3 text-stone-700 group-hover:translate-x-0.5 transition-all ${tone.meta}`} />
                          </div>
                          <div className="mt-1 text-[9px] uppercase tracking-widest text-stone-600">
                            {item.note}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <span className={`border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] font-bold ${tone.chip}`}>
                        {matchLabel}
                      </span>
                      <span className="border border-stone-700 bg-stone-950/70 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-stone-400">
                        {rangeLabel}
                      </span>
                      <span className="border border-stone-700 bg-stone-950/70 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-stone-400">
                        {formPreset.label}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <Database className="w-3 h-3 text-stone-500" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
                EDGAR index prompts
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {INDEX_QUICK_STARTS.map((item) => {
                const formPreset = indexFormPresetById(item.formPresetId);
                const rangeLabel =
                  INDEX_RANGES.find((range) => range.months === item.months)?.label ||
                  `${item.months} months`;
                return (
                  <button
                    key={item.label}
                    onClick={() => applyIndexQuickStart(item)}
                    className="group flex items-start gap-3 p-3 border-2 border-sky-900/70 bg-sky-950/20 hover:border-sky-500 hover:bg-sky-500/5 transition-colors text-left"
                    type="button"
                  >
                    <Database className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-black tracking-wider text-stone-100 group-hover:text-sky-300 transition-colors">
                          {item.label}
                        </span>
                        <ChevronRight className="w-3 h-3 text-stone-700 group-hover:text-sky-400 group-hover:translate-x-0.5 transition-all" />
                      </div>
                      <div className="text-[10px] text-stone-400 font-bold truncate">
                        {rangeLabel} / {formPreset.label} / up to {item.limit}
                      </div>
                      <div className="text-[9px] uppercase tracking-widest text-stone-600 mt-0.5">
                        {item.note}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-3 h-3 text-stone-500" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">
                Company scan prompts
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
        </div>
      )}
    </div>
  );
}

function ModeButton({ icon: Icon, label, active, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 border-2 px-3 py-2 text-[10px] uppercase tracking-[0.18em] font-black transition-colors ${
        active
          ? 'border-amber-500 bg-amber-500 text-stone-950'
          : 'border-stone-800 bg-stone-900 text-stone-400 hover:border-stone-700 hover:text-stone-200'
      } disabled:opacity-60`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}
