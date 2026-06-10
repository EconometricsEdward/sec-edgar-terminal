'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileText, ExternalLink, Calendar, Hash, Filter, ChevronDown, ChevronRight,
  Link as LinkIcon, AlertCircle, BarChart3, X,
} from 'lucide-react';
import { getItemsInfo } from '../../../utils/formItems.js';

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

const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);
const QUARTERLY_FORMS = new Set(['10-Q', '10-Q/A', '6-K']);
const CURRENT_FORMS = new Set(['8-K', '8-K/A', '6-K']);
const PROXY_FORMS = new Set(['DEF 14A', 'DEF 14A/A', 'PRE 14A', 'PRE 14A/A']);
const INSIDER_FORMS = new Set(['3', '3/A', '4', '4/A', '5', '5/A']);

const HIGH_SIGNAL_8K_ITEMS = new Set([
  '1.03',
  '2.01',
  '2.02',
  '2.03',
  '2.05',
  '2.06',
  '3.01',
  '3.03',
  '4.01',
  '5.02',
  '5.03',
  '8.01',
]);

function filingDateTime(filing: FilingEntry): number {
  const time = new Date(filing.filingDate).getTime();
  return Number.isFinite(time) ? time : 0;
}

function findLatestFiling(
  filings: FilingEntry[],
  predicate: (filing: FilingEntry) => boolean
): FilingEntry | null {
  return [...filings]
    .filter(predicate)
    .sort((a, b) => filingDateTime(b) - filingDateTime(a))[0] || null;
}

function filingAgeDays(filing?: FilingEntry | null): number | null {
  if (!filing) return null;
  const time = filingDateTime(filing);
  if (!time) return null;
  return Math.max(0, Math.floor((Date.now() - time) / (24 * 60 * 60 * 1000)));
}

function formatAgeDays(days: number | null): string {
  if (days == null) return 'N/A';
  if (days === 0) return 'Today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function isProxyFiling(filing: FilingEntry): boolean {
  return PROXY_FORMS.has(filing.form) || filing.form.includes('DEF 14A') || filing.form.includes('PRE 14A');
}

function filingsSince(filings: FilingEntry[], days: number): FilingEntry[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return filings.filter((filing) => filingDateTime(filing) >= cutoff);
}

function submissionsFeedUrl(cik?: string) {
  return cik ? `https://data.sec.gov/submissions/CIK${cik}.json` : null;
}

