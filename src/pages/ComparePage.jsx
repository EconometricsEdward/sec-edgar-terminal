import React, { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  GitCompare, X, Plus, Loader2, AlertCircle, Search, Link as LinkIcon,
  AlertTriangle, Download, Sparkles, TrendingUp, Percent, BarChart3,
  Trophy, LayoutGrid, ExternalLink,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip, CartesianGrid, ReferenceLine, Cell,
} from 'recharts';
import { TickerContext } from '../App.jsx';
import { ComparisonChart } from '../components/MetricChart.jsx';
import { secDataUrl, secFilesUrl } from '../utils/secApi.js';
import {
  extractAnnualPeriods, buildMetricRow, computeGrowth, buildSourceUrl,
} from '../utils/xbrlParser.js';
import { classifyIndustry } from '../utils/industry.js';
import { PEER_GROUPS, COMPANY_COLORS } from '../utils/peerGroups.js';

const ABSOLUTE_METRICS = [
  { key: 'revenue', label: 'Revenue', format: 'currency' },
  { key: 'netIncome', label: 'Net Income', format: 'currency' },
  { key: 'operatingIncome', label: 'Operating Income', format: 'currency' },
  { key: 'totalAssets', label: 'Total Assets', format: 'currency' },
  { key: 'stockholdersEquity', label: "Stockholders' Equity", format: 'currency' },
  { key: 'operatingCashFlow', label: 'Operating Cash Flow', format: 'currency' },
];

const RATIO_METRICS = [
  { key: 'roe', label: 'Return on Equity (ROE)', format: 'percent',
    compute: (vals) => safeDiv(vals.netIncome, vals.stockholdersEquity) * 100,
    sourceMetricKey: 'netIncome', formulaLabel: 'Net Income ÷ Stockholders\' Equity' },
  { key: 'roa', label: 'Return on Assets (ROA)', format: 'percent',
    compute: (vals) => safeDiv(vals.netIncome, vals.totalAssets) * 100,
    sourceMetricKey: 'netIncome', formulaLabel: 'Net Income ÷ Total Assets' },
  { key: 'netMargin', label: 'Net Margin', format: 'percent',
    compute: (vals) => safeDiv(vals.netIncome, vals.revenue) * 100,
    sourceMetricKey: 'netIncome', formulaLabel: 'Net Income ÷ Revenue' },
  { key: 'operatingMargin', label: 'Operating Margin', format: 'percent',
    compute: (vals) => safeDiv(vals.operatingIncome, vals.revenue) * 100,
    sourceMetricKey: 'operatingIncome', formulaLabel: 'Operating Income ÷ Revenue' },
];

const GROWTH_BAR_METRICS = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'netIncome', label: 'Net Income' },
  { key: 'totalAssets', label: 'Total Assets' },
  { key: 'stockholdersEquity', label: "Stockholders' Equity" },
];

const NORMALIZATION_MODES = [
  { id: 'absolute', label: 'Absolute', desc: 'Raw reported values' },
  { id: 'indexed', label: 'Indexed to 100', desc: 'Relative growth from first shared year' },
  { id: 'perShare', label: 'Per Share', desc: 'Divided by diluted shares outstanding' },
  { id: 'pctRevenue', label: '% of Revenue', desc: 'Each metric as share of revenue' },
];

const MAX_COMPANIES = 5;

