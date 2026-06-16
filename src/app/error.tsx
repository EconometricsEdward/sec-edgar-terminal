'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowRight, BarChart3, FileSearch, Home, RotateCcw } from 'lucide-react';

const RECOVERY_LINKS = [
  {
    href: '/analysis/AAPL',
    label: 'Open Analysis',
    description: 'Return to a known-good financial analysis page',
    icon: BarChart3,
  },
  {
    href: '/disclosures',
    label: 'Search Disclosures',
    description: 'Search SEC filing language and source excerpts',
    icon: FileSearch,
  },
];

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="py-8 md:py-12">
      <div className="max-w-3xl">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-5 h-5 text-rose-400" />
          <span className="text-[10px] uppercase tracking-[0.3em] text-rose-300 font-bold">
            Error / Recovery
          </span>
        </div>

        <h1 className="text-3xl md:text-5xl font-black tracking-tight text-stone-100 mb-4 leading-tight">
          This view could not finish loading.
        </h1>

        <p className="text-sm md:text-base text-stone-400 leading-relaxed mb-6 max-w-2xl">
          EDGAR Terminal hit a page-level error while preparing this view. You can retry the
          same request, return home, or move to another research surface.
        </p>

        <div className="flex flex-wrap gap-2 mb-8">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Retry
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 border-2 border-stone-700 hover:border-amber-500 text-stone-200 hover:text-amber-400 font-black uppercase tracking-widest text-xs transition-colors"
          >
            <Home className="w-4 h-4" />
            Home
          </Link>
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
                <Icon className="w-5 h-5 shrink-0 text-amber-400" />
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

        {error.digest && (
          <div className="mt-6 border border-stone-800 bg-stone-950/60 px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold mb-1">
              Diagnostic
            </div>
            <p className="text-xs text-stone-500 break-words">Digest: {error.digest}</p>
          </div>
        )}
      </div>
    </section>
  );
}
