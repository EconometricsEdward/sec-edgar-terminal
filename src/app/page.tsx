import Link from 'next/link';
import {
  ArrowRight, FileText, BarChart3, GitCompare, Users, LineChart, Percent,
  Database, Shield, Zap, ExternalLink, Info,
  FileSearch, Cpu, Landmark, Plane,
} from 'lucide-react';
import HeroSearch from './HeroSearch';

// ============================================================================
// Metadata note
//
// We intentionally don't export metadata here. The root layout already sets
// the correct title, description, openGraph, twitter, canonical, and JSON-LD
// for the homepage. Setting metadata here would either duplicate those (no
// benefit) or trigger Next.js's title template "%s | EDGAR Terminal" which
// would produce 'EDGAR Terminal — ... | EDGAR Terminal' on /. By omitting,
// the layout's `title.default` is used as-is.
// ============================================================================

// ============================================================================
// Featured ticker cards — the "Try it with a familiar company" grid
// ============================================================================
const FEATURED_TICKERS = [
  { ticker: 'AAPL', name: 'Apple Inc.', industry: 'Tech', caption: 'Mega-cap tech', accent: 'amber' as const },
  { ticker: 'JPM', name: 'JPMorgan Chase', industry: 'Banking', caption: 'Big bank — NIM + efficiency ratios', accent: 'sky' as const },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', industry: 'Semiconductors', caption: 'Growth + insider activity', accent: 'emerald' as const },
  { ticker: 'XOM', name: 'Exxon Mobil', industry: 'Energy', caption: 'Oil & gas', accent: 'rose' as const },
];

const FEATURE_GRID = [
  { icon: FileText, title: 'Complete Filing History', description: 'Every 10-K, 10-Q, 8-K, Form 4, and proxy filed with the SEC. Grouped by year and quarter, filterable by form type, one click to the original document.', link: '/filings/AAPL', linkLabel: "See Apple's filings →" },
  { icon: BarChart3, title: 'Financial Analysis', description: 'Income statement, balance sheet, cash flow, and calculated ratios across 10 fiscal years. Every value links to its source XBRL tag on SEC.gov.', link: '/analysis/JPM', linkLabel: 'Analyze JPMorgan →' },
  { icon: Percent, title: 'Industry-Aware Ratios', description: "Banks get NIM, Efficiency Ratio, and NPL. Tech gets Rule of 40 and R&D intensity. Retail gets inventory turnover. Ratios automatically match each company's industry.", link: '/analysis/C', linkLabel: 'See banking ratios →' },
  { icon: LineChart, title: 'Stock Price with Filing Markers', description: '10 years of stock price history, with 10-K and 10-Q filing dates marked. Click any marker to open that filing. Insider buys and sells overlaid.', link: '/analysis/TSLA', linkLabel: "See Tesla's chart →" },
  { icon: Users, title: 'Insider Trading', description: 'Parsed from SEC Form 4 XML filings. See which executives are buying or selling, when, at what price, and how it relates to filing dates.', link: '/analysis/NVDA', linkLabel: 'NVIDIA insiders →' },
  { icon: GitCompare, title: 'Peer Comparison', description: 'Compare up to 5 companies side-by-side. Normalize by index-to-100, per-share, or % of revenue. Head-to-head snapshot table with color-coded leaders.', link: '/compare/AAPL,MSFT,GOOGL,META,AMZN', linkLabel: 'Compare Big Tech →' },
  { icon: FileSearch, title: 'Crypto Disclosure Scanner', description: "Scan any company's SEC filings for bitcoin, cryptocurrency, and digital asset mentions. Paragraph-level excerpts with direct links to source filings. Compare crypto exposure across up to 5 tickers.", link: '/crypto', linkLabel: 'Scan MSTR, COIN, MARA →' },
];

