import React, { useState, useEffect, useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight, FileText, BarChart3, GitCompare, Users, LineChart, Percent,
  Search, TrendingUp, Database, Shield, Zap, ExternalLink, Info,
} from 'lucide-react';
import { TickerContext } from '../App.jsx';
import { secFilesUrl } from '../utils/secApi.js';

// Featured companies to showcase — chosen to span industries so users can see
// how the tool handles banks vs tech vs retail
const FEATURED_TICKERS = [
  { ticker: 'AAPL', name: 'Apple Inc.', industry: 'Tech', caption: 'Mega-cap tech', accent: 'amber' },
  { ticker: 'JPM', name: 'JPMorgan Chase', industry: 'Banking', caption: 'Big bank — NIM + efficiency ratios', accent: 'sky' },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', industry: 'Semiconductors', caption: 'Growth + insider activity', accent: 'emerald' },
  { ticker: 'XOM', name: 'Exxon Mobil', industry: 'Energy', caption: 'Oil & gas', accent: 'rose' },
];

const FEATURE_GRID = [
  {
    icon: FileText,
    title: 'Complete Filing History',
    description: 'Every 10-K, 10-Q, 8-K, Form 4, and proxy filed with the SEC. Grouped by year and quarter, filterable by form type, one click to the original document.',
    link: '/filings/AAPL',
    linkLabel: 'See Apple\'s filings →',
  },
  {
    icon: BarChart3,
    title: 'Financial Analysis',
    description: 'Income statement, balance sheet, cash flow, and calculated ratios across 10 fiscal years. Every value links to its source XBRL tag on SEC.gov.',
    link: '/analysis/JPM',
    linkLabel: 'Analyze JPMorgan →',
  },
  {
    icon: Percent,
    title: 'Industry-Aware Ratios',
    description: 'Banks get NIM, Efficiency Ratio, and NPL. Tech gets Rule of 40 and R&D intensity. Retail gets inventory turnover. Ratios automatically match each company\'s industry.',
    link: '/analysis/C',
    linkLabel: 'See banking ratios →',
  },
  {
    icon: LineChart,
    title: 'Stock Price with Filing Markers',
    description: '10 years of stock price history, with 10-K and 10-Q filing dates marked. Click any marker to open that filing. Insider buys and sells overlaid.',
    link: '/analysis/TSLA',
    linkLabel: 'See Tesla\'s chart →',
  },
  {
    icon: Users,
    title: 'Insider Trading',
    description: 'Parsed from SEC Form 4 XML filings. See which executives are buying or selling, when, at what price, and how it relates to filing dates.',
    link: '/analysis/NVDA',
    linkLabel: 'NVIDIA insiders →',
  },
  {
    icon: GitCompare,
    title: 'Peer Comparison',
    description: 'Compare up to 5 companies side-by-side. Normalize by index-to-100, per-share, or % of revenue. Head-to-head snapshot table with color-coded leaders.',
    link: '/compare/AAPL,MSFT,GOOGL,META,AMZN',
    linkLabel: 'Compare Big Tech →',
  },
];

