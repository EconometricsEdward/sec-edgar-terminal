"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserChatRuntime, BrowserChatSnapshot } from "./browserChatRuntime";

// The runtime itself, worker and model are not imported during normal page loads.
export function useBrowserChat(enabled: boolean, open: boolean) {
  const runtime = useRef<BrowserChatRuntime | null>(null);
  const pending = useRef<Promise<BrowserChatRuntime> | null>(null);
  const alive = useRef(true);
  const unsubscribe = useRef<(() => void) | null>(null);
  const [snapshot, setSnapshot] = useState<BrowserChatSnapshot>({ state: "idle", progress: 0, message: "", cached: false, supported: null });
  const getRuntime = useCallback(async () => {
    if (runtime.current) return runtime.current;
    if (!pending.current) pending.current = import("./browserChatRuntime").then(module => {
      if (!alive.current) throw new Error("Chat was closed.");
      const instance = new module.BrowserChatRuntime();
      runtime.current = instance;
      const sync = () => { if (alive.current) setSnapshot(instance.getSnapshot()); };
      unsubscribe.current = instance.subscribe(sync);
      sync();
      return instance;
    }).finally(() => { pending.current = null; });
    return pending.current;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; unsubscribe.current?.(); runtime.current?.dispose(); runtime.current = null; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (enabled && open) void getRuntime().then(instance => {
      if (cancelled) return;
      instance.retain();
      return instance.checkSupport();
    }).catch(() => {});
    else runtime.current?.release({ delayMs: open ? 0 : 30000 });
    return () => { cancelled = true; };
  }, [enabled, open, getRuntime]);
  const load = useCallback(async () => { const instance = await getRuntime(); await instance.load(); }, [getRuntime]);
  const clear = useCallback(async () => { const instance = await getRuntime(); await instance.clearCache(); }, [getRuntime]);
  const cancel = useCallback(() => { runtime.current?.release({ delayMs: 0 }); }, []);
  return { snapshot, runtime, load, clear, cancel };
}
