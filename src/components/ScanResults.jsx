import React, { useState, useMemo } from 'react';
import {
  ExternalLink, FileText, ChevronDown, ChevronRight, Calendar, Hash,
  TrendingUp, Clock, Tag, Bitcoin, AlertCircle, Zap, Database,
  GitCompare, BarChart3, Search,
} from 'lucide-react';
import { CATEGORIES } from '../utils/cryptoKeywords.js';

export default function ScanResults({ data, onRescan }) {
  if (!data) return null;

  const results = data.results || [];
  const errors = data.errors || [];

  if (results.length === 0 && errors.length === 0) {
    return null;
  }

  const isCompareMode = results.length > 1;

  return (
    <div className="mb-8">
      {/* Meta bar */}
      <div className="flex flex-wrap items-center gap-3 mb-4 text-[10px] uppercase tracking-widest text-stone-500">
        <span className="flex items-center gap-1.5">
          <Database className="w-3 h-3" />
          Cache: {data.cacheBackend === 'upstash' ? 'Redis (24hr)' : 'Memory (session)'}
        </span>
        <span>·</span>
        <span>Scanned: {new Date(data.scannedAt).toLocaleString()}</span>
        {data.depth && (
          <>
            <span>·</span>
            <span>Depth: {data.depth} filings per ticker</span>
          </>
        )}
      </div>

      {/* Errors */}
      {errors.length > 0 && (
        <div className="mb-4 space-y-2">
          {errors.map((e, i) => (
            <div key={i} className="border-2 border-rose-800/60 bg-rose-950/30 p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="text-xs">
                <span className="text-rose-200 font-bold">{e.ticker}</span>
                <span className="text-rose-300"> — {e.error}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Compare summary table */}
      {isCompareMode && <CompareSummaryTable results={results} />}

      {/* Per-ticker results */}
      {results.map((result, i) => (
        <TickerResult key={result.ticker} result={result} onRescan={onRescan} expanded={!isCompareMode || i === 0} />
      ))}
    </div>
  );
}

// ============================================================================
// Compare summary table — side-by-side stats for multiple tickers
// ============================================================================

function CompareSummaryTable({ results }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3 pb-2 border-b-2 border-stone-800">
        <GitCompare className="w-5 h-5 text-amber-400" />
        <h3 className="text-sm uppercase tracking-[0.25em] font-black text-stone-200">
          Head-to-Head Summary
        </h3>
      </div>

      <div className="border-2 border-stone-800 bg-stone-900/30 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-900 border-b-2 border-stone-800">
            <tr>
              <th className="text-left px-4 py-3 text-[10px] uppercase tracking-[0.25em] text-stone-400 sticky left-0 bg-stone-900 min-w-[160px]">
                Metric
              </th>
              {results.map((r) => (
                <th
                  key={r.ticker}
                  className="text-right px-4 py-3 text-[10px] uppercase tracking-[0.2em] text-amber-400 font-black min-w-[120px]"
                >
                  {r.ticker}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <CompareRow
              label="Company"
              values={results.map((r) => r.companyName || '—')}
              format="text"
            />
            <CompareRow
              label="Filings Scanned"
              values={results.map((r) => r.totalFilingsScanned)}
              format="number"
              higherIsBetter={null}
            />
            <CompareRow
              label="Filings With Matches"
              values={results.map((r) => r.filingsWithMatches)}
              format="number"
              higherIsBetter={true}
            />
            <CompareRow
              label="Total Crypto Mentions"
              values={results.map((r) => r.totalMatches)}
              format="number"
              higherIsBetter={true}
            />
            <CompareRow
              label="First Mention"
              values={results.map((r) => r.firstMention || '—')}
              format="date-first"
            />
            <CompareRow
              label="Most Recent Mention"
              values={results.map((r) => r.mostRecentMention || '—')}
              format="date-recent"
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompareRow({ label, values, format, higherIsBetter }) {
  // Compute best/worst for number rows
  let bestIdx = -1, worstIdx = -1;
  if (format === 'number' && higherIsBetter !== null) {
    const numeric = values.map((v, i) => ({ i, v: typeof v === 'number' ? v : -Infinity }));
    const sorted = [...numeric].sort((a, b) => b.v - a.v);
    if (sorted[0].v !== sorted[sorted.length - 1].v) {
      bestIdx = higherIsBetter ? sorted[0].i : sorted[sorted.length - 1].i;
      worstIdx = higherIsBetter ? sorted[sorted.length - 1].i : sorted[0].i;
    }
  }

  return (
    <tr className="border-b border-stone-800/60 hover:bg-amber-500/5">
      <td className="px-4 py-2.5 text-stone-300 font-bold sticky left-0 bg-stone-950/95 text-xs">
        {label}
      </td>
      {values.map((v, i) => {
        const cls = i === bestIdx ? 'text-emerald-400 font-black'
          : i === worstIdx ? 'text-rose-400'
          : 'text-stone-300';
        const display = format === 'text' ? v
          : format === 'number' ? (v != null ? v.toLocaleString() : '—')
          : format === 'date-first' || format === 'date-recent' ? v
          : v;
        return (
          <td key={i} className={`px-4 py-2.5 text-right tabular-nums ${cls} ${format === 'text' ? 'text-xs truncate max-w-[200px]' : ''}`}>
            {display}
          </td>
        );
      })}
    </tr>
  );
}

// ============================================================================
// Per-ticker detailed result card
// ============================================================================

function TickerResult({ result, onRescan, expanded: initialExpanded = true }) {
  const [expanded, setExpanded] = useState(initialExpanded);

  const hasMatches = result.totalMatches > 0;
  const matchingFilings = useMemo(
    () => (result.matches || []).filter((m) => m.matchCount > 0),
    [result.matches]
  );

  return (
    <div className="mb-6 border-2 border-stone-800">
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between px-5 py-4 bg-stone-900 hover:bg-stone-800/80 transition-colors text-left"
      >
        <div className="flex items-center gap-4 min-w-0">
          {expanded ? (
            <ChevronDown className="w-5 h-5 text-amber-500 shrink-0" />
          ) : (
            <ChevronRight className="w-5 h-5 text-amber-500 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xl font-black tracking-wider text-stone-100">{result.ticker}</span>
              {result.fromCache && (
                <span className="text-[9px] uppercase tracking-widest px-1.5 py-0.5 bg-stone-800 text-stone-500 border border-stone-700">
                  Cached
                </span>
              )}
              {!result.fromCache && (
                <span className="text-[9px] uppercase tracking-widest px-1.5 py-0.5 bg-emerald-900/40 text-emerald-400 border border-emerald-800">
                  Fresh
                </span>
              )}
            </div>
            <div className="text-xs text-stone-400 truncate">{result.companyName || 'Unknown company'}</div>
          </div>
        </div>

        <div className="flex items-center gap-4 text-right shrink-0 ml-4">
          <Stat label="Mentions" value={result.totalMatches} color={hasMatches ? 'amber' : 'stone'} />
          <Stat label="Filings" value={`${result.filingsWithMatches} / ${result.totalFilingsScanned}`} />
        </div>
      </button>

      {/* Body */}
      {expanded && (
        <div className="border-t-2 border-stone-800 bg-stone-950/50">
          {/* No matches */}
          {!hasMatches && !result.error && (
            <div className="p-6 text-center">
              <Search className="w-10 h-10 text-stone-700 mx-auto mb-3" />
              <p className="text-sm text-stone-400 mb-1">No crypto mentions found</p>
              <p className="text-xs text-stone-600">
                Scanned {result.totalFilingsScanned} recent filings ({result.note || 'no matches'}). 
                {onRescan && (
                  <>
                    {' '}
                    <button
                      onClick={() => onRescan(result.ticker, { fresh: true })}
                      className="text-amber-400 hover:text-amber-300 underline"
                    >
                      Force fresh scan
                    </button>
                  </>
                )}
              </p>
            </div>
          )}

          {/* Error */}
          {result.error && (
            <div className="p-4 flex items-start gap-3 bg-rose-950/20">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="text-xs text-rose-200">{result.error}</div>
            </div>
          )}

          {/* Summary stats */}
          {hasMatches && (
            <>
              <SummaryBar result={result} />
              <FilingsList filings={matchingFilings} cik={result.cik} />
              <RescanFooter ticker={result.ticker} onRescan={onRescan} result={result} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color = 'stone' }) {
  const colors = {
    amber: 'text-amber-400',
    stone: 'text-stone-300',
  };
  return (
    <div className="text-right">
      <div className={`text-lg font-black tabular-nums ${colors[color]}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-widest text-stone-500">{label}</div>
    </div>
  );
}

function SummaryBar({ result }) {
  return (
    <div className="p-4 border-b border-stone-800 grid grid-cols-1 md:grid-cols-3 gap-4">
      <SummaryCard
        icon={TrendingUp}
        label="Most Recent Mention"
        value={result.mostRecentMention || '—'}
      />
      <SummaryCard
        icon={Clock}
        label="First Mention"
        value={result.firstMention || '—'}
      />
      <SummaryCard
        icon={Tag}
        label="Categories Found"
        value={result.categoriesFound?.length || 0}
        sub={
          result.categoriesFound && result.categoriesFound.length > 0 ? (
            <div className="flex flex-wrap gap-1 mt-1">
              {result.categoriesFound.map((c) => {
                const cat = CATEGORIES[c];
                if (!cat) return null;
                return (
                  <span key={c} className="text-[9px] uppercase tracking-widest px-1.5 py-0.5 bg-stone-800 text-stone-300 border border-stone-700">
                    {cat.label}
                  </span>
                );
              })}
            </div>
          ) : null
        }
      />

      {result.keywordsFound && result.keywordsFound.length > 0 && (
        <div className="md:col-span-3">
          <div className="flex items-center gap-2 mb-2">
            <Bitcoin className="w-3 h-3 text-amber-500" />
            <span className="text-[10px] uppercase tracking-[0.2em] text-stone-400 font-bold">
              Keywords Found ({result.keywordsFound.length})
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {result.keywordsFound.map((kw) => (
              <span
                key={kw}
                className="text-[10px] px-2 py-0.5 bg-amber-950/40 border border-amber-800/60 text-amber-200"
              >
                {kw}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, sub }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="w-3.5 h-3.5 text-amber-500" />
        <span className="text-[9px] uppercase tracking-widest text-stone-500 font-bold">{label}</span>
      </div>
      <div className="text-sm text-stone-200 font-bold">{value}</div>
      {sub}
    </div>
  );
}

function FilingsList({ filings, cik }) {
  return (
    <div className="divide-y divide-stone-800/60">
      {filings.map((f) => (
        <FilingCard key={f.accession} filing={f} cik={cik} />
      ))}
    </div>
  );
}

function FilingCard({ filing, cik }) {
  const [expanded, setExpanded] = useState(false);
  const formColor = getFormColor(filing.form);

  return (
    <div>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-start gap-4 p-4 hover:bg-amber-500/5 transition-colors text-left group"
      >
        <div className="flex items-center shrink-0">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-stone-500 group-hover:text-amber-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-stone-500 group-hover:text-amber-400" />
          )}
        </div>

        <div
          className={`shrink-0 px-2.5 py-1 text-[11px] font-black border tracking-wider ${formColor} min-w-[80px] text-center`}
        >
          {filing.form}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-xs font-bold text-stone-200 truncate">
              {filing.primaryDescription || filing.primaryDoc || 'Filing Document'}
            </span>
            <span className="text-[10px] text-amber-400 font-black tabular-nums">
              {filing.matchCount} {filing.matchCount === 1 ? 'match' : 'matches'}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-stone-500 uppercase tracking-wider flex-wrap">
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              Filed {filing.filingDate}
            </span>
            {filing.reportDate && <span>Period {filing.reportDate}</span>}
            <span className="flex items-center gap-1 truncate font-mono normal-case">
              <Hash className="w-3 h-3" />
              {filing.accession}
            </span>
          </div>
          {filing.keywordsFound && filing.keywordsFound.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {filing.keywordsFound.slice(0, 5).map((kw) => (
                <span
                  key={kw}
                  className="text-[9px] px-1.5 py-0.5 bg-stone-800 text-stone-400 border border-stone-700"
                >
                  {kw}
                </span>
              ))}
              {filing.keywordsFound.length > 5 && (
                <span className="text-[9px] px-1.5 py-0.5 text-stone-500">
                  +{filing.keywordsFound.length - 5} more
                </span>
              )}
            </div>
          )}
        </div>

        <a
          href={filing.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-stone-500 hover:text-amber-400 transition-colors"
          title="View on SEC.gov"
        >
          <ExternalLink className="w-4 h-4" />
        </a>
      </button>

      {/* Excerpts */}
      {expanded && filing.excerpts && filing.excerpts.length > 0 && (
        <div className="pb-4 pl-12 pr-4 bg-stone-950/50 space-y-3">
          <div className="text-[9px] uppercase tracking-[0.2em] text-stone-500 font-bold">
            Example Excerpts ({filing.excerpts.length} shown)
          </div>
          {filing.excerpts.map((ex, i) => (
            <Excerpt key={i} excerpt={ex} />
          ))}
        </div>
      )}
    </div>
  );
}

function Excerpt({ excerpt }) {
  const catInfo = CATEGORIES[excerpt.category];
  const catColor = catInfo ? catInfo.color : 'stone';

  return (
    <div className="border-l-2 border-amber-700/40 pl-3 py-1">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[9px] uppercase tracking-widest px-1.5 py-0.5 bg-${catColor}-950/40 border border-${catColor}-800/60 text-${catColor}-300`}>
          {catInfo?.label || excerpt.category}
        </span>
        <span className="text-[9px] text-stone-500 uppercase tracking-widest">
          keyword: <span className="text-amber-400 font-bold normal-case">{excerpt.keyword}</span>
        </span>
      </div>
      <p className="text-xs text-stone-300 leading-relaxed">
        <span className="text-stone-500">{excerpt.before}</span>
        <span className="bg-amber-500/20 text-amber-200 font-bold px-0.5">{excerpt.match}</span>
        <span className="text-stone-500">{excerpt.after ? ' ' + excerpt.after : ''}</span>
      </p>
    </div>
  );
}

function RescanFooter({ ticker, onRescan, result }) {
  if (!onRescan) return null;
  return (
    <div className="p-3 border-t border-stone-800 bg-stone-950/40 flex items-center justify-between">
      <div className="text-[10px] text-stone-500 uppercase tracking-widest">
        {result.fromCache
          ? `Cached result from ${result.cachedAt ? new Date(result.cachedAt).toLocaleString() : 'earlier'}`
          : `Fresh scan · ${result.scanDurationMs ? `${(result.scanDurationMs / 1000).toFixed(1)}s` : ''}`}
      </div>
      <button
        onClick={() => onRescan(ticker, { fresh: true })}
        className="flex items-center gap-1.5 text-[10px] text-stone-400 hover:text-amber-400 uppercase tracking-widest font-bold transition-colors"
      >
        <Zap className="w-3 h-3" />
        Scan fresh
      </button>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function getFormColor(form) {
  if (!form) return 'bg-stone-800/60 text-stone-300 border-stone-600/50';
  if (form.startsWith('10-K')) return 'bg-amber-900/40 text-amber-200 border-amber-700/50';
  if (form.startsWith('10-Q')) return 'bg-emerald-900/40 text-emerald-200 border-emerald-700/50';
  if (form.startsWith('8-K')) return 'bg-rose-900/40 text-rose-200 border-rose-700/50';
  if (form.startsWith('S-')) return 'bg-sky-900/40 text-sky-200 border-sky-700/50';
  if (form.startsWith('DEF')) return 'bg-violet-900/40 text-violet-200 border-violet-700/50';
  if (form.startsWith('N-')) return 'bg-teal-900/40 text-teal-200 border-teal-700/50';
  return 'bg-stone-800/60 text-stone-300 border-stone-600/50';
}
