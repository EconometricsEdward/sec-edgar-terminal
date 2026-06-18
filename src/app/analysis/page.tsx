import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart3, ArrowRight, FileText, ShieldCheck, LineChart, Users } from 'lucide-react';
import { buildPageMetadata } from '../../utils/siteMetadata';

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: 'Financial Analysis — SEC XBRL Data',
    description:
      'Structured financial analysis for every U.S. public company. Income statement, balance sheet, cash flow, filing activity, reporting freshness, material event radar, disclosure risk radar, quarterly momentum, expense discipline, profitability bridge, earnings quality, growth durability, per-share economics, capital efficiency, asset composition, balance sheet risk, cash conversion, payout coverage, and industry-aware ratios from SEC XBRL data.',
    path: '/analysis',
  }),
};

const FEATURED_TICKERS = [
  { ticker: 'AAPL', name: 'Apple Inc.', caption: 'Tech · Mega-cap' },
  { ticker: 'JPM', name: 'JPMorgan Chase', caption: 'Banking · NIM + efficiency' },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', caption: 'Semiconductors · R&D intensity' },
  { ticker: 'XOM', name: 'Exxon Mobil', caption: 'Energy · Margins by segment' },
];

const ANALYSIS_CHUNKS = [
  { icon: BarChart3, label: 'Snapshot', text: 'Source pack, reporting freshness, analyst checklist, summary dashboard.' },
  { icon: FileText, label: 'Filings & Risk', text: 'Filing activity, material events, disclosure radar, peer context.' },
  { icon: ShieldCheck, label: 'Quality', text: 'Margins, accruals, growth durability, per-share economics, capital efficiency.' },
  { icon: LineChart, label: 'Market', text: '10-year stock history with 10-K, 10-Q, and insider transaction markers.' },
  { icon: Users, label: 'Ownership', text: 'Form 4 insider activity and institutional holder context.' },
];

export default function AnalysisIndexPage() {
  return (
    <>
      <section className="professional-card overflow-hidden p-6 sm:p-8 lg:p-10">
        <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
          <div>
            <div className="eyebrow">Financial analysis</div>
            <h1 className="mt-3 max-w-3xl text-4xl font-black tracking-tight text-white sm:text-5xl">
              A company workspace instead of one endless dashboard.
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-8 text-slate-300">
              Structured financial data for every U.S. public company — income statement, balance sheet, cash flow, industry-aware ratios, filing activity, risk radar, stock markers, insiders, holders, and concept-level source history.
            </p>
            <p className="mt-4 text-sm leading-7 text-slate-400">
              Search for a company in the header, or start with one of the examples below. Fund and ETF tickers are automatically routed to the Funds page.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {ANALYSIS_CHUNKS.map((chunk) => {
              const Icon = chunk.icon;
              return (
                <div key={chunk.label} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                  <Icon className="h-5 w-5 text-amber-200" />
                  <div className="mt-3 text-sm font-black uppercase tracking-[0.16em] text-white">{chunk.label}</div>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{chunk.text}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <div className="eyebrow">Try it with a familiar company</div>
            <h2 className="mt-2 text-2xl font-black text-white">Jump into the redesigned analysis workspace</h2>
          </div>
          <span className="text-sm text-slate-500">Each card opens the same data, now organized into focused chunks.</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURED_TICKERS.map((t) => (
            <Link
              key={t.ticker}
              href={`/analysis/${t.ticker}`}
              className="group panel-card block p-5 transition hover:-translate-y-1 hover:border-amber-300/40"
            >
              <div className="flex items-start justify-between">
                <span className="text-3xl font-black tracking-tight text-white group-hover:text-amber-200">
                  {t.ticker}
                </span>
                <ArrowRight className="h-5 w-5 text-slate-600 transition group-hover:translate-x-1 group-hover:text-amber-300" />
              </div>
              <div className="mt-3 text-sm font-bold text-slate-300">{t.name}</div>
              <div className="mt-2 text-xs leading-5 text-slate-500">{t.caption}</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-8 panel-card border-dashed p-10 text-center">
        <BarChart3 className="mx-auto mb-4 h-12 w-12 text-slate-700" />
        <p className="text-sm font-black uppercase tracking-[0.18em] text-slate-400">Use global search</p>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-500">
          Look up any company by ticker or name to open financials, ratios, stock markers, insider activity, holder data, filing activity, disclosure risk radar, and the source-linked analyst checklist.
        </p>
      </section>
    </>
  );
}
