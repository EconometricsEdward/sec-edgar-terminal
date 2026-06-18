import Link from 'next/link';
import {
  ArrowRight, FileText, BarChart3, GitCompare, Users, LineChart, Percent,
  Database, Shield, Zap, ExternalLink,
  FileSearch, Cpu, Landmark, Plane, Search, LayoutDashboard,
} from 'lucide-react';
import HeroSearch from './HeroSearch';

const FEATURED_TICKERS = [
  { ticker: 'AAPL', name: 'Apple Inc.', industry: 'Tech', caption: 'Mega-cap tech', accent: 'amber' as const },
  { ticker: 'JPM', name: 'JPMorgan Chase', industry: 'Banking', caption: 'Big bank — NIM + efficiency ratios', accent: 'sky' as const },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', industry: 'Semiconductors', caption: 'Growth + insider activity', accent: 'emerald' as const },
  { ticker: 'XOM', name: 'Exxon Mobil', industry: 'Energy', caption: 'Oil & gas', accent: 'rose' as const },
];

const FEATURE_GRID = [
  { icon: FileText, title: 'Complete Filing History', description: 'Every 10-K, 10-Q, 8-K, Form 4, and proxy filed with the SEC. Each company starts with a source-linked filing pulse, then groups filings by year and quarter with form filters and one-click source documents.', link: '/filings/AAPL', linkLabel: "See Apple's filings →" },
  { icon: BarChart3, title: 'Financial Analysis', description: 'Income statement, balance sheet, cash flow, common-size views, SEC filing activity, material event radar, disclosure risk radar, quarterly momentum, expense discipline, profitability bridge, earnings quality, growth durability, per-share economics, capital efficiency, asset composition, balance sheet risk, cash conversion, capital allocation with payout coverage, and a source-linked analyst checklist across 10 fiscal years. Every value links to its source XBRL tag or filing on SEC.gov.', link: '/analysis/JPM', linkLabel: 'Analyze JPMorgan →' },
  { icon: Percent, title: 'Industry-Aware Ratios', description: "Banks get NIM, Efficiency Ratio, and NPL. Tech gets Rule of 40 and R&D intensity. Retail gets inventory turnover. Ratios automatically match each company's industry.", link: '/analysis/C', linkLabel: 'See banking ratios →' },
  { icon: LineChart, title: 'Stock Price with Filing Markers', description: '10 years of stock price history, with 10-K and 10-Q filing dates marked. Click any marker to open that filing. Insider buys and sells overlaid.', link: '/analysis/TSLA', linkLabel: "See Tesla's chart →" },
  { icon: Users, title: 'Insider Trading', description: 'Parsed from SEC Form 4 XML filings. See which executives are buying or selling, when, at what price, and how it relates to filing dates.', link: '/analysis/NVDA', linkLabel: 'NVIDIA insiders →' },
  { icon: GitCompare, title: 'Peer Comparison', description: 'Compare up to 5 companies side-by-side. Normalize by index-to-100, per-share, or % of revenue. Head-to-head snapshot table with color-coded leaders.', link: '/compare/AAPL,MSFT,GOOGL,META,AMZN', linkLabel: 'Compare Big Tech →' },
  { icon: FileSearch, title: 'Disclosure Keyword Search', description: 'Search the broader SEC EDGAR full-text index for any risk, trend, or operating term with optional company focus plus date, filing-form, and result-count filters, then review source-window, filer-concentration, and filing-mix signals before opening every hit at the source filing. For deeper context, scan up to 5 companies, curated sector universes, or a bounded cross-sector Market Map with paragraph-level excerpts.', link: '/disclosures', linkLabel: 'Search tariffs, AI, cyber risk →' },
];

const PEER_GROUP_SAMPLES = [
  { label: 'Big Tech', tickers: 'AAPL,MSFT,GOOGL,META,AMZN', icon: Cpu },
  { label: 'Big Banks', tickers: 'JPM,BAC,WFC,C,GS', icon: Landmark },
  { label: 'Semiconductors', tickers: 'NVDA,AMD,INTC,AVGO,QCOM', icon: Cpu },
  { label: 'U.S. Airlines', tickers: 'DAL,UAL,AAL,LUV', icon: Plane },
];

