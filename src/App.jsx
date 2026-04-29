import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { loadClassifiedTickerMap } from './utils/tickerMapLoader.js';

// ============================================================================
// TickerContext — kept here for backwards compatibility with any code that
// still imports it from '../App.jsx'. The Next.js layer also has its own
// TickerProvider in src/contexts/TickerContext.tsx; that's the one used by
// migrated pages. Once all imports of THIS context are confirmed gone, this
// file can be deleted entirely.
// ============================================================================
export const TickerContext = React.createContext(null);

// ============================================================================
// Legacy catch-all root — final reduced state
//
// Phase 1: chrome moved to layout.tsx
// Phase 2a: /filings migrated
// Phase 2b: /analysis migrated
// Phase 2c: /compare migrated
// Phase 2d: / (Landing) migrated
// Phase 2e: /about, /crypto, /fund migrated
//
// At this point ALL pages are served by Next.js App Router. This file
// remains only because the [...slug] catch-all in src/app/[...slug]/page.tsx
// still mounts App.jsx for any unmatched URL — a safety net that redirects
// typo'd URLs to the homepage. Once confirmed safe to remove (see cleanup
// pass after Phase 2e), this entire file plus the [...slug] catch-all
// directory will be deleted, along with the react-router-dom dependency.
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
            {/* All page routes now served by Next.js App Router (src/app/) */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </TickerContext.Provider>
    </HelmetProvider>
  );
}
