'use client';

import { usePathname } from 'next/navigation';
import GlobalSearchBar from './GlobalSearchBar.jsx';

export default function HeaderSearchWrapper() {
  const pathname = usePathname() || '/';
  if (pathname === '/') return null;

  return (
    <div className="header-command-search w-full">
      <GlobalSearchBar />
    </div>
  );
}