const PEER_GROUP_SAMPLES = [
  { label: 'Big Tech', tickers: 'AAPL,MSFT,GOOGL,META,AMZN', icon: Cpu },
  { label: 'Big Banks', tickers: 'JPM,BAC,WFC,C,GS', icon: Landmark },
  { label: 'Semiconductors', tickers: 'NVDA,AMD,INTC,AVGO,QCOM', icon: Cpu },
  { label: 'U.S. Airlines', tickers: 'DAL,UAL,AAL,LUV', icon: Plane },
];

// ============================================================================
// Page — pure server component except for the <HeroSearch /> client island
// ============================================================================
export default function LandingPage() {
  return (
    <>
      <section className="py-8 md:py-12 border-b-2 border-stone-800 mb-8">
        <div className="max-w-4xl">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] uppercase tracking-[0.3em] text-amber-400 font-bold">SEC Public Filings Explorer</span>
            <span className="text-stone-700">•</span>
            <span className="text-[10px] uppercase tracking-[0.3em] text-stone-500">Direct From data.sec.gov</span>
          </div>

          <h1 className="text-3xl md:text-5xl font-black tracking-tight text-stone-100 mb-4 leading-tight">
            SEC filings and financial data,{' '}
            <span className="text-amber-400">without the noise.</span>
          </h1>

          <p className="text-base md:text-lg text-stone-400 leading-relaxed mb-6 max-w-3xl">
            A transparent, source-linked explorer for every publicly traded U.S. company.
            Read the actual filings. See the reported financials. Compare peers. Track insiders.
            Scan crypto disclosures. Every number cites its XBRL source on SEC.gov.
          </p>

          {/* Hero search — client island */}
          <HeroSearch />

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11px] uppercase tracking-wider text-stone-500">
            <span className="flex items-center gap-1.5"><Database className="w-3.5 h-3.5 text-amber-500" />Live data from SEC.gov</span>
            <span className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5 text-emerald-500" />No tracking, no accounts</span>
            <span className="flex items-center gap-1.5"><Zap className="w-3.5 h-3.5 text-sky-500" />Every value source-linked</span>
            <span className="flex items-center gap-1.5"><ExternalLink className="w-3.5 h-3.5 text-violet-500" />Free forever</span>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <div className="flex items-end justify-between mb-4 flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">Start here</div>
            <h2 className="text-xl md:text-2xl font-black text-stone-100">Try it with a familiar company</h2>
          </div>
          <span className="text-xs text-stone-500">One click → full financial analysis, industry-specific ratios, filings, insiders</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {FEATURED_TICKERS.map((t) => {
            const accentClass = {
              amber: 'hover:border-amber-500 hover:text-amber-300',
              sky: 'hover:border-sky-500 hover:text-sky-300',
              emerald: 'hover:border-emerald-500 hover:text-emerald-300',
              rose: 'hover:border-rose-500 hover:text-rose-300',
            }[t.accent];
            return (
              <Link key={t.ticker} href={`/analysis/${t.ticker}`} className={`group block border-2 border-stone-800 bg-stone-900/30 p-4 transition-colors ${accentClass}`}>
                <div className="flex items-start justify-between mb-2">
                  <span className="text-xl md:text-2xl font-black tracking-wider text-stone-100 group-hover:text-current transition-colors">{t.ticker}</span>
                  <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-current transition-colors" />
                </div>
                <div className="text-[11px] text-stone-400 mb-1 font-bold truncate">{t.name}</div>
                <div className="text-[9px] uppercase tracking-widest text-stone-600 mb-2">{t.industry}</div>
                <div className="text-[10px] text-stone-500 leading-tight">{t.caption}</div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mb-12">
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">What you can do</div>
          <h2 className="text-xl md:text-2xl font-black text-stone-100">Seven ways to explore any company</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURE_GRID.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="border-2 border-stone-800 bg-stone-900/30 p-5 hover:border-amber-500/50 transition-colors group">
                <Icon className="w-6 h-6 text-amber-400 mb-3" />
                <h3 className="text-sm font-black uppercase tracking-wider text-stone-100 mb-2">{feature.title}</h3>
                <p className="text-xs text-stone-400 leading-relaxed mb-3">{feature.description}</p>
                <Link href={feature.link} className="text-xs text-amber-400 hover:text-amber-300 font-bold uppercase tracking-wider inline-flex items-center gap-1 group-hover:gap-2 transition-all">
                  {feature.linkLabel}
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mb-12">
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">Compare peer groups instantly</div>
          <h2 className="text-xl md:text-2xl font-black text-stone-100">Side-by-side in one click</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {PEER_GROUP_SAMPLES.map((g) => {
            const Icon = g.icon;
            return (
              <Link key={g.label} href={`/compare/${g.tickers}`} className="flex items-center gap-3 p-4 border-2 border-stone-800 bg-stone-900/30 hover:border-amber-500 hover:bg-amber-500/5 transition-colors group">
                <Icon className="w-5 h-5 text-amber-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black uppercase tracking-wider text-stone-100 group-hover:text-amber-300 transition-colors truncate">{g.label}</div>
                  <div className="text-[10px] text-stone-500 truncate">{g.tickers}</div>
                </div>
                <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-amber-400 transition-colors shrink-0" />
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mb-12">
        <div className="border-2 border-stone-800 bg-stone-900/30 p-6 md:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-10">
            <div>
              <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-2">Why another SEC tool?</div>
              <h2 className="text-lg md:text-xl font-black text-stone-100 mb-3">Built for people who want to check the footnotes.</h2>
              <p className="text-sm text-stone-400 leading-relaxed">
                Most financial tools tell you what the numbers are. This one shows you where they
                came from. Every value on every page links to the exact XBRL tag, filing, and
                accession number on SEC.gov. Hover any number to see its source.
              </p>
            </div>
            <div className="space-y-3">
              <DifferentiatorRow label="Source-linked" text="Every value shows its XBRL tag, filing date, and accession number" />
              <DifferentiatorRow label="Industry-aware" text="Banks get bank ratios, tech gets tech ratios, retail gets retail ratios" />
              <DifferentiatorRow label="No account needed" text="No sign-up, no email capture, no paywalls — just the data" />
              <DifferentiatorRow label="Research-grade" text="Built for analysts, students, and curious readers of 10-Ks" />
            </div>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <div className="border-2 border-amber-700/40 bg-amber-950/20 p-6 md:p-8 text-center">
          <h2 className="text-xl md:text-2xl font-black text-amber-300 mb-2">Pick any ticker to begin.</h2>
          <p className="text-sm text-stone-300 mb-5 max-w-2xl mx-auto">
            There are over 10,000 publicly traded U.S. companies in the SEC database.
            Type any of them above, or start with a featured example.
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            <Link href="/filings/AAPL" className="inline-flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors">
              <FileText className="w-4 h-4" />Browse Filings
            </Link>
            <Link href="/analysis/AAPL" className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors">
              <BarChart3 className="w-4 h-4" />View Analysis
            </Link>
            <Link href="/compare/AAPL,MSFT,GOOGL,META,AMZN" className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors">
              <GitCompare className="w-4 h-4" />Compare Peers
            </Link>
            <Link href="/crypto" className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors">
              <FileSearch className="w-4 h-4" />Scan Crypto Disclosures
            </Link>
          </div>
        </div>
      </section>

      <section className="mb-4">
        <div className="flex items-start gap-3 p-4 border border-stone-800 bg-stone-950/50">
          <Info className="w-4 h-4 text-stone-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-stone-500 leading-relaxed">
            <span className="font-bold text-stone-400">For research and educational use only.</span>{' '}
            Not investment advice. Data from SEC public APIs — verify critical numbers against
            original filings. See the <Link href="/about" className="text-amber-400 hover:underline">About page</Link> for
            methodology, limitations, and data sources.
          </p>
        </div>
      </section>
    </>
  );
}

// ============================================================================
// Sub-components — preserved verbatim from original LandingPage.jsx
// ============================================================================

function DifferentiatorRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="shrink-0 inline-block w-20 text-[10px] uppercase tracking-widest text-amber-400 font-bold pt-0.5">{label}</span>
      <span className="text-xs text-stone-300 leading-relaxed">{text}</span>
    </div>
  );
}
