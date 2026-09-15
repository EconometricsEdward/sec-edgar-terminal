"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { calendarPeriods13F, project13FHistoryQuarter, summarize13FHistory } from "../../utils/thirteenFHistory.js";

type Slot = { period: string; status: "ready" | "unavailable" | "loading" | "pending"; projection?: any; reason?: string };
const cache = new Map<string, { data: any; bytes: number; expires: number }>();
const MAX_BYTES = 512 * 1024;
const CACHE_BYTES = 8 * 1024 * 1024;

async function fetchQuarter(cik: string, period: string, keys: string[], signal: AbortSignal, force: boolean) {
  const query = new URLSearchParams({ cik, period, keys: JSON.stringify(keys) });
  const cacheKey = query.toString();
  const cached = cache.get(cacheKey);
  if (!force && cached && cached.expires > Date.now()) return cached.data;
  const response = await fetch(`/api/fund-13f/history?${query}`, { signal, ...(force ? { cache: "no-cache" as RequestCache } : {}) });
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("This history response exceeded the supported size.");
  const reader = response.body?.getReader();
  let raw = "", bytes = 0;
  if (reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error("This history response exceeded the supported size."); }
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
  } else { raw = await response.text(); bytes = raw.length * 2; }
  signal.throwIfAborted();
  if (bytes > MAX_BYTES) throw new Error("This history response exceeded the supported size.");
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error("This SEC quarter could not be opened. Retry to fill the gap."); }
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "This SEC quarter is temporarily unavailable.");
  const projection = data.projection;
  if (data.manager?.cik !== cik || data.selectedPeriod !== period || !["ready", "unavailable"].includes(data.status) || data.status === "ready" && (projection?.cik !== cik || projection?.period !== period || !Array.isArray(projection?.trackedKeys) || keys.some(key => !projection.trackedKeys.includes(key)) || !projection?.positions || !Array.isArray(projection?.filings))) throw new Error("The response did not match this manager, quarter, and selected securities.");
  // Validate every tracked observation before it can enter state. A malformed
  // response should create a retryable gap, not throw during the next render.
  if (data.status === "ready") summarize13FHistory([{ period, status: "ready", projection }], { cik });
  if (data.status === "ready" && projection.complete && data.coverage?.selectedPeriodComplete) {
    cache.delete(cacheKey);
    let total = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (cache.size && (cache.size >= 48 || total + bytes > CACHE_BYTES)) {
      const oldest = cache.keys().next().value!;
      total -= cache.get(oldest)!.bytes; cache.delete(oldest);
    }
    cache.set(cacheKey, { data, bytes, expires: Date.now() + 300000 });
  }
  return data;
}

/** Load compact quarter projections progressively; never retain full multi-quarter portfolios. */
export function use13FHistory(data: any, { count = 8, holdingKey = "" }: { count?: number; holdingKey?: string } = {}) {
  const cik = data?.manager?.cik || "";
  const period = data?.selectedPeriod || "";
  const portfolio = data?.portfolio;
  const boundedCount = [4, 8, 12].includes(count) ? count : 8;
  const keysJson = useMemo(() => {
    const top = [...(portfolio?.holdings || [])].sort((a: any, b: any) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 31).map((row: any) => row.key);
    return JSON.stringify([...new Set<string>([...top, ...(holdingKey ? [holdingKey] : [])])].sort());
  }, [portfolio?.holdings, holdingKey]);
  const requestKey = `${cik}:${period}:${boundedCount}:${keysJson}`;
  const [state, setState] = useState<{ key: string; slots: Slot[] }>({ key: "", slots: [] });
  const [attempt, setAttempt] = useState({ number: 0, period: "" });
  const seed = useMemo(() => {
    if (!cik || !period || !portfolio) return [];
    return calendarPeriods13F(period, boundedCount).map((quarter: string): Slot => quarter === period ? { period: quarter, status: "ready", projection: project13FHistoryQuarter(portfolio, JSON.parse(keysJson)) } : { period: quarter, status: "pending" });
  }, [cik, period, boundedCount, portfolio, keysJson]);
  useEffect(() => {
    if (!seed.length) return;
    let disposed = false;
    const controller = new AbortController();
    const keys = JSON.parse(keysJson);
    setState(previous => ({ key: requestKey, slots: seed.map(slot => {
      const old = previous.key === requestKey ? previous.slots.find(item => item.period === slot.period) : null;
      return slot.period === period ? slot : old?.status === "ready" && (!attempt.number || attempt.period && attempt.period !== slot.period) ? old : slot;
    }) }));
    const update = (slot: Slot) => {
      if (!disposed) setState(previous => previous.key !== requestKey ? previous : { ...previous, slots: previous.slots.map(item => item.period === slot.period ? slot : item) });
    };
    const queue = seed.filter(slot => slot.period !== period).reverse();
    async function worker() {
      while (!disposed && queue.length) {
        const slot = queue.shift()!;
        const force = attempt.number > 0 && (!attempt.period || attempt.period === slot.period);
        update({ ...slot, status: "loading" });
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
        try {
          const response = await fetchQuarter(cik, slot.period, keys, signal, force);
          update(response.status === "ready" ? { period: slot.period, status: "ready", projection: response.projection } : { period: slot.period, status: "unavailable", reason: response.reason || "No usable 13F holdings report was found for this quarter." });
        } catch (error: any) {
          if (!disposed) update({ period: slot.period, status: "unavailable", reason: signal.aborted ? "This quarter timed out. Retry to fill the gap." : error.message });
        }
      }
    }
    void Promise.all([worker(), worker()]);
    return () => { disposed = true; controller.abort(); };
  }, [cik, period, requestKey, keysJson, seed, attempt]);
  const slots = state.key === requestKey ? state.slots : seed;
  const history = useMemo(() => summarize13FHistory(slots, { ...(cik ? { cik } : {}), maxQuarters: 12 }), [slots, cik]);
  const completed = slots.filter(slot => ["ready", "unavailable"].includes(slot.status)).length;
  const retry = useCallback((retryPeriod?: string) => setAttempt(previous => ({ number: previous.number + 1, period: retryPeriod || "" })), []);
  return { history, loading: completed < slots.length, completed, total: slots.length, retry };
}
