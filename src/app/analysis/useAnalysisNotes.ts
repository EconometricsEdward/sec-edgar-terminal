"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  analysisNotesDirty,
  analysisNotesValue,
  createAnalysisNotesDraft,
  editAnalysisNotesDraft,
  observeAnalysisNotes,
  persistAnalysisNotes,
} from "../../utils/analysisNotes.js";

type WorkspaceData = {
  version: number;
  companies: Record<string, any>;
  peerGroups: any[];
};
type Options = {
  ticker: string;
  name?: string;
  cik?: string | number;
  workspace: {
    data: WorkspaceData;
    ready: boolean;
    error: string;
    update: (fn: (current: WorkspaceData) => WorkspaceData) => boolean;
  };
};
export type AnalysisNotesStatus =
  "loading" | "idle" | "saving" | "saved" | "unavailable" | "conflict";
type Draft = {
  notes: string;
  savedNotes: string;
  conflictNotes: string | null;
  ready: boolean;
  status: AnalysisNotesStatus;
};

/** Mount once per ticker (the Analysis workspace is already keyed by ticker). */
export function useAnalysisNotes(options: Options) {
  const [draft, setDraft] = useState<Draft>(
    () => createAnalysisNotesDraft("", false) as Draft,
  );
  const current = useRef(draft);
  const latest = useRef(options);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    latest.current = options;
  }, [options]);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const publish = useCallback((next: Draft) => {
    current.current = next;
    if (mounted.current) setDraft(next);
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    const state = current.current;
    if (!state.ready) return false;
    if (state.status === "conflict") return false;
    if (!analysisNotesDirty(state)) return true;
    const { workspace, ticker, name, cik } = latest.current;
    const result = persistAnalysisNotes(workspace.update, {
      ticker,
      name,
      cik,
      notes: state.notes,
      expectedNotes: state.savedNotes,
    });
    publish({ ...state, ...result } as Draft);
    return result.ok;
  }, [clearTimer, publish]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flush();
    };
  }, [flush]);

  useEffect(() => {
    if (!options.workspace.ready) return;
    if (!current.current.ready && options.workspace.error) {
      publish({ ...current.current, status: "unavailable" });
      return;
    }
    const next = observeAnalysisNotes(
      current.current,
      analysisNotesValue(options.workspace.data, options.ticker),
    ) as Draft;
    if (next.status !== "saving") clearTimer();
    publish(next);
  }, [
    options.workspace.ready,
    options.workspace.data,
    options.workspace.error,
    options.ticker,
    clearTimer,
    publish,
  ]);

  const setNotes = useCallback(
    (notes: string) => {
      clearTimer();
      const next = editAnalysisNotesDraft(current.current, notes) as Draft;
      publish(next);
      if (next.status === "saving") timer.current = setTimeout(flush, 500);
    },
    [clearTimer, flush, publish],
  );

  const saveDraft = useCallback(() => {
    const state = current.current;
    if (state.status !== "conflict") return flush();
    const { workspace, ticker, name, cik } = latest.current;
    const result = persistAnalysisNotes(workspace.update, {
      ticker,
      name,
      cik,
      notes: state.notes,
      expectedNotes: state.conflictNotes,
    });
    publish({ ...state, ...result } as Draft);
    return result.ok;
  }, [flush, publish]);

  const useSaved = useCallback(() => {
    clearTimer();
    let savedNotes = "";
    // Resolve against fresh storage, including an edit made after the conflict appeared.
    const ok = latest.current.workspace.update((workspace) => {
      savedNotes = analysisNotesValue(workspace, latest.current.ticker);
      return workspace;
    });
    if (ok) publish(createAnalysisNotesDraft(savedNotes) as Draft);
    else publish({ ...current.current, status: "unavailable" });
    return ok;
  }, [clearTimer, publish]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const state = current.current;
      if (!state.ready || !analysisNotesDirty(state)) return;
      if (flush()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [flush]);

  return {
    notes: draft.notes,
    setNotes,
    flush,
    status: draft.status,
    dirty: analysisNotesDirty(draft),
    ready: draft.ready,
    conflictNotes: draft.conflictNotes,
    saveDraft,
    useSaved,
  };
}
