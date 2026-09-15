"use client";
import { useEffect, useRef, useState } from "react";
import { filerNameQuery, searchSecFilers } from "./secFilerSearch.js";

export function useSecFilerSearch(input, enabled = true) {
  const query = filerNameQuery(input);
  const active = enabled && query.length >= 2 && query.length <= 160;
  const [attempt, setAttempt] = useState(0);
  const previousAttempt = useRef(0);
  const [state, setState] = useState({ query: "", status: "idle", results: [], truncated: false, warning: "", error: "" });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const force = attempt !== previousAttempt.current;
    previousAttempt.current = attempt;
    let disposed = false;
    let timedOut = false;
    let deadline;
    const timer = setTimeout(async () => {
      setState({ query, status: "loading", results: [], truncated: false, warning: "", error: "" });
      deadline = setTimeout(() => {
        timedOut = true;
        controller.abort();
        if (!disposed) setState({ query, status: "error", results: [], truncated: false, warning: "", error: "SEC filer search timed out. Retry the search." });
      }, 30000);
      try {
        const data = await searchSecFilers(query, { signal: controller.signal, force });
        if (!disposed && !timedOut) setState({ query, status: "ready", ...data, error: "" });
      } catch (error) {
        if (!disposed && !timedOut) setState({ query, status: "error", results: [], truncated: false, warning: "", error: error?.message || "SEC filer search is temporarily unavailable. Retry the search." });
      } finally { clearTimeout(deadline); }
    }, 250);
    // Closing the menu or changing its query must never publish an old result
    // (including a rejected request that races with the deadline).
    return () => { disposed = true; clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
  }, [query, active, attempt]);
  const current = active && state.query === query ? state : { query, status: active ? "loading" : "idle", results: [], truncated: false, warning: "", error: "" };
  return { ...current, retry: () => setAttempt(value => value + 1) };
}
