import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import LandingPage from './page-components/LandingPage.jsx';
import FundPage from './page-components/FundPage.jsx';
import AboutPage from './page-components/AboutPage.jsx';
import CryptoPage from './page-components/CryptoPage.jsx';
import { loadClassifiedTickerMap } from './utils/tickerMapLoader.js';

// ============================================================================
// TickerContext — kept here during the migration because some unmigrated
// pages (Fund) still import it from '../App.jsx'. Once those pages are
// migrated, this context moves to src/contexts/ (there's already a
// duplicate there for the Next.js layout to use).
// ============================================================================
export const TickerContext = React.createContext(null);

// ============================================================================
// Legacy catch-all root
//
// Phase 1: chrome moved to layout.tsx
// Phase 2a: /filings migrated
// Phase 2b: /analysis migrated
// Phase 2c: /compare migrated
//
// Remaining pages still served by this React Router shell: Landing, Fund,
// Crypto, About. As each migrates, its Route entry disappears. When all
// pages are migrated, this file is deleted entirely.
// ============================================================================
export default function App() {
  const [ticker, setTicker] = useState('');
  const [tickerMap, setTickerMap] = useState(null);
  const [company, setCompany] = useState(null);

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
            {/* /compare and /compare/:tickers moved to Next.js App Router (src/app/compare/) */}
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
