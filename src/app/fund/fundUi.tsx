"use client";
import { useEffect, useState } from "react";
import type { Fund } from "./fundTypes";
import {
  FUND_SHELF_KEY,
  parseFundShelf,
  toggleFundShelf,
} from "../../utils/workspaceReview.js";
export function money(n: number | null | undefined) {
  return n == null || !Number.isFinite(n)
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(n);
}
export function pct(n: number | null | undefined) {
  return n == null ? "—" : `${n.toFixed(2)}%`;
}
export function number(n: number | null | undefined) {
  return n == null
    ? "—"
    : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
export function ageDays(asOf: string) {
  return Math.max(
    0,
    Math.floor((Date.now() - Date.parse(asOf + "T00:00:00Z")) / 86400000),
  );
}
export function useFundShelf() {
  const [saved, setSaved] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    const read = () => {
      try {
        setSaved(parseFundShelf(localStorage.getItem(FUND_SHELF_KEY)));
        setStorageError("");
      } catch {
        setStorageError(
          "Saved funds could not be read. Existing browser data has been preserved.",
        );
      }
      setReady(true);
    };
    const sync = (event: StorageEvent) => {
      if (!event.key || event.key === FUND_SHELF_KEY) read();
    };
    read();
    window.addEventListener("storage", sync);
    window.addEventListener("research-storage", read);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("research-storage", read);
    };
  }, []);
  const toggle = (ticker: string) => {
    try {
      const next = toggleFundShelf(localStorage, ticker);
      setSaved(next);
      setStorageError("");
      window.dispatchEvent(new Event("research-storage"));
    } catch (error) {
      setStorageError(
        error instanceof Error
          ? error.message
          : "Could not save this fund. Browser storage may be unavailable.",
      );
    }
  };
  return { saved, ready, toggle, storageError };
}
export function researchBrief(fund: Fund, notes = "") {
  return `# ${fund.ticker} — ${fund.name}\n\nPortfolio as of ${fund.asOf}; filed ${fund.filingDate}.\nRegistrant: ${fund.registrant} (CIK ${fund.cik}).\nSeries: ${fund.seriesId || "Not assigned"}; class: ${fund.classId || "Not assigned"}.\nPortfolio net assets: ${money(fund.fundInfo.netAssets)}. Series-level totals may include multiple share classes.\nReported positions: ${fund.summary.count}; top 10 positive position weights: ${pct(fund.summary.top10Weight)} of net assets.\nLargest reported positive position: ${fund.summary.largest?.name || "Unavailable"} (${pct(fund.summary.largest?.pctOfNav)}).\n\nSEC filing: ${fund.filingUrl}\nRaw N-PORT: ${fund.sourceUrl}\nAccession: ${fund.accession}\nRetrieved: ${fund.retrievedAt}\n\nHistorical reported holdings; not a live portfolio. Derivative fair values are not notional exposure.\n${notes ? `\n## Research notes\n${notes}\n` : ""}`;
}
