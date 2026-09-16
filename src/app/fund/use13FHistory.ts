"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { calendarPeriods13F, project13FHistoryQuarter, summarize13FHistory } from "../../utils/thirteenFHistory.js";
import { create13FHistoryClient, historyClientSlot, settled13FHistorySlot } from "../../utils/thirteenFHistoryClient.js";

type Slot = { period: string; status: "ready" | "unavailable" | "loading" | "pending"; projection?: any; reason?: string; requestStatus?: "ready" | "unavailable" | "loading" | "pending"; detailReason?: string };
const client = create13FHistoryClient();

/** Load compact quarter projections progressively; never retain full multi-quarter portfolios. */
export function use13FHistory(data: any, { count = 8, holdingKey = "" }: { count?: number; holdingKey?: string } = {}) {
  const cik = data?.manager?.cik || "";
  const period = data?.selectedPeriod || "";
  const portfolio = data?.portfolio;
  const boundedCount = [4, 8, 12].includes(count) ? count : 8;
  // Aggregate metrics are included independently of tracked securities. Request
  // only the position being explored, not 31 unrelated positions on every click.
  const trackedKey = holdingKey || portfolio?.holdings?.[0]?.key || "";
  const keysJson = JSON.stringify(trackedKey ? [trackedKey] : []);
  const requestKey = `${cik}:${period}:${boundedCount}:${keysJson}`;
  const [state, setState] = useState<{ key: string; slots: Slot[] }>({ key: "", slots: [] });
  const [attempt, setAttempt] = useState<{ number: number; key: string; periods: string[] }>({ number: 0, key: "", periods: [] });
  const seed: Slot[] = useMemo(() => {
    if (!cik || !period || !portfolio) return [];
    const keys = JSON.parse(keysJson);
    return calendarPeriods13F(period, boundedCount).map((quarter: string): Slot => quarter === period
      ? { period: quarter, status: "ready", requestStatus: "ready", projection: { ...project13FHistoryQuarter(portfolio, keys), observedAt: data?.observedAt || null, checkedAt: data?.cache?.checkedAt || data?.observedAt || null, stale: data?.cache?.stale === true } }
      : historyClientSlot(client, cik, quarter, keys) as Slot);
  }, [cik, period, boundedCount, portfolio, keysJson, data?.observedAt, data?.cache?.checkedAt, data?.cache?.stale]);
  useEffect(() => {
    if (!seed.length) return;
    let disposed = false;
    const controller = new AbortController();
    const keys = JSON.parse(keysJson);
    const forced = new Set(attempt.key === requestKey ? attempt.periods : []);
    const initial: Slot[] = seed.map(slot => slot.period === period ? slot : historyClientSlot(client, cik, slot.period, keys, { force: forced.has(slot.period) }) as Slot);
    setState({ key: requestKey, slots: initial });
    const update = (slot: Slot) => {
      if (!disposed) setState(previous => previous.key !== requestKey ? previous : { ...previous, slots: previous.slots.map(item => item.period === slot.period ? slot : item) });
    };
    const queue = initial.filter(slot => slot.period !== period && ["pending", "loading"].includes(slot.requestStatus || slot.status)).reverse();
    async function worker() {
      while (!disposed && queue.length) {
        const slot = queue.shift()!;
        update({ ...slot, ...(slot.status === "ready" ? {} : { status: "loading" as const }), requestStatus: "loading" });
        try {
          const result = await client.fetchQuarter(cik, slot.period, keys, controller.signal, forced.has(slot.period));
          if (disposed) return;
          update(settled13FHistorySlot(client, cik, slot.period, result, slot) as Slot);
        } catch {
          // Individual subscriptions may be canceled while another consumer of
          // this exact manager/quarter/security continues. Never paint that abort
          // as a missing SEC report, or update a newly selected manager.
          if (disposed || controller.signal.aborted) return;
          update(slot.status === "ready" ? { ...slot, requestStatus: "unavailable", detailReason: "This position could not be loaded. Retry to fill the gap." } : { period: slot.period, status: "unavailable", requestStatus: "unavailable", reason: "This quarter could not be loaded. Retry to fill the gap." });
        }
      }
    }
    void Promise.all([worker(), worker()]);
    return () => { disposed = true; controller.abort(); };
  }, [cik, period, requestKey, keysJson, seed, attempt]);
  const slots = state.key === requestKey ? state.slots : seed;
  const history = useMemo(() => summarize13FHistory(slots, { ...(cik ? { cik } : {}), maxQuarters: 12 }), [slots, cik]);
  const completed = slots.filter(slot => ["ready", "unavailable"].includes(slot.status)).length;
  const positionCompleted = slots.filter(slot => ["ready", "unavailable"].includes(slot.requestStatus || slot.status)).length;
  const positionLoading = !!trackedKey && positionCompleted < slots.length;
  const positionErrors = slots.filter(slot => slot.detailReason).map(slot => ({ period: slot.period, reason: slot.detailReason }));
  const retry = useCallback((retryPeriod?: string) => {
    const periods = retryPeriod ? slots.filter(slot => slot.period === retryPeriod && slot.period !== period).map(slot => slot.period) : slots.filter(slot => slot.period !== period && (slot.requestStatus === "unavailable" || slot.status === "unavailable" || slot.status === "ready" && !slot.projection?.complete)).map(slot => slot.period);
    if (periods.length) setAttempt(previous => ({ number: previous.number + 1, key: requestKey, periods }));
  }, [slots, period, requestKey]);
  return { history, loading: completed < slots.length, positionLoading, positionErrors, positionCompleted, completed, total: slots.length, retry };
}
