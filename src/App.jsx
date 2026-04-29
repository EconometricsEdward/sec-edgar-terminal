import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import LandingPage from './page-components/LandingPage.jsx';
import ComparePage from './page-components/ComparePage.jsx';
import FundPage from './page-components/FundPage.jsx';
import AboutPage from './page-components/AboutPage.jsx';
import CryptoPage from './page-components/CryptoPage.jsx';
import { loadClassifiedTickerMap } from './utils/tickerMapLoader.js';

// ============================================================================
// TickerContext — kept here during the migration because some unmigrated
// pages (Compare, Fund) still import it from '../App.jsx'. Once
// those pages are migrated, this context moves to src/contexts/ (there's
// already a duplicate there for the Next.js layout to use).
// ============================================================================
export const TickerContext = React.createContext(null);

// ============================================================================
// Legacy catch-all root
//
// Before Phase 1: this file owned the whole app — chrome (header, nav,
// search, footer, background grid), routing, context. Everything rendered
// through a client-side BrowserRouter.
//
// Phase 1 moved the chrome into Next.js's layout.tsx so it could be
// server-rendered for SEO.
//
// Phase 2a moved /filings and /filings/[ticker] into dedicated App Router
// routes (src/app/filings/).
//
// Phase 2b moved /analysis and /analysis/[ticker] into dedicated App
// Router routes (src/app/analysis/).
//
// What remains here: a minimal React Router shell that handles the
// not-yet-migrated pages via Next.js's [[...slug]] catch-all route. As
// each remaining page (Landing, Compare, Fund, Crypto, About) migrates
// to App Router, its Route entry disappears from this file. When all
// pages are migrated, this file is deleted entirely.
// ============================================================================
export default function App() {
  const [ticker, setTicker] = useState('');
  const [tickerMap, setTickerMap] = useState(null);
  const [company, setCompany] = useState(null);

  // Preload the classified ticker map on app mount. This is now redundant
  // with the Next.js-side TickerProvider (src/contexts/TickerContext.tsx),
  // which also loads it — two loads hit the same in-flight fetch dedupe via
  // the browser's HTTP cache, so it's cheap. Once all pages are migrated
  // and this file is deleted, only the Next.js TickerProvider will remain.
  useEffect(() => {
    let cancelled = false;
    loadClassifiedTickerMap().then((map) => {
      if (!cancelled) setTickerMap(map);
    }).catch(() => {
      // silent — pages that need ticker data can retry
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <HelmetProvider>
      <TickerContext.Provider value={{ ticker, setTicker, tickerMap, setTickerMap, company, setCompany }}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            {/* /filings and /filings/:ticker moved to Next.js App Router (src/app/filings/) */}
            {/* /analysis and /analysis/:ticker moved to Next.js App Router (src/app/analysis/) */}
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/compare/:tickers" element={<ComparePage />} />
            <Route path="/fund" element={<FundPage />} />
            <Route path="/fund/:ticker" element={<FundPage />} />
            <Route path="/crypto" element={<CryptoPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<LandingPage />} />
          </Routes>
        </BrowserRouter>
      </TickerContext.Provider>
    </HelmetProvider>
  );
}
