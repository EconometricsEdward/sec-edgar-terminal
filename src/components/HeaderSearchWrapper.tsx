'use client';

import { usePathname } from 'next/navigation';
import GlobalSearchBar from './GlobalSearchBar.jsx';

// On the landing page, LandingPage renders its own large hero search — so
// the compact header search is redundant and looks cluttered. Everywhere
// else, this wrapper renders the global search bar that appears under the
// nav tabs. Design decision per user: landing has its own dedicated search.
export default function HeaderSearchWrapper() {
  const pathname = usePathname() || '/';
  if (pathname === '/') return null;

  return (
    <div className="mt-4">
      <GlobalSearchBar />
    </div>
  );
}