function FilingPulsePanel({ filings, cik }: { filings: FilingEntry[]; cik?: string }) {
  const pulse = useMemo(() => {
    const latestAny = findLatestFiling(filings, () => true);
    const latestAnnual = findLatestFiling(filings, (filing) => ANNUAL_FORMS.has(filing.form));
    const latestQuarterly = findLatestFiling(filings, (filing) => QUARTERLY_FORMS.has(filing.form));
    const latestCurrent = findLatestFiling(filings, (filing) => CURRENT_FORMS.has(filing.form));
    const latestProxy = findLatestFiling(filings, isProxyFiling);
    const last90 = filingsSince(filings, 90);
    const last365 = filingsSince(filings, 365);

    const countFamily = (
      label: string,
      predicate: (filing: FilingEntry) => boolean
    ) => {
      const matches = last365.filter(predicate);
      return {
        label,
        count: matches.length,
        latest: findLatestFiling(matches, () => true),
      };
    };

    const eventSignals = last365
      .filter((filing) => filing.form.startsWith('8-K'))
      .map((filing) => {
        const items = getItemsInfo(filing.items || '');
        return { filing, items };
      })
      .filter(({ items }) => items.some((item) => HIGH_SIGNAL_8K_ITEMS.has(item.code)))
      .sort((a, b) => filingDateTime(b.filing) - filingDateTime(a.filing))
      .slice(0, 3);

    return {
      latestAny,
      latestAnnual,
      latestQuarterly,
      latestCurrent,
      latestProxy,
      last90Count: last90.length,
      last365Count: last365.length,
      familyMix: [
        countFamily('Annual', (filing) => ANNUAL_FORMS.has(filing.form)),
        countFamily('Quarterly', (filing) => QUARTERLY_FORMS.has(filing.form)),
        countFamily('Current Reports', (filing) => CURRENT_FORMS.has(filing.form)),
        countFamily('Proxy', isProxyFiling),
        countFamily('Insider', (filing) => INSIDER_FORMS.has(filing.form)),
      ],
      eventSignals,
    };
  }, [filings]);

  const feedUrl = submissionsFeedUrl(cik);
  const cards = [
    {
      key: 'latest',
      label: 'Latest Filing',
      filing: pulse.latestAny,
      fallback: 'No dated filing found',
    },
    {
      key: 'annual',
      label: 'Annual Report',
      filing: pulse.latestAnnual,
      fallback: 'No annual report in recent feed',
    },
    {
      key: 'quarterly',
      label: 'Quarterly Update',
      filing: pulse.latestQuarterly,
      fallback: 'No quarterly update in recent feed',
    },
    {
      key: 'current',
      label: 'Current Report',
      filing: pulse.latestCurrent,
      fallback: 'No current report in recent feed',
    },
    {
      key: 'proxy',
      label: 'Proxy Statement',
      filing: pulse.latestProxy,
      fallback: 'No proxy statement in recent feed',
    },
  ];

  return (
    <section className="mb-6 border-2 border-stone-800 bg-stone-950/60">
      <div className="border-b border-stone-800 px-4 py-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] font-black text-stone-400">
            <FileText className="w-4 h-4 text-amber-400" />
            Filing Pulse
          </div>
          <p className="mt-1 text-[11px] text-stone-500 max-w-2xl">
            Latest filing timestamps, trailing activity, and material 8-K item codes from SEC submissions.
          </p>
        </div>
        {feedUrl && (
          <a
            href={feedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-sky-300 hover:text-sky-200 transition-colors"
            title="Open SEC submissions feed"
          >
            SEC submissions feed
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-5">
        {cards.map((card) => (
          <FilingPulseCard
            key={card.key}
            label={card.label}
            filing={card.filing}
            fallback={card.fallback}
          />
        ))}
      </div>

      <div className="grid gap-0 border-t border-stone-800 lg:grid-cols-[1.05fr_1.4fr]">
        <div className="border-b border-stone-800 p-4 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-[0.2em] font-black text-stone-500">
              SEC Feed Activity
            </div>
            {feedUrl && (
              <a
                href={feedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] uppercase tracking-[0.14em] text-stone-500 hover:text-sky-300 transition-colors"
              >
                Source JSON
              </a>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FilingPulseMetric
              label="Last 90 Days"
              value={pulse.last90Count}
              detail="Recent SEC submissions"
              sourceUrl={feedUrl}
            />
            <FilingPulseMetric
              label="Last 12 Months"
              value={pulse.last365Count}
              detail="Trailing filing volume"
              sourceUrl={feedUrl}
            />
          </div>

          <div className="mt-4">
            <div className="mb-2 text-[10px] uppercase tracking-[0.2em] font-black text-stone-500">
              12-Month Filing Mix
            </div>
            <div className="grid grid-cols-2 gap-2">
              {pulse.familyMix.map((family) => (
                <FilingFamilyChip key={family.label} family={family} />
              ))}
            </div>
          </div>
        </div>

        <div className="p-4">
          <div className="mb-3 text-[10px] uppercase tracking-[0.2em] font-black text-stone-500">
            Recent High-Signal 8-K Items
          </div>
          {pulse.eventSignals.length > 0 ? (
            <div className="space-y-2">
              {pulse.eventSignals.map(({ filing, items }) => (
                <a
                  key={filing.accession}
                  href={filing.documentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block border border-stone-800 bg-stone-900/30 px-3 py-2.5 hover:border-rose-700/70 hover:bg-rose-950/10 transition-colors group"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-black text-stone-100">
                      {filing.form} filed {filing.filingDate}
                    </span>
                    <ExternalLink className="w-3.5 h-3.5 text-stone-600 group-hover:text-rose-300" />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {items
                      .filter((item) => HIGH_SIGNAL_8K_ITEMS.has(item.code))
                      .map((item) => (
                        <span
                          key={`${filing.accession}-${item.code}`}
                          className="px-1.5 py-0.5 bg-rose-950/40 border border-rose-800/50 text-rose-200 text-[9px] font-bold uppercase tracking-wider"
                          title={`8-K Item ${item.code}`}
                        >
                          {item.code} / {item.label}
                        </span>
                      ))}
                  </div>
                  <div className="mt-2 font-mono text-[10px] text-stone-600">
                    {filing.accession}
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <div className="border border-dashed border-stone-800 px-3 py-5 text-center text-xs text-stone-500">
              No recent high-signal 8-K item codes found in the SEC submissions feed.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FilingPulseCard({
  label,
  filing,
  fallback,
}: {
  label: string;
  filing?: FilingEntry | null;
  fallback: string;
}) {
  const age = filingAgeDays(filing);
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.18em] font-black text-stone-500">
          {label}
        </div>
        {filing && (
          <span className={`border px-1.5 py-0.5 text-[9px] font-black tracking-wider ${formColor(filing.form)}`}>
            {filing.form}
          </span>
        )}
      </div>
      <div className="mt-3 text-2xl font-black tabular-nums text-stone-100">
        {formatAgeDays(age)}
      </div>
      <div className="mt-2 text-xs leading-relaxed text-stone-400">
        {filing ? (
          <>
            Filed {filing.filingDate}
            {filing.reportDate && <span className="block text-stone-500">Period {filing.reportDate}</span>}
            <span className="block font-mono text-[10px] text-stone-600">{filing.accession}</span>
          </>
        ) : (
          fallback
        )}
      </div>
    </>
  );

  if (!filing?.documentUrl) {
    return (
      <div className="border border-stone-800 bg-stone-900/30 p-3">
        {body}
      </div>
    );
  }

  return (
    <a
      href={filing.documentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="border border-stone-800 bg-stone-900/30 p-3 hover:border-amber-600/70 hover:bg-amber-950/10 transition-colors group"
      title={`Open ${filing.form} filed ${filing.filingDate} on SEC.gov`}
    >
      {body}
      <div className="mt-3 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-stone-600 group-hover:text-amber-300">
        Open source
        <ExternalLink className="w-3 h-3" />
      </div>
    </a>
  );
}

function FilingPulseMetric({
  label,
  value,
  detail,
  sourceUrl,
}: {
  label: string;
  value: number;
  detail: string;
  sourceUrl: string | null;
}) {
  const content = (
    <>
      <div className="text-[10px] uppercase tracking-[0.18em] font-black text-stone-500">
        {label}
      </div>
      <div className="mt-2 text-2xl font-black tabular-nums text-stone-100">{value}</div>
      <div className="mt-1 text-[11px] text-stone-500">{detail}</div>
    </>
  );

  if (!sourceUrl) {
    return <div className="border border-stone-800 bg-stone-900/30 p-3">{content}</div>;
  }

  return (
    <a
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="border border-stone-800 bg-stone-900/30 p-3 hover:border-sky-700/70 hover:bg-sky-950/10 transition-colors"
      title="Open SEC submissions feed"
    >
      {content}
    </a>
  );
}

function FilingFamilyChip({
  family,
}: {
  family: { label: string; count: number; latest: FilingEntry | null };
}) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.16em] font-black text-stone-500">
          {family.label}
        </span>
        <span className="text-sm font-black tabular-nums text-stone-200">{family.count}</span>
      </div>
      <div className="mt-1 text-[10px] text-stone-600">
        {family.latest ? `Latest ${family.latest.form} on ${family.latest.filingDate}` : 'No matching filing'}
      </div>
    </>
  );

  if (!family.latest?.documentUrl) {
    return <div className="border border-stone-800 bg-stone-900/20 px-2.5 py-2">{content}</div>;
  }

  return (
    <a
      href={family.latest.documentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="border border-stone-800 bg-stone-900/20 px-2.5 py-2 hover:border-sky-700/70 hover:text-sky-200 transition-colors"
      title={`Open latest ${family.label} source filing`}
    >
      {content}
    </a>
  );
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

      <FilingPulsePanel filings={filings} cik={company?.cik} />

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
                                  return (
                                    <a
                                      key={f.accession}
                                      href={f.documentUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="flex items-start gap-4 px-5 py-3.5 hover:bg-amber-500/5 transition-colors group"
                                    >
                                      <div
                                        className={`shrink-0 px-2.5 py-1 text-[11px] font-black border tracking-wider ${formColor(
                                          f.form
                                        )} min-w-[80px] text-center`}
                                      >
                                        {f.form}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-0.5">
                                          <span className="text-sm font-bold text-stone-100 truncate">
                                            {f.primaryDescription ||
                                              f.primaryDoc ||
                                              'Filing Document'}
                                          </span>
                                          <ExternalLink className="w-3.5 h-3.5 text-stone-500 group-hover:text-amber-500 transition-colors shrink-0" />
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
                                        {items.length > 0 && (
                                          <div className="flex flex-wrap gap-1 mt-1.5">
                                            {items.map(({ code, label }) => (
                                              <span
                                                key={code}
                                                className="px-1.5 py-0.5 bg-rose-950/40 border border-rose-800/40 text-rose-200 text-[9px] font-bold uppercase tracking-wider"
                                                title={`8-K Item ${code}`}
                                              >
                                                {code} · {label}
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </a>
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
