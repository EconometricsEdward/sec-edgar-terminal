"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { fundSnapshotKey } from "../../utils/fundScreener.js";
export type SnapshotState = {
  status: "idle" | "loading" | "ready" | "unavailable" | "error" | "cancelled";
  data?: any;
  error?: string;
};
export default function useFundSnapshots() {
  const [states, setStates] = useState<Record<string, SnapshotState>>({});
  const current = useRef<Record<string, SnapshotState>>({});
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [progress, setProgress] = useState({
    busy: false,
    total: 0,
    completed: 0,
    ticker: "",
    cancelled: false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const update = useCallback((key: string, state: SnapshotState) => {
    current.current = { ...current.current, [key]: state };
    if (mounted.current) setStates(current.current);
  }, []);
  const load = useCallback(
    async (
      tickers: string[],
      reportMap: Record<string, string> = {},
      force = false,
    ) => {
      if (active.current) return false;
      const batch = [...new Set(tickers)].filter(
        (ticker) =>
          force ||
          current.current[fundSnapshotKey(ticker, reportMap)]?.status !==
            "ready",
      );
      if (!batch.length) return true;
      const controller = new AbortController();
      active.current = controller;
      let completed = 0;
      setProgress({
        busy: true,
        total: batch.length,
        completed,
        ticker: batch[0],
        cancelled: false,
      });
      for (const ticker of batch) {
        if (controller.signal.aborted) break;
        const key = fundSnapshotKey(ticker, reportMap);
        update(key, { status: "loading", data: current.current[key]?.data });
        if (mounted.current)
          setProgress({
            busy: true,
            total: batch.length,
            completed,
            ticker,
            cancelled: false,
          });
        try {
          const query = new URLSearchParams({
            v: "2",
            ticker,
            ...(reportMap[ticker] ? { accession: reportMap[ticker] } : {}),
          });
          const response = await fetch(`/api/fund?${query}`, {
            signal: controller.signal,
          });
          const data = await response.json();
          if (controller.signal.aborted) {
            update(key, {
              status: "cancelled",
              error: "Loading cancelled. Retry this fund when ready.",
            });
            break;
          }
          if (!response.ok)
            throw new Error(
              data.error || `Request failed (${response.status}).`,
            );
          if (data.ticker !== ticker)
            throw new Error(
              "The returned fund identity did not match this ticker.",
            );
          if (
            data.status === "ready" &&
            reportMap[ticker] &&
            data.accession !== reportMap[ticker]
          )
            throw new Error(
              "The returned report did not match the selected accession.",
            );
          const state: SnapshotState =
            data.status === "ready"
              ? { status: "ready", data }
              : {
                  status: "unavailable",
                  data,
                  error:
                    data.reason ||
                    "Portfolio coverage is unavailable in the records checked.",
                };
          update(key, state);
          if (state.status === "ready")
            update(`${ticker}:${data.accession}`, state);
        } catch (error) {
          update(key, {
            status: controller.signal.aborted ? "cancelled" : "error",
            error: controller.signal.aborted
              ? "Loading cancelled. Retry this fund when ready."
              : error instanceof Error
                ? error.message
                : "Snapshot could not be loaded.",
          });
          if (controller.signal.aborted) {
            update(key, {
              status: "cancelled",
              error: "Loading cancelled. Retry this fund when ready.",
            });
            break;
          }
        }
        completed++;
      }
      if (active.current === controller) active.current = null;
      if (mounted.current)
        setProgress({
          busy: false,
          total: batch.length,
          completed,
          ticker: "",
          cancelled: controller.signal.aborted,
        });
      return !controller.signal.aborted;
    },
    [update],
  );
  const ingest = useCallback(
    (funds: any[]) => {
      for (const data of funds) {
        if (
          data?.status !== "ready" ||
          !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(data.ticker || "") ||
          !/^\d{10}-\d{2}-\d{6}$/.test(data.accession || "")
        )
          continue;
        update(`${data.ticker}:${data.accession}`, { status: "ready", data });
      }
    },
    [update],
  );
  const cancel = useCallback(() => active.current?.abort(), []);
  return { states, load, cancel, progress, ingest };
}
