'use client';

import { useCallback, useState } from 'react';
import { Database, FileSearch, Info, ShieldCheck, type LucideIcon } from 'lucide-react';
import DisclosureScannerImpl from '../../components/DisclosureScanner.jsx';
import ScanResultsImpl from '../../components/ScanResults.jsx';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DisclosureScanner = DisclosureScannerImpl as any;
const ScanResults = ScanResultsImpl as any;
type AnyValue = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export default function DisclosureSearchClient({
  initialQuery = '',
  initialFocus = '',
}: {
  initialQuery?: string;
  initialFocus?: string;
}) {
  const [scanData, setScanData] = useState<AnyValue>(null);

  const handleScanComplete = useCallback((data: AnyValue) => {
    setScanData(data);
    setTimeout(() => {
      document.getElementById('disclosure-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }, []);

  const handleRescan = useCallback(async (ticker: string, options: { fresh?: boolean } = {}) => {
    if (!scanData?.query?.raw) return;

    const params = new URLSearchParams({
      tickers: ticker,
      query: scanData.query.raw,
      depth: String(scanData.depth || 35),
    });
    if (options.fresh) params.set('fresh', 'true');

    const response = await fetch(`/api/disclosure-search?${params}`);
    if (!response.ok) return;
    const nextData = await response.json();

    setScanData((prev: AnyValue) => {
      if (!prev) return nextData;
      const updatedResults = prev.results.map((result: AnyValue) =>
        result.ticker === ticker && nextData.results[0] ? nextData.results[0] : result,
      );
      return { ...prev, results: updatedResults, scannedAt: nextData.scannedAt };
    });
  }, [scanData]);

  return (
    <>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <FileSearch className="w-5 h-5 text-amber-500" />
          <h1 className="text-xl font-black uppercase tracking-tight">
            Disclosure <span className="text-stone-500">/</span> Keyword Search
          </h1>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed max-w-3xl">
          Run plain-language searches across recent SEC filings or the broader SEC full-text index. Use it for
          emerging risks, customer concentration, tariffs, AI exposure, restructuring language,
          liquidity warnings, or any other term that matters to your analysis. Search the EDGAR
          index for broad source discovery with company focus, filing-form filters, and result-count
          controls, review source-window and filer-concentration signals, or scan a manual
          company set, curated sector universe, or bounded cross-sector Market Map when you need
          paragraph-level excerpts.
        </p>
      </div>

      <DisclosureScanner initialQuery={initialQuery} initialFocus={initialFocus} onScanComplete={handleScanComplete} />

      <div id="disclosure-results">
        {scanData && <ScanResults data={scanData} onRescan={handleRescan} />}
      </div>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
        <InfoPanel
          icon={Database}
          title="SEC source"
          text="Filing text is fetched from SEC archives, then each result links back to the exact source document."
        />
        <InfoPanel
          icon={ShieldCheck}
          title="Literal search"
          text="Terms are treated as literal words or phrases, not model guesses. You choose the language to test."
        />
        <InfoPanel
          icon={FileSearch}
          title="Research workflow"
          text="Start with EDGAR Index to find source filings across the broader SEC corpus, then compare up to 5 hand-picked companies, scan a sector universe, or run a cross-sector market map for paragraph-level context."
        />
      </section>

      <div className="border-2 border-stone-800 bg-stone-900/30 p-4 flex items-start gap-3">
        <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
        <div className="text-[11px] text-stone-400 leading-relaxed">
          <span className="font-bold text-stone-200">Methodology:</span>{' '}
          EDGAR Index mode uses the SEC full-text index to find matching source filings across
          the broader SEC corpus with optional company/ticker focus, date-range, form-type, and
          result-count filters, then summarizes source-window, filer-concentration, filing-mix,
          and latest-source signals from the returned SEC records. Company, Universe, and Market Map modes fetch recent 10-K, 10-Q,
          8-K, S-1, proxy, 20-F, 40-F, and N-CSR filings, convert them to text, and return
          paragraph-level excerpts. Results are cached for 24 hours by ticker and query where
          applicable. Keyword matching is exact but flexible for whitespace and hyphenation, so
          always read the linked SEC source before drawing conclusions.
        </div>
      </div>
    </>
  );
}

function InfoPanel({
  icon: Icon,
  title,
  text,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
}) {
  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-4">
      <Icon className="w-5 h-5 text-amber-400 mb-3" />
      <h2 className="text-xs font-black uppercase tracking-[0.2em] text-stone-100 mb-2">{title}</h2>
      <p className="text-xs text-stone-400 leading-relaxed">{text}</p>
    </div>
  );
}
