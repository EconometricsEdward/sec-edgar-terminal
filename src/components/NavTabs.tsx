'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  FileText,
  BarChart3,
  GitCompare,
  Wallet,
  Bitcoin,
  Info,
} from 'lucide-react';
import { ReactNode } from 'react';

// ============================================================================
// Tab definitions
//
// `matchPath` decides when this tab should be rendered as active.
//   - Home matches "/" exactly — not "/filings", not anything else
//   - Every other tab matches its prefix — "/analysis" active for both
//     "/analysis" and "/analysis/AAPL"
//
// This replaces the React Router `NavLink end={true}` pattern used in the
// old App.jsx.
// ============================================================================

interface Tab {
  href: string;
  label: string;
  icon: ReactNode;
  matchPath: (pathname: string) => boolean;
}

const TABS: Tab[] = [
  {
    href: '/',
    label: 'Home',
    icon: <Home className="w-4 h-4" />,
    matchPath: (p) => p === '/',
  },
  {
    href: '/filings',
    label: 'Filings',
    icon: <FileText className="w-4 h-4" />,
    matchPath: (p) => p === '/filings' || p.startsWith('/filings/'),
  },
  {
    href: '/analysis',
    label: 'Analysis',
    icon: <BarChart3 className="w-4 h-4" />,
    matchPath: (p) => p === '/analysis' || p.startsWith('/analysis/'),
  },
  {
    href: '/compare',
    label: 'Compare',
    icon: <GitCompare className="w-4 h-4" />,
    matchPath: (p) => p === '/compare' || p.startsWith('/compare/'),
  },
  {
    href: '/fund',
    label: 'Funds',
    icon: <Wallet className="w-4 h-4" />,
    matchPath: (p) => p === '/fund' || p.startsWith('/fund/'),
  },
  {
    href: '/crypto',
    label: 'Crypto',
    icon: <Bitcoin className="w-4 h-4" />,
    matchPath: (p) => p === '/crypto' || p.startsWith('/crypto/'),
  },
  {
    href: '/about',
    label: 'About',
    icon: <Info className="w-4 h-4" />,
    matchPath: (p) => p === '/about' || p.startsWith('/about/'),
  },
];

// ============================================================================
// Component
// ============================================================================

export default function NavTabs() {
  const pathname = usePathname() || '/';

  return (
    <nav className="mt-6 flex gap-1 flex-wrap">
      {TABS.map((tab) => {
        const isActive = tab.matchPath(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex items-center gap-2 px-5 py-2.5 text-xs uppercase tracking-[0.2em] font-bold border-2 transition-colors ${
              isActive
                ? 'bg-amber-500 text-stone-950 border-amber-500'
                : 'bg-stone-900 text-stone-400 border-stone-800 hover:border-stone-700 hover:text-stone-200'
            }`}
          >
            {tab.icon}
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}