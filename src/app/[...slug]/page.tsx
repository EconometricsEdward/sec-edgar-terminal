'use client';

// ============================================================================
// Day 1 catch-all route
//
// This renders your existing App.jsx (with its BrowserRouter) as a client
// component at every URL. Next.js sees every request as matching this route —
// which is the whole point. React Router then takes over client-side to
// actually route based on the URL.
//
// On Day 2, this file will be deleted and replaced with proper App Router
// pages (app/filings/[ticker]/page.jsx, etc.) each with their own
// generateMetadata for real server-rendered SEO. But for Day 1, this is
// the minimal-change path to get Next.js running in place of Vite.
//
// The 'use client' directive is required because App.jsx uses BrowserRouter,
// which relies on browser APIs that aren't available during server rendering.
// ============================================================================

import dynamic from 'next/dynamic';

// Import App.jsx with SSR disabled.
//
// Why disable SSR: BrowserRouter throws during server rendering because it
// expects `window` and `document`. We could use StaticRouter on the server,
// but that adds complexity for no Day 1 benefit — the whole point of Day 1
// is to change as little as possible. SSR is re-enabled on Day 2 when we
// switch to Next.js's native routing.
//
// Loading state shows briefly on first render; it uses the same stone-950
// background as the app to avoid a visible flash.
const App = dynamic(() => import('../../App.jsx'), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-stone-950" aria-label="Loading application" />
  ),
});

export default function Page() {
  return <App />;
}
