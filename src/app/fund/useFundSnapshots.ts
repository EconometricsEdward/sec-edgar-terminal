"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createFundSnapshotClient } from "../../utils/fundSnapshotClient.js";

export type SnapshotState = {
  status: "idle" | "loading" | "ready" | "unavailable" | "error" | "cancelled";
  data?: any;
  error?: string;
  refreshing?: boolean;
};
export default function useFundSnapshots() {
  const [states, setStates] = useState<Record<string, SnapshotState>>({});
  const [progress, setProgress] = useState({ busy: false, total: 0, completed: 0, ticker: "", cancelled: false });
  const mounted = useRef(false);
  const client = useRef<ReturnType<typeof createFundSnapshotClient> | null>(null);
  const getClient = useCallback(() => {
    if (!client.current) {
      const created = createFundSnapshotClient({
        onStates: (next: Record<string, SnapshotState>) => { if (mounted.current && client.current === created) setStates(next); },
        onProgress: (next: typeof progress) => { if (mounted.current && client.current === created) setProgress(next); },
      });
      client.current = created;
    }
    return client.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      client.current?.cancel();
      // Strict Mode mounts effects again; allow the replacement request to start.
      client.current = null;
    };
  }, []);
  const load = useCallback((tickers: string[], reportMap: Record<string, string> = {}, force = false) =>
    getClient().load(tickers, reportMap, force), [getClient]);
  const cancel = useCallback(() => client.current?.cancel(), []);
  const ingest = useCallback((funds: any[]) => getClient().ingest(funds), [getClient]);
  return { states, load, cancel, progress, ingest };
}
