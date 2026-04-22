'use client';

import React, { createContext, useState, useEffect, ReactNode } from 'react';
import { loadClassifiedTickerMap } from '../utils/tickerMapLoader.js';

// ============================================================================
// Types
// ============================================================================

export interface TickerEntry {
  cik: string;
  name: string;
  ticker: string;
  isFund: boolean;
}

export type TickerMap = Record<string, TickerEntry>;

export interface Company {
  name: string;
  cik: string;
  sic?: string;
  sicNumber?: string | number;
  exchanges?: string;
  tickers?: string;
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  ein?: string;
}

export interface TickerContextValue {
  ticker: string;
  setTicker: (t: string) => void;
  tickerMap: TickerMap | null;
  setTickerMap: (m: TickerMap | null) => void;
  company: Company | null;
  setCompany: (c: Company | null) => void;
}

// ============================================================================
// Context
// ============================================================================

// We export `null` as the default so consumers who forget to wrap with the
// provider get an explicit error rather than silently receiving stale state.
export const TickerContext = createContext<TickerContextValue | null>(null);

// ============================================================================
// Provider — wraps the app with state and auto-loads the ticker map on mount
// ============================================================================

export function TickerProvider({ children }: { children: ReactNode }) {
  const [ticker, setTicker] = useState<string>('');
  const [tickerMap, setTickerMap] = useState<TickerMap | null>(null);
  const [company, setCompany] = useState<Company | null>(null);

  // Preload the classified ticker map on mount. Same behavior as the old
  // App.jsx useEffect, just now lives with the context that owns it.
  useEffect(() => {
    let cancelled = false;
    loadClassifiedTickerMap()
      .then((map) => {
        if (!cancelled) setTickerMap(map as TickerMap);
      })
      .catch(() => {
        // Silent — pages that need ticker data can retry
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TickerContext.Provider
      value={{ ticker, setTicker, tickerMap, setTickerMap, company, setCompany }}
    >
      {children}
    </TickerContext.Provider>
  );
}