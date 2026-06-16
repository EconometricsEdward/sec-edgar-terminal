import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  FileSearch,
  FileText,
  GitCompare,
  Home,
  SearchX,
  Wallet,
} from 'lucide-react';

const RECOVERY_LINKS = [
  {
    href: '/analysis/AAPL',
    label: 'Analyze AAPL',
    description: 'Financial statements, ratios, filings, insiders',
    icon: BarChart3,
    accent: 'text-amber-400',
  },
  {
    href: '/filings/AAPL',
    label: 'Browse Filings',
    description: '10-K, 10-Q, 8-K, Form 4, proxy statements',
    icon: FileText,
    accent: 'text-sky-400',
  },
  {
    href: '/compare/AAPL,MSFT,GOOGL,META,AMZN',
    label: 'Compare Big Tech',
    description: 'Side-by-side company fundamentals',
    icon: GitCompare,
    accent: 'text-emerald-400',
  },
  {
    href: '/disclosures',
    label: 'Search Disclosures',
    description: 'Risk, topic, and filing-language discovery',
    icon: FileSearch,
    accent: 'text-violet-400',
  },
  {
    href: '/fund/SPY',
    label: 'Open Fund View',
    description: 'ETF and mutual fund holdings from N-PORT',
    icon: Wallet,
    accent: 'text-rose-400',
  },
];

export default function NotFound() {
  return (
    <section className="py-8 md:py-12">
      <div className="max-w-3xl">
        <div className="flex items-center gap-2 mb-3">
          <SearchX className="w-5 h-5 text-amber-400" />
          <span className="text-[10px] uppercase tracking-[0.3em] text-amber-400 font-bold">
            404 / Not Found
          </span>
        </div>

        <h1 className="text-3xl md:text-5xl font-black tracking-tight text-stone-100 mb-4 leading-tight">
          This EDGAR path did not resolve.
        </h1>

        <p className="text-sm md:text-base text-stone-400 leading-relaxed mb-6 max-w-2xl">
          The requested URL does not match a live EDGAR Terminal page. The site has kept you
          here instead of silently sending you to the homepage, so the missing route is clear.
        </p>

        <div className="flex flex-wrap gap-2 mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors"
          >
            <Home className="w-4 h-4" />
            Home
          </Link>
          <Link
            href="/analysis"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors"
          >
            <BarChart3 className="w-4 h-4" />
            Analysis
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {RECOVERY_LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className="group flex items-center gap-4 border-2 border-stone-800 bg-stone-900/30 p-4 hover:border-amber-500/60 transition-colors"
            >
              <Icon className={`w-5 h-5 shrink-0 ${link.accent}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black uppercase tracking-wider text-stone-100 group-hover:text-amber-300 transition-colors">
                  {link.label}
                </div>
                <div className="text-xs text-stone-500 leading-relaxed">{link.description}</div>
              </div>
              <ArrowRight className="w-4 h-4 text-stone-600 group-hover:text-amber-400 shrink-0 transition-colors" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
