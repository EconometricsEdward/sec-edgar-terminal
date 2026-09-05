'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home, FileText, BarChart3, ShieldAlert, GitCompare, Wallet, FileSearch, Info, Activity,
  ChevronLeft, ChevronRight, type LucideIcon,
} from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  matchPath: (pathname: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', icon: Home, matchPath: (p) => p === '/' },
  { href: '/workspace', label: 'Workspace', icon: BarChart3, matchPath: (p) => p === '/workspace' },
  { href: '/filings', label: 'Filings', icon: FileText, matchPath: (p) => p === '/filings' || p.startsWith('/filings/') },
  { href: '/analysis', label: 'Analysis', icon: BarChart3, matchPath: (p) => p === '/analysis' || p.startsWith('/analysis/') },
  { href: '/market', label: 'Market', icon: Activity, matchPath: (p) => p === '/market' || p.startsWith('/market/') },
  { href: '/risk', label: 'Risk', icon: ShieldAlert, matchPath: (p) => p === '/risk' || p.startsWith('/risk/') },
  { href: '/compare', label: 'Compare', icon: GitCompare, matchPath: (p) => p === '/compare' || p.startsWith('/compare/') },
  { href: '/fund', label: 'Funds', icon: Wallet, matchPath: (p) => p === '/fund' || p.startsWith('/fund/') },
  { href: '/disclosures', label: 'Disclosures', icon: FileSearch, matchPath: (p) => p === '/disclosures' },
  { href: '/about', label: 'About', icon: Info, matchPath: (p) => p === '/about' },
];

const NAV_RAIL_STORAGE_KEY = 'edgar-terminal:floating-nav-minimized';

function readScrollDepth(): number {
  if (typeof window === 'undefined') return 0;

  const root = document.scrollingElement as HTMLElement | null;
  const html = document.documentElement;
  const body = document.body;

  let depth = Math.max(
    window.scrollY || 0,
    root?.scrollTop || 0,
    html?.scrollTop || 0,
    body?.scrollTop || 0
  );

  if (depth > 96) return depth;

  // Some local layouts scroll an inner shell instead of window.
  // This makes the rail respond regardless of which container owns scroll.
  const candidates = document.querySelectorAll<HTMLElement>('main, section, div');
  for (const el of candidates) {
    if (el.scrollHeight > el.clientHeight + 96 && el.scrollTop > depth) {
      depth = el.scrollTop;
      if (depth > 96) break;
    }
  }

  return depth;
}

function usePageScrolled(threshold = 96): boolean {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    let frame = 0;

    const update = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setIsScrolled(readScrollDepth() > threshold);
      });
    };

    update();

    window.addEventListener('scroll', update, { passive: true });
    document.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);

    // Fallback for any custom scroll container that does not emit through window.
    const interval = window.setInterval(update, 500);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      document.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.clearInterval(interval);
    };
  }, [threshold]);

  return isScrolled;
}

function railTabClasses(isActive: boolean): string {
  return `group/rail relative grid h-12 w-12 place-items-center rounded-2xl border transition-all duration-200 ${
    isActive
      ? 'border-amber-300/70 bg-amber-300 text-slate-950 shadow-xl shadow-amber-950/40'
      : 'border-white/10 bg-slate-950/80 text-slate-400 shadow-lg shadow-black/30 hover:-translate-y-0.5 hover:border-white/25 hover:bg-slate-900 hover:text-slate-100'
  }`;
}

export default function FloatingNavRail() {
  const pathname = usePathname() || '/';
  const isScrolled = usePageScrolled(96);
  const [isMinimized, setIsMinimized] = useState(false);

  useEffect(() => {
    try {
      setIsMinimized(window.localStorage.getItem(NAV_RAIL_STORAGE_KEY) === 'true');
    } catch {
      // Keep the default expanded state when storage is unavailable.
    }
  }, []);

  const updateMinimized = (nextValue: boolean) => {
    setIsMinimized(nextValue);
    try {
      window.localStorage.setItem(NAV_RAIL_STORAGE_KEY, String(nextValue));
    } catch {
      // The control still works for the current page when storage is unavailable.
    }
  };

  const showRail = isScrolled && !isMinimized;
  const showRestoreButton = isScrolled && isMinimized;

  return (
    <>
      <nav
        id="floating-primary-navigation"
        className={`fixed left-4 top-1/2 z-[90] hidden -translate-y-1/2 flex-col items-center gap-2 rounded-[1.6rem] border border-white/10 bg-[#070a12]/92 p-2 shadow-2xl shadow-black/50 backdrop-blur-2xl transition-all duration-300 md:flex ${
          showRail
            ? 'translate-x-0 opacity-100'
            : 'pointer-events-none -translate-x-24 opacity-0'
        }`}
        aria-label="Floating primary navigation"
        aria-hidden={!showRail}
      >
        <div className="mb-1 mt-1 h-1.5 w-1.5 rounded-full bg-amber-300 shadow-[0_0_18px_rgba(252,211,77,.9)]" />

        {NAV_ITEMS.map((item) => {
          const isActive = item.matchPath(pathname);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={railTabClasses(isActive)}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              title={item.label}
              tabIndex={showRail ? 0 : -1}
            >
              <Icon className="h-4 w-4" strokeWidth={2.5} />
              <span className="pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded-full border border-white/10 bg-slate-950/95 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-slate-200 opacity-0 shadow-xl shadow-black/40 transition-all duration-200 group-hover/rail:translate-x-1 group-hover/rail:opacity-100">
                {item.label}
              </span>
            </Link>
          );
        })}

        <div className="mt-1 border-t border-white/10 pt-2">
          <button
            type="button"
            onClick={() => updateMinimized(true)}
            className="group/rail relative grid h-9 w-12 place-items-center rounded-xl border border-white/10 bg-white/[0.025] text-slate-500 transition-all duration-200 hover:border-white/20 hover:bg-white/[0.06] hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70"
            aria-label="Minimize navigation menu"
            aria-controls="floating-primary-navigation"
            title="Minimize navigation"
            tabIndex={showRail ? 0 : -1}
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
            <span className="pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded-full border border-white/10 bg-slate-950/95 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-slate-200 opacity-0 shadow-xl shadow-black/40 transition-all duration-200 group-hover/rail:translate-x-1 group-hover/rail:opacity-100">
              Minimize
            </span>
          </button>
        </div>
      </nav>

      <button
        type="button"
        onClick={() => updateMinimized(false)}
        className={`fixed left-0 top-1/2 z-[91] hidden h-12 w-9 -translate-y-1/2 place-items-center rounded-r-2xl border border-l-0 border-white/10 bg-[#070a12]/92 text-slate-400 shadow-xl shadow-black/40 backdrop-blur-2xl transition-all duration-300 hover:w-10 hover:border-white/20 hover:bg-slate-900 hover:text-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70 md:grid ${
          showRestoreButton
            ? 'translate-x-0 opacity-100'
            : 'pointer-events-none -translate-x-6 opacity-0'
        }`}
        aria-label="Restore navigation menu"
        aria-controls="floating-primary-navigation"
        aria-expanded={!isMinimized}
        title="Show navigation"
        tabIndex={showRestoreButton ? 0 : -1}
      >
        <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
      </button>
    </>
  );
}
