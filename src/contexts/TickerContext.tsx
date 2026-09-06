"use client";

import React, {
  createContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import { loadClassifiedTickerMap } from "../utils/tickerMapLoader.js";

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
  directoryStatus: "loading" | "ready" | "error";
  directoryError: string;
  refreshTickerMap: (force?: boolean) => Promise<void>;
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
  const [ticker, setTicker] = useState<string>("");
  const [tickerMap, setTickerMap] = useState<TickerMap | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [directoryStatus, setDirectoryStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [directoryError, setDirectoryError] = useState("");

  const refreshTickerMap = useCallback(async (force = false) => {
    setDirectoryStatus("loading");
    setDirectoryError("");
    try {
      const map = await loadClassifiedTickerMap({ force });
      setTickerMap(map as TickerMap);
      setDirectoryStatus("ready");
    } catch (error) {
      setTickerMap(null);
      setDirectoryStatus("error");
      setDirectoryError(
        error instanceof Error
          ? error.message
          : "The SEC ticker directory could not be loaded.",
      );
    }
  }, []);

  // Preload the classified ticker map on mount. Same behavior as the old
  // App.jsx useEffect, just now lives with the context that owns it.
  useEffect(() => {
    void refreshTickerMap();
    const refresh = () => {
      void refreshTickerMap();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshTickerMap]);

  return (
    <TickerContext.Provider
      value={{
        ticker,
        setTicker,
        tickerMap,
        setTickerMap,
        company,
        setCompany,
        directoryStatus,
        directoryError,
        refreshTickerMap,
      }}
    >
      {children}
    </TickerContext.Provider>
  );
}
