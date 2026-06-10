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
// Every route is now a Next.js App Router route, so all nav items use
// Next.js <Link> for soft navigation. The `legacy` flag from the migration
// era is no longer needed — that distinction is gone.
// ============================================================================
interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  matchPath: (pathname: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    label: 'Home',
    icon: Home,
    matchPath: (p) => p === '/',
  },
  {
    href: '/filings',
    label: 'Filings',
    icon: FileText,
    matchPath: (p) => p === '/filings' || p.startsWith('/filings/'),
  },
  {
    href: '/analysis',
    label: 'Analysis',
    icon: BarChart3,
    matchPath: (p) => p === '/analysis' || p.startsWith('/analysis/'),
  },
  {
    href: '/compare',
    label: 'Compare',
    icon: GitCompare,
    matchPath: (p) => p === '/compare' || p.startsWith('/compare/'),
  },
  {
    href: '/fund',
    label: 'Funds',
    icon: Wallet,
    matchPath: (p) => p === '/fund' || p.startsWith('/fund/'),
  },
  {
    href: '/crypto',
    label: 'Crypto',
    icon: Bitcoin,
    matchPath: (p) => p === '/crypto',
  },
  {
    href: '/about',
    label: 'About',
    icon: Info,
    matchPath: (p) => p === '/about',
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
        return (
          <Link key={item.href} href={item.href} className={tabClasses(isActive)}>
            <Icon className="w-4 h-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
