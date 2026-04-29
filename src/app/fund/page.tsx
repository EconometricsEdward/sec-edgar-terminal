import type { Metadata } from 'next';
import Link from 'next/link';
import { Wallet, ArrowRight, Info } from 'lucide-react';

// ============================================================================
// Metadata — static for the index page
// ============================================================================
export const metadata: Metadata = {
  title: 'Mutual Funds & ETFs — Holdings, AUM, and N-PORT Filings',
  description:
    "Explore holdings, assets, and filings for every U.S. mutual fund and ETF. Data directly from SEC's N-PORT monthly portfolio disclosures.",
  alternates: {
    canonical: 'https://secedgarterminal.com/fund',
  },
};

// ============================================================================
// Featured funds — curated list shown on the index
// ============================================================================
const FEATURED_FUNDS = [
  { ticker: 'SPY', name: 'SPDR S&P 500 ETF', family: 'SPDR / State Street', aum: 'Largest ETF', accent: 'amber' as const },
  { ticker: 'VOO', name: 'Vanguard S&P 500 ETF', family: 'Vanguard', aum: 'Lower fees', accent: 'emerald' as const },
  { ticker: 'QQQ', name: 'Invesco QQQ Trust', family: 'Invesco', aum: 'Nasdaq-100', accent: 'sky' as const },
  { ticker: 'VTI', name: 'Vanguard Total Stock Market', family: 'Vanguard', aum: 'Total US market', accent: 'emerald' as const },
  { ticker: 'ARKK', name: 'ARK Innovation ETF', family: 'ARK Invest', aum: 'Active/thematic', accent: 'rose' as const },
  { ticker: 'IWM', name: 'iShares Russell 2000', family: 'iShares / BlackRock', aum: 'Small-cap', accent: 'violet' as const },
  { ticker: 'BND', name: 'Vanguard Total Bond Market', family: 'Vanguard', aum: 'Bonds', accent: 'stone' as const },
  { ticker: 'VXUS', name: 'Vanguard Total International', family: 'Vanguard', aum: 'Ex-US equities', accent: 'emerald' as const },
];

// ============================================================================
// Page — pure server component, fully static
// ============================================================================
export default function FundIndexPage() {
  return (
    <>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Wallet className="w-5 h-5 text-amber-500" />
          <h1 className="text-xl font-black uppercase tracking-tight">Mutual Funds & ETFs</h1>
        </div>
        <p className="text-xs text-stone-400 leading-relaxed max-w-3xl">
          Holdings, assets, and filings for mutual funds and exchange-traded funds. Data comes
          directly from SEC&apos;s N-PORT monthly portfolio filings. Use the search bar above to find any fund.
        </p>
      </div>

      <div className="mb-4">
        <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">
          Featured Funds
        </div>
        <h2 className="text-lg md:text-xl font-black text-stone-100">
          Popular ETFs and index funds
        </h2>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        {FEATURED_FUNDS.map((f) => {
          const accentClass = {
            amber: 'hover:border-amber-500 hover:text-amber-300',
            emerald: 'hover:border-emerald-500 hover:text-emerald-300',
            sky: 'hover:border-sky-500 hover:text-sky-300',
            rose: 'hover:border-rose-500 hover:text-rose-300',
            violet: 'hover:border-violet-500 hover:text-violet-300',
            stone: 'hover:border-stone-500 hover:text-stone-300',
          }[f.accent];
          return (
            <Link
              key={f.ticker}
              href={`/fund/${f.ticker}`}
              className={`group block border-2 border-stone-800 bg-stone-900/30 p-4 transition-colors ${accentClass}`}
            >
              <div className="flex items-start justify-between mb-2">
                <span className="text-xl md:text-2xl font-black tracking-wider text-stone-100 group-hover:text-current transition-colors">
                  {f.ticker}
                </span>
                <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-current transition-colors" />
              </div>
              <div className="text-[11px] text-stone-400 mb-1 font-bold truncate">{f.name}</div>
              <div className="text-[9px] uppercase tracking-widest text-stone-600 mb-2">{f.family}</div>
              <div className="text-[10px] text-stone-500 leading-tight">{f.aum}</div>
            </Link>
          );
        })}
      </div>

      <div className="border-2 border-stone-800 bg-stone-900/30 p-5">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
          <div className="text-xs text-stone-300 leading-relaxed">
            <span className="font-bold text-sky-300">What you&apos;ll see for each fund:</span><br />
            Net assets (AUM), top holdings with share counts and USD values, asset class breakdown
            (equity/bonds/derivatives/cash), fund family, and recent SEC filings (N-PORT, N-CSR, N-1A).
            All data is pulled directly from SEC&apos;s N-PORT monthly portfolio disclosures —
            filed with a 60-day delay per SEC rules.
          </div>
        </div>
      </div>
    </>
  );
}
