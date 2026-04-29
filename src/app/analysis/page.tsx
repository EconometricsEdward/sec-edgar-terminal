import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart3, ArrowRight } from 'lucide-react';

// ============================================================================
// Metadata — static, since this page has no dynamic ticker
// ============================================================================
export const metadata: Metadata = {
  title: 'Financial Analysis — SEC XBRL Data',
  description:
    'Structured financial analysis for every U.S. public company. Income statement, balance sheet, cash flow, and industry-aware ratios from SEC XBRL data.',
  alternates: {
    canonical: 'https://secedgarterminal.com/analysis',
  },
};

// ============================================================================
// Featured tickers — same set as Filings index for visual consistency
// ============================================================================
const FEATURED_TICKERS = [
  { ticker: 'AAPL', name: 'Apple Inc.', caption: 'Tech · Mega-cap' },
  { ticker: 'JPM', name: 'JPMorgan Chase', caption: 'Banking · NIM + efficiency' },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', caption: 'Semiconductors · R&D intensity' },
  { ticker: 'XOM', name: 'Exxon Mobil', caption: 'Energy · Margins by segment' },
];

// ============================================================================
// Page — pure server component, zero client JS needed
// ============================================================================
export default function AnalysisIndexPage() {
  return (
    <>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <BarChart3 className="w-5 h-5 text-amber-500" />
          <h1 className="text-xl font-black uppercase tracking-tight">
            Financial Analysis
          </h1>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed max-w-3xl">
          Structured financial data for every U.S. public company — income
          statement, balance sheet, cash flow, and industry-aware ratios pulled
          directly from SEC XBRL filings. Includes 10-year stock price history
          with filing markers, insider trading activity, institutional holders,
          and concept-level history (including restatements).
        </p>
      </div>

      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-3">
          Try it with a familiar company
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {FEATURED_TICKERS.map((t) => (
            <Link
              key={t.ticker}
              href={`/analysis/${t.ticker}`}
              className="group block border-2 border-stone-800 bg-stone-900/30 p-4 hover:border-amber-500 hover:text-amber-300 transition-colors"
            >
              <div className="flex items-start justify-between mb-2">
                <span className="text-xl md:text-2xl font-black tracking-wider text-stone-100 group-hover:text-current transition-colors">
                  {t.ticker}
                </span>
                <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-current transition-colors" />
              </div>
              <div className="text-[11px] text-stone-400 mb-1 font-bold truncate">
                {t.name}
              </div>
              <div className="text-[10px] text-stone-500 leading-tight">
                {t.caption}
              </div>
            </Link>
          ))}
        </div>
      </div>

      <div className="border-2 border-dashed border-stone-800 p-12 text-center">
        <BarChart3 className="w-12 h-12 text-stone-700 mx-auto mb-4" />
        <p className="text-stone-500 text-sm uppercase tracking-widest mb-2">
          Financial Analysis
        </p>
        <p className="text-stone-600 text-xs max-w-md mx-auto">
          Use the search bar above to look up any company by ticker or name.
          You'll see financial data, industry-specific ratios, stock prices
          with filing markers, and insider trading activity.
        </p>
        <p className="text-stone-700 text-[10px] max-w-md mx-auto mt-3">
          Mutual fund and ETF tickers are automatically routed to the Funds page.
        </p>
      </div>
    </>
  );
}
