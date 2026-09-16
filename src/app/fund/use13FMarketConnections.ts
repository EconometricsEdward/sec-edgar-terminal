"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { buildThirteenFMarketConnections } from "../../utils/thirteenFMarketConnections.js";
import { create13FMarketConnectionSession } from "../../utils/thirteenFMarketConnectionsClient.js";

export function use13FMarketConnections(data: any, active: boolean) {
  // A new report object creates a new, initially empty session before paint.
  // Cached evidence is accepted only after checking the new holding identity.
  const session = useMemo(() => create13FMarketConnectionSession(data), [data]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    session.setActive(active);
    return () => session.setActive(false);
  }, [session, active]);
  const model = useMemo(() => buildThirteenFMarketConnections(data, state.results), [data, state.results]);
  return { model, pending: state.pending, paused: state.paused, blocked: state.blocked, limit: state.limit, completed: state.completed, progress: state.progress, error: state.error,
    startAll: session.startAll, pause: session.pause, resume: session.resume, retry: session.retry, scanNext: session.scanNext, refresh: session.refresh };
}