function safeDiv(a, b) {
  if (a == null || b == null || b === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

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
  const [normalization, setNormalization] = useState('absolute');
  const [autoSuggestFor, setAutoSuggestFor] = useState(null);
  const [autoSuggestions, setAutoSuggestions] = useState([]);

  // Fix React warning: defer URL updates so they happen AFTER render, not during.
  // Previously updateUrl was called inside setCompanies updater, causing
  // "Cannot update HashRouter while rendering ComparePage" warning.
  const updateUrl = useCallback((cmps) => {
    const tickers = cmps.map((c) => c.ticker).join(',');
    // Defer navigation to next tick so React finishes the render first
    setTimeout(() => {
      if (tickers) navigate(`/compare/${tickers}`, { replace: true });
      else navigate('/compare', { replace: true });
    }, 0);
  }, [navigate]);

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

  const addCompany = useCallback(async (entry, updateUrlAfter = true) => {
    if (companies.find((c) => c.ticker === entry.ticker)) return;
    if (companies.length >= MAX_COMPANIES) {
      setGlobalError(`Maximum of ${MAX_COMPANIES} companies at once.`);
      return;
    }
    setGlobalError(null);

    const color = COMPANY_COLORS[companies.length % COMPANY_COLORS.length];
    const newCompany = {
      ticker: entry.ticker, name: entry.name, cik: entry.cik, color,
      facts: null, sicCode: null, sicDescription: null,
      loading: true, error: null,
    };

    setCompanies((prev) => [...prev, newCompany]);
    if (updateUrlAfter) {
      updateUrl([...companies, newCompany]);
    }

    try {
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
      let sicDescription = null;
      if (submissionsRes.ok) {
        const sub = await submissionsRes.json();
        sicCode = sub.sic;
        sicDescription = sub.sicDescription;
      }
      setCompanies((prev) => prev.map((c) =>
        c.ticker === entry.ticker
          ? { ...c, facts: factsData.facts || {}, sicCode, sicDescription, loading: false }
          : c
      ));
    } catch (err) {
      setCompanies((prev) => prev.map((c) =>
        c.ticker === entry.ticker ? { ...c, loading: false, error: err.message } : c
      ));
    }
  }, [companies, updateUrl]);

  const removeCompany = useCallback((ticker) => {
    const next = companies.filter((c) => c.ticker !== ticker);
    const recolored = next.map((c, i) => ({ ...c, color: COMPANY_COLORS[i % COMPANY_COLORS.length] }));
    setCompanies(recolored);
    updateUrl(recolored);
  }, [companies, updateUrl]);

  const loadPeerGroup = useCallback((group) => {
    setCompanies([]);
    setAutoSuggestFor(null);
    setAutoSuggestions([]);
    setTimeout(() => {
      group.tickers.slice(0, MAX_COMPANIES).forEach((t, i) => {
        const entry = tickerMap?.[t];
        if (entry) {
          setTimeout(() => addCompany(entry, i === group.tickers.length - 1), i * 50);
        }
      });
    }, 100);
  }, [tickerMap, addCompany]);

  useEffect(() => {
    if (companies.length !== 1) {
      setAutoSuggestions([]);
      setAutoSuggestFor(null);
      return;
    }
    const anchor = companies[0];
    if (!anchor.sicCode || anchor.loading || anchor.error) return;
    if (autoSuggestFor === anchor.ticker) return;
    setAutoSuggestFor(anchor.ticker);

    const suggestions = [];
    for (const entry of Object.values(tickerMap || {})) {
      if (entry.ticker === anchor.ticker) continue;
      for (const group of PEER_GROUPS) {
        if (group.tickers.includes(anchor.ticker) && group.tickers.includes(entry.ticker)) {
          if (!suggestions.find((s) => s.ticker === entry.ticker)) {
            suggestions.push({ ...entry, groupLabel: group.label });
          }
          break;
        }
      }
    }
    setAutoSuggestions(suggestions.slice(0, 4));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, tickerMap, autoSuggestFor]);

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

  const alignedPeriods = useMemo(() => {
    const allYears = new Set();
    companies.forEach((c) => {
      if (c.facts) {
        extractAnnualPeriods(c.facts).slice(0, 10).forEach((p) => allYears.add(p.fy));
      }
    });
    return Array.from(allYears).sort((a, b) => b - a).slice(0, 10);
  }, [companies]);

  const allLoaded = companies.length > 0 && companies.every((c) => !c.loading);

  const buildSeriesForMetric = useCallback((metricKey, format = 'currency') => {
    return companies
      .filter((c) => c.facts && !c.error)
      .map((c) => {
        const companyPeriods = extractAnnualPeriods(c.facts).slice(0, 10);
        const row = buildMetricRow(c.facts, metricKey, '', companyPeriods, format, c.sicCode);
        return { name: c.name, ticker: c.ticker, color: c.color, data: row.values, sicCode: c.sicCode };
      });
  }, [companies]);

  const normalizeSeries = useCallback((series, mode, metricKey) => {
    if (mode === 'absolute') return series;
    if (mode === 'indexed') {
      return series.map((s) => {
        const sorted = [...s.data].sort((a, b) => (a.period?.fy || 0) - (b.period?.fy || 0));
        const baseline = sorted.find((v) => v.value != null)?.value;
        if (!baseline || baseline === 0) return s;
        return {
          ...s,
          data: s.data.map((v) => ({ ...v, value: v.value != null ? (v.value / baseline) * 100 : null })),
        };
      });
    }
    if (mode === 'perShare') {
      return series.map((s) => {
        const company = companies.find((c) => c.ticker === s.ticker);
        if (!company?.facts) return s;
        const periods = extractAnnualPeriods(company.facts).slice(0, 10);
        const sharesRow = buildMetricRow(company.facts, 'dilutedShares', '', periods, 'decimal', company.sicCode);
        return {
          ...s,
          data: s.data.map((v, i) => {
            const shares = sharesRow.values[i]?.value;
            if (v.value == null || !shares || shares === 0) return { ...v, value: null };
            return { ...v, value: v.value / shares };
          }),
        };
      });
    }
    if (mode === 'pctRevenue') {
      if (metricKey === 'revenue') {
        return series.map((s) => ({
          ...s,
          data: s.data.map((v) => ({ ...v, value: v.value != null ? 100 : null })),
        }));
      }
      return series.map((s) => {
        const company = companies.find((c) => c.ticker === s.ticker);
        if (!company?.facts) return s;
        const periods = extractAnnualPeriods(company.facts).slice(0, 10);
        const revRow = buildMetricRow(company.facts, 'revenue', '', periods, 'currency', company.sicCode);
        return {
          ...s,
          data: s.data.map((v, i) => {
            const rev = revRow.values[i]?.value;
            if (v.value == null || !rev || rev === 0) return { ...v, value: null };
            return { ...v, value: (v.value / rev) * 100 };
          }),
        };
      });
    }
    return series;
  }, [companies]);

  const effectiveFormat = (originalFormat) => {
    if (normalization === 'indexed') return 'indexed';
    if (normalization === 'pctRevenue') return 'percent';
    if (normalization === 'perShare') return 'currency';
    return originalFormat;
  };

  const buildRatioSeries = useCallback((ratioMetric) => {
    return companies
      .filter((c) => c.facts && !c.error)
      .map((c) => {
        const periods = extractAnnualPeriods(c.facts).slice(0, 10);
        const revenue = buildMetricRow(c.facts, 'revenue', '', periods, 'currency', c.sicCode);
        const netIncome = buildMetricRow(c.facts, 'netIncome', '', periods, 'currency', c.sicCode);
        const operatingIncome = buildMetricRow(c.facts, 'operatingIncome', '', periods, 'currency', c.sicCode);
        const totalAssets = buildMetricRow(c.facts, 'totalAssets', '', periods, 'currency', c.sicCode);
        const equity = buildMetricRow(c.facts, 'stockholdersEquity', '', periods, 'currency', c.sicCode);
        const data = periods.map((p, i) => ({
          period: p,
          value: ratioMetric.compute({
            revenue: revenue.values[i]?.value,
            netIncome: netIncome.values[i]?.value,
            operatingIncome: operatingIncome.values[i]?.value,
            totalAssets: totalAssets.values[i]?.value,
            stockholdersEquity: equity.values[i]?.value,
          }),
        }));
        return { name: c.name, ticker: c.ticker, color: c.color, data };
      });
  }, [companies]);

  const snapshotData = useMemo(() => {
    const allMetrics = [
      { key: 'revenue', label: 'Revenue', format: 'currency', higherIsBetter: true, tooltip: 'Total revenue as reported' },
      { key: 'netIncome', label: 'Net Income', format: 'currency', higherIsBetter: true, tooltip: 'Net income as reported' },
      { key: 'operatingIncome', label: 'Operating Income', format: 'currency', higherIsBetter: true, tooltip: 'Operating income as reported' },
      { key: 'totalAssets', label: 'Total Assets', format: 'currency', higherIsBetter: null, tooltip: 'Total assets as reported (neutral — bigger is not always better)' },
      { key: 'stockholdersEquity', label: "Stockholders' Equity", format: 'currency', higherIsBetter: true, tooltip: "Total stockholders' equity as reported" },
      { key: 'operatingCashFlow', label: 'Operating Cash Flow', format: 'currency', higherIsBetter: true, tooltip: 'Cash from operations' },
      { key: 'roe', label: 'ROE', format: 'percent', higherIsBetter: true, computed: true, tooltip: 'Return on Equity = Net Income ÷ Stockholders\' Equity' },
      { key: 'roa', label: 'ROA', format: 'percent', higherIsBetter: true, computed: true, tooltip: 'Return on Assets = Net Income ÷ Total Assets' },
      { key: 'netMargin', label: 'Net Margin', format: 'percent', higherIsBetter: true, computed: true, tooltip: 'Net Margin = Net Income ÷ Revenue' },
      { key: 'operatingMargin', label: 'Operating Margin', format: 'percent', higherIsBetter: true, computed: true, tooltip: 'Operating Margin = Operating Income ÷ Revenue' },
    ];
    return allMetrics.map((m) => {
      const row = {
        metric: m.label, metricKey: m.key, format: m.format,
        higherIsBetter: m.higherIsBetter, isComputed: !!m.computed, tooltip: m.tooltip, values: [],
      };
      companies.filter((c) => c.facts && !c.error).forEach((c) => {
        const periods = extractAnnualPeriods(c.facts).slice(0, 10);
        if (!periods.length) {
          row.values.push({ ticker: c.ticker, cik: c.cik, value: null, source: null, period: null });
          return;
        }
        if (m.computed) {
          const revenue = buildMetricRow(c.facts, 'revenue', '', periods, 'currency', c.sicCode);
          const netIncome = buildMetricRow(c.facts, 'netIncome', '', periods, 'currency', c.sicCode);
          const opIncome = buildMetricRow(c.facts, 'operatingIncome', '', periods, 'currency', c.sicCode);
          const assets = buildMetricRow(c.facts, 'totalAssets', '', periods, 'currency', c.sicCode);
          const equity = buildMetricRow(c.facts, 'stockholdersEquity', '', periods, 'currency', c.sicCode);
          const vals = {
            revenue: revenue.values[0]?.value,
            netIncome: netIncome.values[0]?.value,
            operatingIncome: opIncome.values[0]?.value,
            totalAssets: assets.values[0]?.value,
            stockholdersEquity: equity.values[0]?.value,
          };
          const ratioMetric = RATIO_METRICS.find((r) => r.key === m.key);
          const value = ratioMetric ? ratioMetric.compute(vals) : null;
          const numeratorRow = ratioMetric?.sourceMetricKey === 'operatingIncome' ? opIncome : netIncome;
          row.values.push({
            ticker: c.ticker, cik: c.cik, value,
            source: numeratorRow.values[0]?.source || null,
            period: periods[0], formulaLabel: ratioMetric?.formulaLabel,
          });
        } else {
          const r = buildMetricRow(c.facts, m.key, '', periods, 'currency', c.sicCode);
          row.values.push({
            ticker: c.ticker, cik: c.cik,
            value: r.values[0]?.value ?? null,
            source: r.values[0]?.source || null,
            period: periods[0],
          });
        }
      });
      return row;
    });
  }, [companies]);

  // ==========================================================================
  // Growth bars: ONE bar per data point, each with its own Cell fill.
  // This is the ONLY pattern Recharts respects for per-bar coloring.
  // ==========================================================================
  const buildGrowthBarRows = useCallback((field) => {
    const loadedCompanies = companies.filter((c) => c.facts && !c.error);
    const rows = [];
    GROWTH_BAR_METRICS.forEach((m) => {
      loadedCompanies.forEach((c) => {
        const periods = extractAnnualPeriods(c.facts).slice(0, 10);
        const metricRow = buildMetricRow(c.facts, m.key, '', periods, 'currency', c.sicCode);
        const growth = computeGrowth(metricRow);
        const val = field === '5y' ? growth.cagr5y : growth.cagr10y;
        rows.push({
          // Flat shape: each row IS one bar
          label: `${m.label} — ${c.ticker}`,
          metric: m.label,
          ticker: c.ticker,
          color: c.color,
          value: val,
        });
      });
    });
    return rows;
  }, [companies]);

  const exportFullCsv = () => {
    if (!companies.length || !allLoaded) return;
    const loadedCompanies = companies.filter((c) => c.facts && !c.error);
    if (!loadedCompanies.length) return;
    const rows = [];
    rows.push(['Metric', 'Company', 'Ticker', ...alignedPeriods.map((y) => `FY${String(y).slice(2)}`), 'YoY %', '5Y CAGR %', '10Y CAGR %'].join(','));
    for (const metric of ABSOLUTE_METRICS) {
      for (const c of loadedCompanies) {
        const periods = extractAnnualPeriods(c.facts).slice(0, 10);
        const row = buildMetricRow(c.facts, metric.key, '', periods, metric.format, c.sicCode);
        const growth = computeGrowth(row);
        const valsByYear = new Map();
        row.values.forEach((v) => { if (v.period?.fy) valsByYear.set(v.period.fy, v.value); });
        const vals = alignedPeriods.map((y) => {
          const val = valsByYear.get(y);
          return val == null ? '' : val;
        });
        rows.push([
          `"${metric.label}"`, `"${c.name}"`, c.ticker, ...vals,
          growth.yoy != null ? growth.yoy.toFixed(2) : '',
          growth.cagr5y != null ? growth.cagr5y.toFixed(2) : '',
          growth.cagr10y != null ? growth.cagr10y.toFixed(2) : '',
        ].join(','));
      }
    }
    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compare_${loadedCompanies.map((c) => c.ticker).join('_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const industryGroups = new Set(
    companies.filter((c) => c.sicCode).map((c) => classifyIndustry(c.sicCode))
  );
  const mixedIndustries = industryGroups.size > 1;

  return (
    <>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <GitCompare className="w-5 h-5 text-amber-500" />
          <h2 className="text-xl font-black uppercase tracking-tight">Peer Comparison</h2>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed">
          Compare up to {MAX_COMPANIES} public companies side-by-side across 10 fiscal years.
          Pick a preset peer group below or search your own tickers.
        </p>
      </div>

      {companies.length === 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span className="text-[11px] uppercase tracking-[0.2em] text-stone-300 font-bold">Common peer groups</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {PEER_GROUPS.map((group) => (
              <button key={group.id} onClick={() => loadPeerGroup(group)}
                className="flex items-center gap-2 px-3 py-2 bg-stone-900 border-2 border-stone-800 hover:border-amber-500 hover:bg-amber-500/5 text-stone-300 hover:text-amber-300 text-xs uppercase tracking-wider font-bold transition-colors group"
                title={group.description}>
                <span>{group.icon}</span>
                <span>{group.label}</span>
                <span className="text-[10px] text-stone-600 group-hover:text-amber-600 ml-1">({group.tickers.length})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {companies.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {companies.map((c) => (
            <div key={c.ticker} className="flex items-center gap-2 px-3 py-2 border-2"
              style={{
                borderColor: c.error ? '#7f1d1d' : c.loading ? '#44403c' : c.color + '80',
                backgroundColor: c.error ? '#450a0a40' : c.loading ? '#1c1917' : c.color + '1a',
                color: c.error ? '#fca5a5' : c.loading ? '#a8a29e' : c.color,
              }}>
              <span className="text-xs font-black tracking-wider">{c.ticker}</span>
              <span className="text-[11px] text-stone-400 truncate max-w-[180px]">{c.name}</span>
              {c.loading && <Loader2 className="w-3 h-3 animate-spin" />}
              {c.error && <AlertCircle className="w-3 h-3" title={c.error} />}
              <button onClick={() => removeCompany(c.ticker)} className="text-stone-500 hover:text-rose-400 ml-1">
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
              <input type="text" value={input}
                onChange={(e) => { setInput(e.target.value.toUpperCase()); setShowSuggestions(true); setHighlightedIdx(0); }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setHighlightedIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightedIdx((i) => Math.max(i - 1, 0)); }
                  else if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); }
                  else if (e.key === 'Escape') setShowSuggestions(false);
                }}
                placeholder={companies.length === 0 ? 'Or type a ticker (AAPL, Tesla, etc.)' : 'Add another company...'}
                className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-10 pr-4 py-3 text-base font-bold tracking-wider placeholder-stone-600 transition-colors"
                autoComplete="off"
              />
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-stone-900 border-2 border-stone-700 z-50 max-h-80 overflow-y-auto shadow-2xl">
                  {suggestions.map((s, i) => (
                    <button key={s.cik} onMouseEnter={() => setHighlightedIdx(i)}
                      onClick={() => { addCompany(s); setInput(''); setShowSuggestions(false); }}
                      className={`w-full flex items-center justify-between px-3 py-2.5 text-left border-b border-stone-800 last:border-b-0 transition-colors ${
                        i === highlightedIdx ? 'bg-amber-500/10 border-l-2 border-l-amber-500' : 'hover:bg-stone-800/50'
                      }`}>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-stone-100 truncate">{s.name}</div>
                      </div>
                      <div className="shrink-0 text-sm font-black text-amber-400 tracking-wider">{s.ticker}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={handleSubmit} disabled={!suggestions.length}
              className="px-5 py-3 bg-amber-500 hover:bg-amber-400 disabled:bg-stone-800 disabled:text-stone-600 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add
            </button>
            {companies.length > 0 && (
              <>
                <button onClick={copyShareLink} className="px-3 py-3 border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors" title="Copy shareable link">
                  <LinkIcon className="w-4 h-4" />
                </button>
                <button onClick={exportFullCsv} disabled={!allLoaded} className="px-3 py-3 border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 disabled:opacity-50 transition-colors" title="Download full comparison as CSV">
                  <Download className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {autoSuggestions.length > 0 && companies.length === 1 && (
        <div className="mb-6 border-2 border-sky-900/50 bg-sky-950/20 p-3">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-[11px] uppercase tracking-[0.2em] text-sky-300 font-bold">Suggested peers for {companies[0].ticker}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {autoSuggestions.map((s) => (
              <button key={s.ticker} onClick={() => addCompany(s)}
                className="flex items-center gap-2 px-3 py-1.5 bg-stone-900 border border-sky-800/50 hover:border-sky-500 text-stone-300 hover:text-sky-300 text-xs font-bold transition-colors"
                title={`${s.name} · ${s.groupLabel}`}>
                <Plus className="w-3 h-3" />
                {s.ticker}
                <span className="text-[10px] text-stone-500">{s.name.split(' ').slice(0, 2).join(' ')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {globalError && (
        <div className="mb-6 border-2 border-rose-800/60 bg-rose-950/30 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="text-sm text-rose-200">{globalError}</div>
        </div>
      )}

      {mixedIndustries && (
        <div className="mb-6 border-2 border-amber-700/40 bg-amber-950/20 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-100/90 leading-relaxed">
            <span className="font-bold text-amber-300">Comparing across industries.</span>{' '}
            You've added companies from different industry groups. Metrics may not be directly
            comparable — bank "revenue" is interest + fee income, while retail "revenue" is net sales.
            Consider using the <span className="font-bold">Ratios</span> view below for more
            apples-to-apples comparisons like ROE and net margin.
          </div>
        </div>
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <SnapshotTable data={snapshotData} companies={companies} />
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <LayoutGrid className="w-4 h-4 text-stone-400" />
            <span className="text-[10px] uppercase tracking-[0.25em] text-stone-400 font-bold">View Mode</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {NORMALIZATION_MODES.map((mode) => (
              <button key={mode.id} onClick={() => setNormalization(mode.id)}
                className={`px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 transition-colors ${
                  normalization === mode.id
                    ? 'bg-stone-100 text-stone-950 border-stone-100'
                    : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700 hover:text-stone-200'
                }`}
                title={mode.desc}>
                {mode.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-stone-600">
            {NORMALIZATION_MODES.find((m) => m.id === normalization)?.desc}
          </p>
        </div>
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <>
          <SectionTitle icon={TrendingUp} title="Financials" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            {ABSOLUTE_METRICS.map((m) => (
              <ComparisonChart key={m.key} title={m.label}
                series={normalizeSeries(buildSeriesForMetric(m.key, m.format), normalization, m.key)}
                format={effectiveFormat(m.format)} height={280}
              />
            ))}
          </div>
        </>
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <>
          <SectionTitle icon={Percent} title="Ratios & Margins" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            {RATIO_METRICS.map((m) => (
              <ComparisonChart key={m.key} title={m.label} series={buildRatioSeries(m)} format="percent" height={260} />
            ))}
          </div>
        </>
      )}

      {allLoaded && companies.filter((c) => c.facts).length > 0 && (
        <>
          <SectionTitle icon={BarChart3} title="Growth Rates (CAGR)" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            <GrowthBarChart title="5-Year CAGR" rows={buildGrowthBarRows('5y')} companies={companies} />
            <GrowthBarChart title="10-Year CAGR" rows={buildGrowthBarRows('10y')} companies={companies} />
          </div>
        </>
      )}

      {companies.length === 0 && (
        <div className="border-2 border-dashed border-stone-800 p-12 text-center">
          <GitCompare className="w-12 h-12 text-stone-700 mx-auto mb-4" />
          <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">Add Companies To Compare</p>
          <p className="text-stone-600 text-xs max-w-md mx-auto">
            Click a peer group above, or type a ticker. You'll see financial charts, ratios, growth
            rates, and a head-to-head snapshot table.
          </p>
        </div>
      )}

      {companies.length > 0 && allLoaded && (
        <p className="mt-6 text-[11px] text-stone-500 leading-relaxed">
          Source: SEC XBRL Company Facts. Values are as originally reported in 10-K filings.
          Gaps in lines indicate missing data. Ratios are computed from reported values and may
          differ slightly from company-published non-GAAP versions. Click any snapshot value
          to open the source filing on SEC.gov.
        </p>
      )}
    </>
  );
}

function SectionTitle({ icon: Icon, title }) {
  return (
    <div className="flex items-center gap-2 mb-4 pb-2 border-b-2 border-stone-800">
      <Icon className="w-5 h-5 text-amber-400" />
      <h3 className="text-sm uppercase tracking-[0.25em] font-black text-stone-200">{title}</h3>
    </div>
  );
}

function SnapshotTable({ data, companies }) {
  const loadedCompanies = companies.filter((c) => c.facts && !c.error);
  return (
    <div className="mb-8">
      <SectionTitle icon={Trophy} title="Head-to-Head Snapshot" />
      <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-900 border-b-2 border-stone-800">
            <tr>
              <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.25em] text-stone-400 sticky left-0 bg-stone-900 min-w-[180px]">Metric</th>
              {loadedCompanies.map((c) => (
                <th key={c.ticker} className="text-right px-4 py-3 text-[10px] uppercase tracking-[0.2em] font-black min-w-[120px]" style={{ color: c.color }}>
                  {c.ticker}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const numericValues = row.values
                .map((v, i) => ({ idx: i, value: v.value }))
                .filter((v) => v.value != null && Number.isFinite(v.value));
              let bestIdx = -1, worstIdx = -1;
              if (numericValues.length > 1 && row.higherIsBetter !== null) {
                const sorted = [...numericValues].sort((a, b) => b.value - a.value);
                bestIdx = row.higherIsBetter ? sorted[0].idx : sorted[sorted.length - 1].idx;
                worstIdx = row.higherIsBetter ? sorted[sorted.length - 1].idx : sorted[0].idx;
              }
              return (
                <tr key={row.metric} className="border-b border-stone-800/60 hover:bg-amber-500/5">
                  <td className="px-4 py-2.5 text-stone-300 font-bold sticky left-0 bg-stone-950/95" title={row.tooltip}>
                    {row.metric}
                    {row.isComputed && <span className="ml-1.5 text-[9px] text-stone-600 font-normal italic tracking-normal">(computed)</span>}
                  </td>
                  {row.values.map((v, i) => (
                    <SnapshotCell key={i} value={v} row={row} isBest={i === bestIdx} isWorst={i === worstIdx} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-stone-600 leading-relaxed">
        Most recent fiscal year for each company. <span className="text-emerald-400">Green</span> = best,{' '}
        <span className="text-rose-400">Red</span> = worst where applicable. Total Assets is neutral
        (bigger isn't always better). Hover any value for the source XBRL tag; click to open SEC's
        concept endpoint. Computed ratios link to their numerator (e.g. ROE links to Net Income).
      </p>
    </div>
  );
}

function SnapshotCell({ value, row, isBest, isWorst }) {
  const formatted = formatSnapshotValue(value.value, row.format);
  const textClass = isBest ? 'text-emerald-400 font-black'
    : isWorst ? 'text-rose-400'
    : value.value == null ? 'text-stone-700' : 'text-stone-300';

  let tooltip;
  if (value.source) {
    if (row.isComputed) {
      tooltip = `Formula: ${value.formulaLabel || row.tooltip}\nNumerator tag: ${value.source.tag}\nPeriod: ${value.source.end}\nFiled: ${value.source.filed}\nAccession: ${value.source.accession}\nClick to open SEC source for numerator`;
    } else {
      tooltip = `Tag: ${value.source.tag}\nUnit: ${value.source.unit}\nPeriod: ${value.source.end}\nFiled: ${value.source.filed}\nAccession: ${value.source.accession}\nClick to open SEC source`;
    }
  } else if (row.tooltip) {
    tooltip = row.tooltip;
  } else {
    tooltip = value.value == null ? 'No data reported' : 'Computed value';
  }

  const sourceUrl = value.source && value.cik ? buildSourceUrl(value.cik, value.source) : null;
  if (!sourceUrl || value.value == null) {
    return <td className={`px-4 py-2.5 text-right tabular-nums ${textClass}`} title={tooltip}>{formatted}</td>;
  }
  return (
    <td className={`px-4 py-2.5 text-right tabular-nums group ${textClass}`} title={tooltip}>
      <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-amber-400 transition-colors">
        {formatted}
        <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />
      </a>
    </td>
  );
}

// ============================================================================
// Growth bar chart — ONE Bar series with per-Cell colors.
// The DOM inspection revealed Recharts renders bars as <path> elements and
// when multiple <Bar> components share the chart, the fill is broadcast from
// the first one. The fix: flatten to a single Bar with 20 data points (4 metrics
// × 5 companies), each with its own Cell fill. Colors are guaranteed unique
// because each Cell is a separate SVG element.
// ============================================================================

function GrowthBarChart({ title, rows, companies }) {
  const loadedCompanies = companies.filter((c) => c.facts && !c.error);

  // Find boundaries between metric groups for visual separation
  const metricGroups = [];
  let currentMetric = null;
  rows.forEach((row, i) => {
    if (row.metric !== currentMetric) {
      metricGroups.push({ startIdx: i, metric: row.metric });
      currentMetric = row.metric;
    }
  });

  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-4">
      <div className="flex items-center justify-between mb-3 px-2">
        <span className="text-xs uppercase tracking-[0.2em] text-amber-400 font-bold">{title}</span>
      </div>

      {/* Custom legend — all company colors shown as swatches */}
      <div className="flex flex-wrap gap-3 mb-3 px-2">
        {loadedCompanies.map((c) => (
          <div key={c.ticker} className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider">
            <span className="inline-block w-3 h-3" style={{ backgroundColor: c.color }} />
            <span style={{ color: c.color }}>{c.ticker}</span>
          </div>
        ))}
      </div>

      {/* Metric group labels above the bars */}
      <div className="grid gap-1 px-[45px] mb-1" style={{ gridTemplateColumns: `repeat(${metricGroups.length}, 1fr)` }}>
        {metricGroups.map((g) => (
          <div key={g.metric} className="text-center text-[10px] text-stone-500 uppercase tracking-wider truncate">
            {g.metric}
          </div>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#44403c" vertical={false} />
          <XAxis
            dataKey="ticker"
            stroke="#78716c"
            tick={{ fontSize: 9, fill: '#a8a29e', fontFamily: 'ui-monospace, monospace' }}
            interval={0}
          />
          <YAxis
            stroke="#78716c"
            tick={{ fontSize: 10, fill: '#a8a29e', fontFamily: 'ui-monospace, monospace' }}
            tickFormatter={(v) => `${v.toFixed(0)}%`}
            width={45}
          />
          <ReferenceLine y={0} stroke="#57534e" />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1c1917',
              border: '2px solid #44403c',
              fontFamily: 'ui-monospace, monospace',
              fontSize: '12px',
              color: '#f5f5f4',
            }}
            formatter={(value, _name, item) => {
              const label = item?.payload?.label || item?.payload?.ticker;
              if (value == null) return ['—', label];
              return [`${Number(value).toFixed(1)}%`, label];
            }}
            cursor={{ fill: '#f59e0b10' }}
          />
          {/* Single Bar, 20 data points, each Cell colored per-row */}
          <Bar dataKey="value" isAnimationActive={false}>
            {rows.map((row, i) => (
              <Cell key={`cell-${i}`} fill={row.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatSnapshotValue(value, format) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (format === 'percent') return `${value.toFixed(1)}%`;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
