'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home, FileText, BarChart3, GitCompare, Wallet, Bitcoin, Info,
  type LucideIcon,
} from 'lucide-react';

// ============================================================================
// Nav item descriptor
//
// `legacy: true` means the target route still renders through App.jsx
// (src/App.jsx + react-router-dom + BrowserRouter). For those routes we use
// a plain <a> tag so the browser does a full page load — this causes
// BrowserRouter to re-initialize with the correct URL, avoiding a stale-
// location bug where clicking "About" would render "Landing" because
// BrowserRouter hadn't noticed the URL changed.
//
// `legacy: false` means the route has its own App Router page under
// src/app/<route>/. For those we can use Next.js's <Link> for fast client-
// side navigation.
//
// As each page migrates in Phase 2, flip its `legacy` from true to false.
// When all pages are migrated and App.jsx is deleted, every entry should
// be `legacy: false` (and we can drop the flag entirely).
// ============================================================================
interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  matchPath: (pathname: string) => boolean;
  legacy: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    label: 'Home',
    icon: Home,
    matchPath: (p) => p === '/',
    legacy: true, // LandingPage still served by App.jsx
  },
  {
    href: '/filings',
    label: 'Filings',
    icon: FileText,
    matchPath: (p) => p === '/filings' || p.startsWith('/filings/'),
    legacy: false, // Migrated to App Router in Phase 2a
  },
  {
    href: '/analysis',
    label: 'Analysis',
    icon: BarChart3,
    matchPath: (p) => p === '/analysis' || p.startsWith('/analysis/'),
    legacy: false, // Migrated to App Router in Phase 2b
  },
  {
    href: '/compare',
    label: 'Compare',
    icon: GitCompare,
    matchPath: (p) => p === '/compare' || p.startsWith('/compare/'),
    legacy: false, // Migrated to App Router in Phase 2c
  },
  {
    href: '/fund',
    label: 'Funds',
    icon: Wallet,
    matchPath: (p) => p === '/fund' || p.startsWith('/fund/'),
    legacy: true,
  },
  {
    href: '/crypto',
    label: 'Crypto',
    icon: Bitcoin,
    matchPath: (p) => p === '/crypto',
    legacy: true,
  },
  {
    href: '/about',
    label: 'About',
    icon: Info,
    matchPath: (p) => p === '/about',
    legacy: true,
  },
];

function tabClasses(isActive: boolean): string {
  return `flex items-center gap-2 px-5 py-2.5 text-xs uppercase tracking-[0.2em] font-bold border-2 transition-colors ${
    isActive
      ? 'bg-amber-500 text-stone-950 border-amber-500'
      : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700 hover:text-stone-200'
  }`;
}

export default function NavTabs() {
  const pathname = usePathname() || '/';

  return (
    <nav className="mt-6 flex gap-1 flex-wrap">
      {NAV_ITEMS.map((item) => {
        const isActive = item.matchPath(pathname);
        const Icon = item.icon;
        const className = tabClasses(isActive);

        // Legacy routes use <a> to force full page reload so App.jsx's
        // BrowserRouter re-initializes from the current URL. Migrated
        // routes use Next.js <Link> for soft navigation.
        if (item.legacy) {
          return (
            <a key={item.href} href={item.href} className={className}>
              <Icon className="w-4 h-4" />
              {item.label}
            </a>
          );
        }

        return (
          <Link key={item.href} href={item.href} className={className}>
            <Icon className="w-4 h-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
