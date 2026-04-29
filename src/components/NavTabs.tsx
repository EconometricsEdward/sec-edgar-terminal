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
// All routes are now App Router routes — every entry is `legacy: false`.
// The legacy flag is preserved for now because the type system still uses
// it, and there's a non-zero chance we'd want to roll something back.
// In a future cleanup pass we can drop the flag entirely and simplify.
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
    legacy: false, // Migrated to App Router in Phase 2d
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
    legacy: false, // Migrated to App Router in Phase 2e
  },
  {
    href: '/crypto',
    label: 'Crypto',
    icon: Bitcoin,
    matchPath: (p) => p === '/crypto',
    legacy: false, // Migrated to App Router in Phase 2e
  },
  {
    href: '/about',
    label: 'About',
    icon: Info,
    matchPath: (p) => p === '/about',
    legacy: false, // Migrated to App Router in Phase 2e
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

        // Legacy routes use <a> to force full page reload; migrated routes
        // use Next.js <Link> for soft navigation. After Phase 2e all entries
        // are non-legacy, so this branch is preserved only for safety while
        // the App.jsx catch-all transition settles.
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
