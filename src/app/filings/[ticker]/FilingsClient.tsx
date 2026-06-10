'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText, ExternalLink, Calendar, Hash, Filter, ChevronDown, ChevronRight,
  Link as LinkIcon, AlertCircle, BarChart3, X,
} from 'lucide-react';
import { getItemsInfo } from '../../../utils/formItems.js';
import { describeForm, deriveSignals } from '../../../utils/formIntel.js';
import AISummaryImpl from '../../../components/AISummary.jsx';

/* eslint-disable @typescript-eslint/no-explicit-any */
const AISummary = AISummaryImpl as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ============================================================================
// Types — exported so the server page can import them
// ============================================================================
export interface FilingEntry {
  accession: string;
  form: string;
  filingDate: string;
  reportDate: string;
  year: number;
  quarter: string;
  primaryDoc: string;
  primaryDescription: string;
  size?: number;
  items?: string;
  documentUrl: string;
}

export interface CompanyInfo {
  name: string;
  cik: string;
  sic?: string;
  exchanges: string;
  tickers: string;
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  ein?: string;
}

interface FilingsClientProps {
  ticker: string;
  company: CompanyInfo | null;
  filings: FilingEntry[];
  errorMessage: string | null;
}

// ============================================================================
// Form-type color mapping — same palette as the old code, reused by both the
// filter chips and the filing cards so users see visual continuity
// ============================================================================
function formColor(form: string): string {
  if (form.startsWith('10-K'))
    return 'bg-amber-900/40 text-amber-200 border-amber-700/50';
  if (form.startsWith('10-Q'))
    return 'bg-emerald-900/40 text-emerald-200 border-emerald-700/50';
  if (form.startsWith('8-K'))
    return 'bg-rose-900/40 text-rose-200 border-rose-700/50';
  if (form.includes('DEF 14A') || form.includes('PRE 14A'))
    return 'bg-violet-900/40 text-violet-200 border-violet-700/50';
  if (form.startsWith('S-'))
    return 'bg-sky-900/40 text-sky-200 border-sky-700/50';
  if (form.startsWith('4') || form.startsWith('3') || form.startsWith('5'))
    return 'bg-teal-900/40 text-teal-200 border-teal-700/50';
  if (form.startsWith('SC 13'))
    return 'bg-fuchsia-900/40 text-fuchsia-200 border-fuchsia-700/50';
  return 'bg-stone-800/60 text-stone-300 border-stone-600/50';
}

