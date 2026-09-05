'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home, FileText, BarChart3, ShieldAlert, GitCompare, Wallet, FileSearch, Info, Activity,
  type LucideIcon,
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

function topTabClasses(isActive: boolean): string {
  return `group inline-flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[11px] font-black uppercase tracking-[0.18em] transition-all duration-200 ${
    isActive
      ? 'border-amber-300/60 bg-amber-300 text-slate-950 shadow-lg shadow-amber-950/30'
      : 'border-white/10 bg-white/[0.035] text-slate-400 hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.06] hover:text-slate-100'
  }`;
}

export default function NavTabs() {
  const pathname = usePathname() || '/';
  const isScrolled = usePageScrolled(96);

  return (
    <div
      className={`transition-all duration-300 ease-out ${
        isScrolled
          ? 'mt-0 max-h-0 -translate-y-2 overflow-hidden opacity-0 pointer-events-none'
          : 'mt-3 max-h-20 translate-y-0 opacity-100'
      }`}
    >
      <nav className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => {
          const isActive = item.matchPath(pathname);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={topTabClasses(isActive)}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={2.5} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