const PEER_GROUP_SAMPLES = [
  { label: 'Big Tech', tickers: 'AAPL,MSFT,GOOGL,META,AMZN', icon: '💻' },
  { label: 'Big Banks', tickers: 'JPM,BAC,WFC,C,GS', icon: '🏦' },
  { label: 'Semiconductors', tickers: 'NVDA,AMD,INTC,AVGO,QCOM', icon: '🔌' },
  { label: 'U.S. Airlines', tickers: 'DAL,UAL,AAL,LUV', icon: '✈️' },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const { tickerMap, setTickerMap } = useContext(TickerContext);

  // Load ticker map if not already loaded
  useEffect(() => {
    if (tickerMap) return;
    (async () => {
      try {
        const res = await fetch(secFilesUrl('company_tickers.json'));
        if (!res.ok) return;
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
        // Silent — ticker map failing is not fatal for landing page
      }
    })();
  }, [tickerMap, setTickerMap]);

  const handleSearch = (e) => {
    e.preventDefault();
    const trimmed = input.trim().toUpperCase();
    if (!trimmed) return;
    navigate(`/analysis/${trimmed}`);
  };

  return (
    <>
      {/* ============= Hero Section ============= */}
      <section className="py-8 md:py-12 border-b-2 border-stone-800 mb-8">
        <div className="max-w-4xl">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] uppercase tracking-[0.3em] text-amber-400 font-bold">
              SEC Public Filings Explorer
            </span>
            <span className="text-stone-700">•</span>
            <span className="text-[10px] uppercase tracking-[0.3em] text-stone-500">
              Direct From data.sec.gov
            </span>
          </div>

          <h1 className="text-3xl md:text-5xl font-black tracking-tight text-stone-100 mb-4 leading-tight">
            SEC filings and financial data,{' '}
            <span className="text-amber-400">without the noise.</span>
          </h1>

          <p className="text-base md:text-lg text-stone-400 leading-relaxed mb-6 max-w-3xl">
            A transparent, source-linked explorer for every publicly traded U.S. company.
            Read the actual filings. See the reported financials. Compare peers. Track insiders.
            Every number cites its XBRL source on SEC.gov.
          </p>

          {/* Search bar front and center */}
          <form onSubmit={handleSearch} className="mb-6">
            <div className="flex flex-col sm:flex-row gap-2 max-w-2xl">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-stone-500" />
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value.toUpperCase())}
                  placeholder="Enter any ticker symbol (AAPL, JPM, TSLA, etc.)"
                  className="w-full bg-stone-900 border-2 border-stone-800 focus:border-amber-500 outline-none pl-11 pr-4 py-3.5 text-base font-bold tracking-wider placeholder-stone-600 transition-colors"
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <button
                type="submit"
                className="px-6 py-3.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors flex items-center justify-center gap-2"
              >
                Analyze
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </form>

          {/* Quick trust indicators */}
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11px] uppercase tracking-wider text-stone-500">
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-amber-500" />
              Live data from SEC.gov
            </span>
            <span className="flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-emerald-500" />
              No tracking, no accounts
            </span>
            <span className="flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-sky-500" />
              Every value source-linked
            </span>
            <span className="flex items-center gap-1.5">
              <ExternalLink className="w-3.5 h-3.5 text-violet-500" />
              Free forever
            </span>
          </div>
        </div>
      </section>

      {/* ============= Featured tickers — "try it now" ============= */}
      <section className="mb-12">
        <div className="flex items-end justify-between mb-4 flex-wrap gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">
              Start here
            </div>
            <h2 className="text-xl md:text-2xl font-black text-stone-100">
              Try it with a familiar company
            </h2>
          </div>
          <span className="text-xs text-stone-500">
            One click → full financial analysis, industry-specific ratios, filings, insiders
          </span>
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
              <Link
                key={t.ticker}
                to={`/analysis/${t.ticker}`}
                className={`group block border-2 border-stone-800 bg-stone-900/30 p-4 transition-colors ${accentClass}`}
              >
                <div className="flex items-start justify-between mb-2">
                  <span className="text-xl md:text-2xl font-black tracking-wider text-stone-100 group-hover:text-current transition-colors">
                    {t.ticker}
                  </span>
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

      {/* ============= What You Can Do — Feature Grid ============= */}
      <section className="mb-12">
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">
            What you can do
          </div>
          <h2 className="text-xl md:text-2xl font-black text-stone-100">
            Six ways to explore any company
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURE_GRID.map((feature) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="border-2 border-stone-800 bg-stone-900/30 p-5 hover:border-amber-500/50 transition-colors group"
              >
                <Icon className="w-6 h-6 text-amber-400 mb-3" />
                <h3 className="text-sm font-black uppercase tracking-wider text-stone-100 mb-2">
                  {feature.title}
                </h3>
                <p className="text-xs text-stone-400 leading-relaxed mb-3">
                  {feature.description}
                </p>
                <Link
                  to={feature.link}
                  className="text-xs text-amber-400 hover:text-amber-300 font-bold uppercase tracking-wider inline-flex items-center gap-1 group-hover:gap-2 transition-all"
                >
                  {feature.linkLabel}
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      {/* ============= Peer Groups — "one click to compare" ============= */}
      <section className="mb-12">
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-1">
            Compare peer groups instantly
          </div>
          <h2 className="text-xl md:text-2xl font-black text-stone-100">
            Side-by-side in one click
          </h2>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {PEER_GROUP_SAMPLES.map((g) => (
            <Link
              key={g.label}
              to={`/compare/${g.tickers}`}
              className="flex items-center gap-3 p-4 border-2 border-stone-800 bg-stone-900/30 hover:border-amber-500 hover:bg-amber-500/5 transition-colors group"
            >
              <span className="text-2xl">{g.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black uppercase tracking-wider text-stone-100 group-hover:text-amber-300 transition-colors truncate">
                  {g.label}
                </div>
                <div className="text-[10px] text-stone-500 truncate">{g.tickers}</div>
              </div>
              <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-amber-400 transition-colors shrink-0" />
            </Link>
          ))}
        </div>
      </section>

      {/* ============= "Why this site is different" — credibility ============= */}
      <section className="mb-12">
        <div className="border-2 border-stone-800 bg-stone-900/30 p-6 md:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-10">
            <div>
              <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-2">
                Why another SEC tool?
              </div>
              <h2 className="text-lg md:text-xl font-black text-stone-100 mb-3">
                Built for people who want to check the footnotes.
              </h2>
              <p className="text-sm text-stone-400 leading-relaxed">
                Most financial tools tell you what the numbers are. This one shows you where they
                came from. Every value on every page links to the exact XBRL tag, filing, and
                accession number on SEC.gov. Hover any number to see its source.
              </p>
            </div>
            <div className="space-y-3">
              <DifferentiatorRow
                label="Source-linked"
                text="Every value shows its XBRL tag, filing date, and accession number"
              />
              <DifferentiatorRow
                label="Industry-aware"
                text="Banks get bank ratios, tech gets tech ratios, retail gets retail ratios"
              />
              <DifferentiatorRow
                label="No account needed"
                text="No sign-up, no email capture, no paywalls — just the data"
              />
              <DifferentiatorRow
                label="Research-grade"
                text="Built for analysts, students, and curious readers of 10-Ks"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ============= Call to action ============= */}
      <section className="mb-12">
        <div className="border-2 border-amber-700/40 bg-amber-950/20 p-6 md:p-8 text-center">
          <h2 className="text-xl md:text-2xl font-black text-amber-300 mb-2">
            Pick any ticker to begin.
          </h2>
          <p className="text-sm text-stone-300 mb-5 max-w-2xl mx-auto">
            There are over 10,000 publicly traded U.S. companies in the SEC database.
            Type any of them above, or start with a featured example.
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            <Link to="/filings/AAPL"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors">
              <FileText className="w-4 h-4" />
              Browse Filings
            </Link>
            <Link to="/analysis/AAPL"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors">
              <BarChart3 className="w-4 h-4" />
              View Analysis
            </Link>
            <Link to="/compare/AAPL,MSFT,GOOGL,META,AMZN"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors">
              <GitCompare className="w-4 h-4" />
              Compare Peers
            </Link>
          </div>
        </div>
      </section>

      {/* ============= Footer note ============= */}
      <section className="mb-4">
        <div className="flex items-start gap-3 p-4 border border-stone-800 bg-stone-950/50">
          <Info className="w-4 h-4 text-stone-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-stone-500 leading-relaxed">
            <span className="font-bold text-stone-400">For research and educational use only.</span>{' '}
            Not investment advice. Data from SEC public APIs — verify critical numbers against
            original filings. See the <Link to="/about" className="text-amber-400 hover:underline">About page</Link> for
            methodology, limitations, and data sources.
          </p>
        </div>
      </section>
    </>
  );
}

function DifferentiatorRow({ label, text }) {
  return (
    <div className="flex items-start gap-3">
      <span className="shrink-0 inline-block w-20 text-[10px] uppercase tracking-widest text-amber-400 font-bold pt-0.5">
        {label}
      </span>
      <span className="text-xs text-stone-300 leading-relaxed">{text}</span>
    </div>
  );
}