// Version of formColor used for unselected filter chips — muted palette so
// the selected chip (which uses full formColor) reads as "on"
function chipIdleColor(): string {
  return 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-600 hover:text-stone-200';
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ============================================================================
// Main client component
// ============================================================================
export default function FilingsClient({
  ticker,
  company,
  filings,
  errorMessage,
}: FilingsClientProps) {
  const router = useRouter();

  // NEW: multi-select form-type filter. Empty set = "show all" (matches old
  // "ALL" behavior). Each click on a chip toggles it in/out of the set.
  const [selectedForms, setSelectedForms] = useState<Set<string>>(new Set());

  const [expandedYears, setExpandedYears] = useState<Record<number, boolean>>(() => {
    // Default: expand the top (most recent) year so the user sees filings
    // immediately without having to click
    if (filings.length === 0) return {};
    const topYear = Math.max(...filings.map((f) => f.year));
    return { [topYear]: true };
  });
  const [expandedQuarters, setExpandedQuarters] = useState<Record<string, boolean>>({});

  // ==========================================================================
  // Derived state
  // ==========================================================================
  const formTypes = useMemo(() => {
    const counts = new Map<string, number>();
    filings.forEach((f) => counts.set(f.form, (counts.get(f.form) || 0) + 1));
    // Sort by count desc, then by form name asc
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([form, count]) => ({ form, count }));
  }, [filings]);

  const filteredFilings = useMemo(() => {
    if (selectedForms.size === 0) return filings;
    return filings.filter((f) => selectedForms.has(f.form));
  }, [filings, selectedForms]);

  const grouped = useMemo(() => {
    const byYear: Record<number, Record<string, FilingEntry[]>> = {};
    filteredFilings.forEach((f) => {
      if (!byYear[f.year]) byYear[f.year] = {};
      if (!byYear[f.year][f.quarter]) byYear[f.year][f.quarter] = [];
      byYear[f.year][f.quarter].push(f);
    });
    return byYear;
  }, [filteredFilings]);

  const sortedYears = useMemo(
    () => Object.keys(grouped).map(Number).sort((a, b) => b - a),
    [grouped]
  );

  // ==========================================================================
  // Handlers
  // ==========================================================================
  const toggleForm = (form: string) => {
    setSelectedForms((prev) => {
      const next = new Set(prev);
      if (next.has(form)) next.delete(form);
      else next.add(form);
      return next;
    });
  };

  const clearAllFilters = () => setSelectedForms(new Set());

  const toggleYear = (y: number) =>
    setExpandedYears((p) => ({ ...p, [y]: !p[y] }));

  const toggleQuarter = (k: string) =>
    setExpandedQuarters((p) => ({ ...p, [k]: !p[k] }));

  const copyShareLink = () => {
    const url = `${window.location.origin}/filings/${ticker}`;
    navigator.clipboard.writeText(url);
  };

  const goToAnalysis = () => {
    router.push(`/analysis/${ticker}`);
  };

  // ==========================================================================
  // Render
  // ==========================================================================

  // Error state
  if (errorMessage) {
    return (
      <div className="bg-rose-950/30 border-2 border-rose-900/60 px-4 py-3 mb-4 flex items-center gap-2">
        <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
        <span className="text-sm text-rose-200">{errorMessage}</span>
      </div>
    );
  }

  // Empty state (server found no filings)
  if (filings.length === 0) {
    return (
      <div className="border-2 border-dashed border-stone-800 p-12 text-center">
        <FileText className="w-12 h-12 text-stone-700 mx-auto mb-4" />
        <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">
          No filings found for {ticker}
        </p>
        <p className="text-stone-600 text-xs max-w-md mx-auto">
          This company is registered with the SEC but has no recent filings.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Company header */}
      {company && (
        <div className="mb-6">
          <div className="flex items-baseline gap-3 mb-1 flex-wrap">
            <span className="text-2xl font-black tracking-wider text-stone-100">
              {ticker}
            </span>
            <span className="text-lg text-stone-300 font-bold">{company.name}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-widest text-stone-500">
            <span>CIK: {company.cik}</span>
            {company.sic && <span>SIC: {company.sic}</span>}
            {company.exchanges !== 'N/A' && <span>Exchange: {company.exchanges}</span>}
            {company.fiscalYearEnd && <span>FY End: {company.fiscalYearEnd}</span>}
          </div>
        </div>
      )}

      {/* Multi-select filter row */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 mr-2">
          <Filter className="w-4 h-4 text-stone-400" />
          <span className="text-[10px] uppercase tracking-[0.25em] text-stone-400">
            Form Type
          </span>
        </div>

        {formTypes.map(({ form, count }) => {
          const isSelected = selectedForms.has(form);
          return (
            <button
              key={form}
              onClick={() => toggleForm(form)}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider border transition-colors ${
                isSelected ? formColor(form) : chipIdleColor()
              }`}
              type="button"
            >
              <span>{form}</span>
              <span className="text-[9px] opacity-70">{count}</span>
            </button>
          );
        })}

        {selectedForms.size > 0 && (
          <button
            onClick={clearAllFilters}
            className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider text-stone-500 hover:text-amber-400 transition-colors"
            type="button"
          >
            <X className="w-3 h-3" />
            Clear
          </button>
        )}
      </div>

      {/* Count + action buttons */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="text-xs text-stone-500">
          Showing {filteredFilings.length} of {filings.length}
          {selectedForms.size > 0 && (
            <span className="ml-2 text-amber-400">
              · Filtering: {Array.from(selectedForms).join(', ')}
            </span>
          )}
        </div>
        <div className="ml-auto flex gap-1">
          <button
            onClick={copyShareLink}
            className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors"
            title="Copy shareable link"
            type="button"
          >
            <LinkIcon className="w-3.5 h-3.5" />
            Share
          </button>
          <button
            onClick={goToAnalysis}
            className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-widest font-bold border-2 border-stone-800 text-stone-400 hover:border-amber-500 hover:text-amber-400 transition-colors"
            title="View financial analysis"
            type="button"
          >
            <BarChart3 className="w-3.5 h-3.5" />
            View Financials
          </button>
        </div>
      </div>

      {/* Empty-filtered state */}
      {sortedYears.length === 0 && (
        <div className="border-2 border-dashed border-stone-800 p-10 text-center">
          <Filter className="w-10 h-10 text-stone-700 mx-auto mb-3" />
          <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">
            No filings match the selected filters
          </p>
          <p className="text-stone-600 text-xs max-w-md mx-auto">
            Try removing a form type or click Clear to see everything.
          </p>
        </div>
      )}

      {/* Filings tree */}
      {sortedYears.length > 0 && (
        <div className="space-y-3">
          {sortedYears.map((year) => {
            const quarters = grouped[year];
            const yearCount = Object.values(quarters).reduce(
              (s, arr) => s + arr.length,
              0
            );
            const isOpen = expandedYears[year];
            return (
              <div key={year} className="border-2 border-stone-800">
                <button
                  onClick={() => toggleYear(year)}
                  className="w-full flex items-center justify-between px-5 py-4 bg-stone-900 hover:bg-stone-800/80 transition-colors"
                  type="button"
                >
                  <div className="flex items-center gap-3">
                    {isOpen ? (
                      <ChevronDown className="w-5 h-5 text-amber-500" />
                    ) : (
                      <ChevronRight className="w-5 h-5 text-amber-500" />
                    )}
                    <Calendar className="w-4 h-4 text-stone-400" />
                    <span className="text-2xl font-black tracking-wider">{year}</span>
                  </div>
                  <span className="text-xs uppercase tracking-widest text-stone-400">
                    {yearCount} {yearCount === 1 ? 'filing' : 'filings'}
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t-2 border-stone-800">
                    {(['Q1', 'Q2', 'Q3', 'Q4'] as const)
                      .filter((q) => quarters[q])
                      .map((q) => {
                        const qKey = `${year}-${q}`;
                        const qOpen = expandedQuarters[qKey] ?? true;
                        const qFilings = [...quarters[q]].sort(
                          (a, b) =>
                            new Date(b.filingDate).getTime() -
                            new Date(a.filingDate).getTime()
                        );
                        return (
                          <div
                            key={q}
                            className="border-b border-stone-800 last:border-b-0"
                          >
                            <button
                              onClick={() => toggleQuarter(qKey)}
                              className="w-full flex items-center justify-between px-5 py-2.5 bg-stone-950 hover:bg-stone-900/60 transition-colors"
                              type="button"
                            >
                              <div className="flex items-center gap-3">
                                {qOpen ? (
                                  <ChevronDown className="w-4 h-4 text-stone-500" />
                                ) : (
                                  <ChevronRight className="w-4 h-4 text-stone-500" />
                                )}
                                <span className="text-sm font-bold text-amber-500">
                                  {q}
                                </span>
                                <span className="text-xs text-stone-500">
                                  {q === 'Q1'
                                    ? 'Jan–Mar'
                                    : q === 'Q2'
                                    ? 'Apr–Jun'
                                    : q === 'Q3'
                                    ? 'Jul–Sep'
                                    : 'Oct–Dec'}
                                </span>
                              </div>
                              <span className="text-xs text-stone-500">
                                {qFilings.length}
                              </span>
                            </button>

                            {qOpen && (
                              <div className="divide-y divide-stone-800/60">
                                {qFilings.map((f) => {
                                  const items =
                                    f.form === '8-K' ? getItemsInfo(f.items || '') : [];
                                  const intel = describeForm(f.form);
                                  const signals = deriveSignals(
                                    f.form,
                                    items.map((it) => it.code)
                                  );
                                  const signalCodes = new Set(
                                    signals.map((s) => s.key.replace('item-', ''))
                                  );
                                  const plainItems = items.filter(
                                    (it) => !signalCodes.has(it.code)
                                  );
                                  return (
                                    <div
                                      key={f.accession}
                                      className="flex items-start gap-4 px-5 py-3.5 hover:bg-amber-500/5 transition-colors group"
                                    >
                                      <div
                                        className={`shrink-0 px-2.5 py-1 text-[11px] font-black border tracking-wider ${formColor(
                                          f.form
                                        )} min-w-[80px] text-center`}
                                        title={intel.desc}
                                      >
                                        {f.form}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <a
                                          href={f.documentUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="flex items-center gap-2 mb-0.5"
                                        >
                                          <span className="text-sm font-bold text-stone-100 truncate group-hover:text-amber-300 transition-colors">
                                            {f.primaryDescription ||
                                              f.primaryDoc ||
                                              'Filing Document'}
                                          </span>
                                          <ExternalLink className="w-3.5 h-3.5 text-stone-500 group-hover:text-amber-500 transition-colors shrink-0" />
                                        </a>
                                        <div className="text-[11px] text-stone-500 mb-1 truncate">
                                          <span className="text-stone-400 font-semibold">{intel.label}</span>
                                          {' — '}
                                          {intel.desc}
                                        </div>
                                        <div className="flex items-center gap-4 text-[11px] text-stone-500 uppercase tracking-wider">
                                          <span className="flex items-center gap-1">
                                            <Calendar className="w-3 h-3" />
                                            Filed {f.filingDate}
                                          </span>
                                          {f.reportDate && (
                                            <span>Period {f.reportDate}</span>
                                          )}
                                          {f.size && <span>{formatSize(f.size)}</span>}
                                          <span className="flex items-center gap-1 truncate">
                                            <Hash className="w-3 h-3" />
                                            {f.accession}
                                          </span>
                                        </div>
                                        {(signals.length > 0 || plainItems.length > 0) && (
                                          <div className="flex flex-wrap gap-1 mt-1.5">
                                            {signals.map((s) => (
                                              <span
                                                key={s.key}
                                                className={`px-1.5 py-0.5 border text-[9px] font-bold uppercase tracking-wider ${
                                                  s.severity === 'alert'
                                                    ? 'bg-rose-950/60 border-rose-700/60 text-rose-200'
                                                    : 'bg-amber-950/40 border-amber-800/40 text-amber-200'
                                                }`}
                                              >
                                                {s.label}
                                              </span>
                                            ))}
                                            {plainItems.map(({ code, label }) => (
                                              <span
                                                key={code}
                                                className="px-1.5 py-0.5 bg-stone-900 border border-stone-700/60 text-stone-300 text-[9px] font-bold uppercase tracking-wider"
                                                title={`8-K Item ${code}`}
                                              >
                                                {code} · {label}
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                        <AISummary
                                          cik={company?.cik}
                                          accession={f.accession}
                                          primaryDoc={f.primaryDoc}
                                          ticker={ticker}
                                          form={f.form}
                                        />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
