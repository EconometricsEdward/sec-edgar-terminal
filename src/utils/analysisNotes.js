/** A notes draft keeps its last accepted value so a later write can detect edits in another tab. */
export function analysisNotesValue(workspace, ticker) {
  const value = workspace.companies?.[ticker]?.notes;
  return typeof value === "string" ? value : "";
}

export function createAnalysisNotesDraft(notes = "", ready = true) {
  return {
    notes,
    savedNotes: notes,
    conflictNotes: null,
    ready,
    status: ready ? (notes ? "saved" : "idle") : "loading",
  };
}

export function analysisNotesDirty(draft) {
  return (
    draft.ready && draft.notes !== (draft.conflictNotes ?? draft.savedNotes)
  );
}

export function editAnalysisNotesDraft(draft, notes) {
  if (!draft.ready) return draft;
  if (notes === draft.conflictNotes) return createAnalysisNotesDraft(notes);
  if (draft.status === "conflict") return { ...draft, notes };
  return {
    ...draft,
    notes,
    status: notes === draft.savedNotes ? (notes ? "saved" : "idle") : "saving",
  };
}

/** Adopt external changes only when they cannot discard a local edit. */
export function observeAnalysisNotes(draft, savedNotes) {
  if (!draft.ready || !analysisNotesDirty(draft) || draft.notes === savedNotes)
    return createAnalysisNotesDraft(savedNotes);
  if (draft.status === "conflict")
    return { ...draft, conflictNotes: savedNotes };
  if (savedNotes === draft.savedNotes) return draft;
  return { ...draft, conflictNotes: savedNotes, status: "conflict" };
}

/**
 * The provider reads storage immediately before invoking this callback. Compare
 * notes there, rather than against a potentially stale React render, and merge
 * into that same fresh workspace so unrelated evidence and metadata survive.
 * An explicit conflict resolution still checks the value the user last saw.
 */
export function persistAnalysisNotes(update, options) {
  const { ticker, name, cik, notes, expectedNotes } = options;
  if (notes === expectedNotes)
    return {
      ok: true,
      status: notes ? "saved" : "idle",
      savedNotes: notes,
      conflictNotes: null,
    };
  let conflictNotes = null;
  const ok = update((workspace) => {
    const currentNotes = analysisNotesValue(workspace, ticker);
    if (currentNotes !== expectedNotes && currentNotes !== notes) {
      conflictNotes = currentNotes;
      return workspace;
    }
    if (currentNotes === notes) return workspace;
    return {
      ...workspace,
      companies: {
        ...workspace.companies,
        [ticker]: {
          ticker,
          name: name || ticker,
          cik,
          saved: true,
          ...workspace.companies[ticker],
          notes,
        },
      },
    };
  });
  if (!ok)
    return {
      ok: false,
      status: "unavailable",
      savedNotes: expectedNotes,
      conflictNotes,
    };
  if (conflictNotes !== null)
    return {
      ok: false,
      status: "conflict",
      savedNotes: expectedNotes,
      conflictNotes,
    };
  return {
    ok: true,
    status: notes ? "saved" : "idle",
    savedNotes: notes,
    conflictNotes: null,
  };
}