const WORKFLOWS = [
  { label: 'Audit a number', text: 'Trace any reported metric to the exact XBRL concept, fiscal period, filing, and accession.' },
  { label: 'Read the company', text: 'Move from filing pulse to financial trend to risk language without changing tools.' },
  { label: 'Compare with evidence', text: 'Line up peers using standardized statements, industry ratios, and source-linked values.' },
];

export default function LandingPage() {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <div className="professional-card relative overflow-hidden p-6 sm:p-8 lg:p-10">
          <div className="absolute -right-28 -top-28 h-72 w-72 rounded-full bg-amber-400/20 blur-3xl" />
          <div className="relative">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.24em] text-amber-200">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
              SEC public filings explorer
            </div>

            <h1 className="max-w-4xl text-4xl font-black tracking-tight text-white sm:text-5xl lg:text-7xl">
              Public-company research, rebuilt around the source filing.
            </h1>

            <p className="mt-5 max-w-3xl text-base leading-8 text-slate-300 sm:text-lg">
              SEC filings and financial data, without the noise. Read the actual filings, see reported financials, compare peers, track insiders, and search disclosures. Every number cites its XBRL source on SEC.gov.
            </p>

            <div className="mt-7 max-w-3xl rounded-3xl border border-white/10 bg-slate-950/70 p-3 shadow-2xl shadow-black/30">
              <HeroSearch />
            </div>

            <div className="mt-6 grid gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400 sm:grid-cols-2 xl:grid-cols-4">
              <span className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2"><Database className="h-4 w-4 text-amber-300" />Live SEC.gov data</span>
              <span className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2"><Shield className="h-4 w-4 text-emerald-300" />No login</span>
              <span className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2"><Zap className="h-4 w-4 text-sky-300" />Source-linked</span>
              <span className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2"><ExternalLink className="h-4 w-4 text-violet-300" />Free access</span>
            </div>
          </div>
        </div>

        <div className="professional-card overflow-hidden p-4 sm:p-5">
          <div className="rounded-2xl border border-white/10 bg-slate-950/80 p-4">
            <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-3">
              <div>
                <div className="eyebrow">Research workspace</div>
                <div className="mt-1 text-lg font-black text-white">AAPL · Apple Inc.</div>
              </div>
              <div className="rounded-full bg-emerald-400/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-emerald-200">SEC linked</div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {['Filing pulse', 'XBRL facts', 'Disclosure radar'].map((label, idx) => (
                <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.035] p-3">
                  <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">{label}</div>
                  <div className="mt-3 h-2 rounded-full bg-slate-800">
                    <div className="h-2 rounded-full bg-amber-300" style={{ width: `${74 - idx * 12}%` }} />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-black text-white"><LayoutDashboard className="h-4 w-4 text-amber-300" /> Analysis chunks</div>
                {['Snapshot', 'Filings & Risk', 'Quality', 'Financials', 'Market', 'Ownership'].map((item) => (
                  <div key={item} className="mb-2 flex items-center justify-between rounded-xl bg-slate-900/70 px-3 py-2 text-xs font-bold text-slate-300">
                    {item}<ArrowRight className="h-3 w-3 text-slate-600" />
                  </div>
                ))}
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                <div className="mb-4 flex items-center justify-between">
                  <div className="text-sm font-black text-white">Financial trend</div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">10-year view</div>
                </div>
                <div className="flex h-44 items-end gap-2">
                  {[38, 48, 44, 58, 62, 67, 75, 83, 78, 92].map((height, idx) => (
                    <div key={idx} className="flex-1 rounded-t-xl bg-gradient-to-t from-amber-500/40 to-amber-200" style={{ height: `${height}%` }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-4 md:grid-cols-3">
        {WORKFLOWS.map((workflow) => (
          <div key={workflow.label} className="panel-card p-5">
            <div className="eyebrow mb-3">Workflow</div>
            <h2 className="text-xl font-black text-white">{workflow.label}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{workflow.text}</p>
          </div>
        ))}
      </section>

      <section className="mt-10">
        <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <div className="eyebrow">Start here</div>
            <h2 className="mt-2 text-2xl font-black text-white">Try it with a familiar company</h2>
          </div>
          <span className="text-sm text-slate-500">One click into analysis, filings, peer comparison, and disclosure research.</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURED_TICKERS.map((t) => (
            <Link key={t.ticker} href={`/analysis/${t.ticker}`} className="group panel-card block p-5 transition hover:-translate-y-1 hover:border-amber-300/40">
              <div className="flex items-start justify-between">
                <span className="text-3xl font-black tracking-tight text-white group-hover:text-amber-200">{t.ticker}</span>
                <ArrowRight className="h-5 w-5 text-slate-600 transition group-hover:translate-x-1 group-hover:text-amber-300" />
              </div>
              <div className="mt-3 text-sm font-bold text-slate-300">{t.name}</div>
              <div className="mt-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">{t.industry}</div>
              <div className="mt-3 text-xs leading-5 text-slate-500">{t.caption}</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <div className="mb-4">
          <div className="eyebrow">What you can do</div>
          <h2 className="mt-2 text-2xl font-black text-white">Seven professional research surfaces</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {FEATURE_GRID.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="panel-card group p-5 transition hover:-translate-y-1 hover:border-amber-300/35">
                <div className="mb-4 grid h-11 w-11 place-items-center rounded-2xl border border-amber-300/20 bg-amber-300/10">
                  <Icon className="h-5 w-5 text-amber-200" />
                </div>
                <h3 className="text-sm font-black uppercase tracking-[0.18em] text-white">{feature.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-400">{feature.description}</p>
                <Link href={feature.link} className="mt-4 inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-amber-200 transition group-hover:gap-3">
                  {feature.linkLabel}
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-10 grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="professional-card p-6 sm:p-8">
          <div className="eyebrow">Why another SEC tool?</div>
          <h2 className="mt-3 text-2xl font-black text-white">Built for people who want to check the footnotes.</h2>
          <p className="mt-4 text-sm leading-7 text-slate-400">
            Most financial tools tell you what the numbers are. This one shows you where they came from. Every value on every page links to the exact XBRL tag, filing, and accession number on SEC.gov.
          </p>
          <div className="mt-6 space-y-3">
            <DifferentiatorRow label="Source-linked" text="Every value shows its XBRL tag, filing date, and accession number" />
            <DifferentiatorRow label="Industry-aware" text="Banks get bank ratios, tech gets tech ratios, retail gets retail ratios" />
            <DifferentiatorRow label="No account needed" text="No login, no email capture, no paywall — just the data" />
            <DifferentiatorRow label="Research-grade" text="Built for analysts, students, and curious readers of 10-Ks" />
          </div>
        </div>

        <div className="professional-card p-6 sm:p-8">
          <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <div className="eyebrow">Compare peer groups instantly</div>
              <h2 className="mt-2 text-2xl font-black text-white">Side-by-side in one click</h2>
            </div>
            <Search className="hidden h-6 w-6 text-slate-600 sm:block" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {PEER_GROUP_SAMPLES.map((g) => {
              const Icon = g.icon;
              return (
                <Link key={g.label} href={`/compare/${g.tickers}`} className="group flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4 transition hover:-translate-y-1 hover:border-amber-300/40">
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-slate-900 text-amber-200">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-black uppercase tracking-[0.14em] text-white group-hover:text-amber-200">{g.label}</div>
                    <div className="mt-1 truncate text-xs text-slate-500">{g.tickers}</div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:translate-x-1 group-hover:text-amber-300" />
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mt-10 professional-card p-6 text-center sm:p-8">
        <h2 className="text-2xl font-black text-white">Pick any ticker to begin.</h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-400">
          There are over 10,000 publicly traded U.S. companies in the SEC database. Type any of them above, or start with a featured example.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href="/filings/AAPL" className="primary-button"><FileText className="h-4 w-4" />Browse Filings</Link>
          <Link href="/analysis/AAPL" className="secondary-button"><BarChart3 className="h-4 w-4" />View Analysis</Link>
          <Link href="/compare/AAPL,MSFT,GOOGL,META,AMZN" className="secondary-button"><GitCompare className="h-4 w-4" />Compare Peers</Link>
          <Link href="/disclosures" className="secondary-button"><FileSearch className="h-4 w-4" />Search Disclosures</Link>
        </div>
      </section>
    </>
  );
}

function DifferentiatorRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3">
      <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-300" />
      <div>
        <div className="text-xs font-black uppercase tracking-[0.16em] text-white">{label}</div>
        <div className="mt-1 text-sm leading-6 text-slate-400">{text}</div>
      </div>
    </div>
  );
}
