"use client";
import { useEffect, useState } from "react";
import { filerNameQuery, searchSecFilers } from "./secFilerSearch.js";

export function useSecFilerSearch(input, enabled = true) {
  const query = filerNameQuery(input);
  const active = enabled && query.length >= 2 && query.length <= 160;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ query: "", status: "idle", results: [], truncated: false, warning: "", error: "" });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let deadline;
    const timer = setTimeout(async () => {
      setState({ query, status: "loading", results: [], truncated: false, warning: "", error: "" });
      deadline = setTimeout(() => controller.abort(), 30000);
      try {
        const data = await searchSecFilers(query, { signal: controller.signal, force: attempt > 0 });
        if (!controller.signal.aborted) setState({ query, status: "ready", ...data, error: "" });
      } catch (error) {
        if (!controller.signal.aborted) setState({ query, status: "error", results: [], truncated: false, warning: "", error: error.message });
        else if (deadline) setState({ query, status: "error", results: [], truncated: false, warning: "", error: "SEC filer search timed out. Retry the search." });
      } finally { clearTimeout(deadline); deadline = undefined; }
    }, 400);
    return () => { clearTimeout(timer); clearTimeout(deadline); deadline = undefined; controller.abort(); };
  }, [query, active, attempt]);
  const current = active && state.query === query ? state : { query, status: active ? "loading" : "idle", results: [], truncated: false, warning: "", error: "" };
  return { ...current, retry: () => setAttempt(value => value + 1) };
}
