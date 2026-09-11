"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Download,
  FileText,
  FolderOpen,
  Plus,
  Trash2,
} from "lucide-react";
import {
  FUND_BOARDS_KEY,
  FUND_BOARD_LIMIT,
  FUND_EVIDENCE_LIMIT,
  captureFundBoard,
  readFundBoards,
  writeFundBoard,
} from "../../utils/fundBoards.js";
import {
  buildFundBoardBrief,
  fundBoardBriefCsv,
  fundBoardBriefHtml,
} from "../../utils/fundBoardBrief.js";
import { downloadText } from "../../utils/download.js";
import s from "./fund.module.css";
import b from "./FundResearchBoards.module.css";

type Props = {
  settings: any;
  onPatch: (patch: any) => unknown;
  evidence: any[];
  onClearEvidence: () => unknown;
  snapshots: any[];
  onRestoreEvidence: (evidence: any[]) => unknown;
};
const newId = () => `board-${globalThis.crypto.randomUUID()}`;
export default function FundResearchBoards({
  settings,
  onPatch,
  evidence,
  onClearEvidence,
  snapshots,
  onRestoreEvidence,
}: Props) {
  const [store, setStore] = useState<any>({ version: 1, boards: [] });
  const [ready, setReady] = useState(false),
    [storageError, setStorageError] = useState("");
  const [baseline, setBaseline] = useState<any>(null);
  const [name, setName] = useState(""),
    [notes, setNotes] = useState("");
  const [message, setMessage] = useState(""),
    [deletePending, setDeletePending] = useState(false);
  const [brief, setBrief] = useState<any>(null);
  const initialBoardId = useRef(settings.board);
  const initialLoaded = useRef(false);
  const lastRequestedBoard = useRef(settings.board || "");
  const [pendingBoardId, setPendingBoardId] = useState<string | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const dirty =
    name !== (baseline?.name || "") || notes !== (baseline?.notes || "");
  const currentSaved = baseline
    ? store.boards.find((board: any) => board.id === baseline.id)
    : null;
  const conflict = Boolean(
    baseline && (!currentSaved || currentSaved.revision !== baseline.revision),
  );
  const loadRequestedBoard = useCallback(
    (id: string) => {
      const selected = store.boards.find((board: any) => board.id === id);
      setBaseline(selected || null);
      setName(selected?.name || "");
      setNotes(selected?.notes || "");
      setPendingBoardId(null);
      setDeletePending(false);
      setMessage(
        selected
          ? "Requested board opened. Its saved notes and capture are selected; current workspace pins have not been replaced. Use Restore board workspace and evidence when ready."
          : id
            ? "This requested board is not saved in this browser. The public research settings from the link remain available."
            : "New board draft opened. Current workspace evidence is preserved.",
      );
    },
    [store.boards],
  );
  useEffect(() => {
    const read = () => {
      try {
        const next = readFundBoards(localStorage.getItem(FUND_BOARDS_KEY));
        setStore(next);
        setStorageError("");
        if (!initialLoaded.current) {
          initialLoaded.current = true;
          const selected = next.boards.find(
            (board: any) => board.id === initialBoardId.current,
          );
          if (selected) {
            setBaseline(selected);
            setName(selected.name);
            setNotes(selected.notes);
          } else if (initialBoardId.current)
            setMessage(
              "This board is not saved in this browser. The public research settings from the link are still available.",
            );
        }
      } catch (error) {
        setStorageError(
          error instanceof Error
            ? error.message
            : "Saved boards could not be read. Your draft is preserved.",
        );
      }
      setReady(true);
    };
    const sync = (event: StorageEvent) => {
      if (!event.key || event.key === FUND_BOARDS_KEY) read();
    };
    read();
    window.addEventListener("storage", sync);
    window.addEventListener("research-storage", read);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("research-storage", read);
    };
  }, []);
  useEffect(() => {
    if (!ready || storageError) return;
    const requestedId = settings.board || "";
    if (lastRequestedBoard.current === requestedId) return;
    lastRequestedBoard.current = requestedId;
    setDeletePending(false);
    if (requestedId === (baseline?.id || "")) {
      setPendingBoardId(null);
      return;
    }
    if (dirty) {
      setPendingBoardId(requestedId);
      setMessage(
        "The research URL requested a different board. Your unsaved name and notes are preserved; choose which board to edit below.",
      );
      return;
    }
    loadRequestedBoard(requestedId);
  }, [
    settings.board,
    ready,
    storageError,
    baseline?.id,
    dirty,
    loadRequestedBoard,
  ]);
  useEffect(() => {
    if (brief) previewRef.current?.focus();
  }, [brief]);
  function selectBoard(board: any) {
    if (dirty) {
      setMessage(
        "Save your name or note edits, or discard those edits before selecting another board. Your draft is still here.",
      );
      return;
    }
    setBaseline(board);
    setName(board?.name || "");
    setNotes(board?.notes || "");
    setDeletePending(false);
    onPatch({ board: board?.id || "" });
    setMessage(
      board
        ? "Saved board selected. Restore its workspace to reopen its report choices and pinned evidence."
        : "New board draft. Save the current workspace and evidence when ready.",
    );
  }
  function capture(id = newId()) {
    return captureFundBoard({
      id,
      name: name.trim() || "Fund research brief",
      notes,
      settings,
      snapshots,
      evidence,
    });
  }
  function persist(
    mode: "create" | "update" | "delete",
    board: any,
    success: string,
  ) {
    try {
      if (!ready || storageError)
        throw new Error(
          "Saved boards are not available for writing. Preview and export your draft to preserve it.",
        );
      const next = writeFundBoard(localStorage, {
        mode,
        board,
        id: board?.id || baseline?.id,
        expectedRevision: mode === "create" ? undefined : baseline?.revision,
      });
      setStore(next);
      window.dispatchEvent(new Event("research-storage"));
      const saved =
        mode === "delete"
          ? null
          : next.boards.find((item: any) => item.id === board.id);
      setBaseline(saved);
      setName(saved?.name || "");
      setNotes(saved?.notes || "");
      setDeletePending(false);
      onPatch({ board: saved?.id || "" });
      setMessage(success);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The board could not be saved. Your draft is preserved.",
      );
    }
  }
  function saveCurrent(update = false) {
    try {
      if (!name.trim())
        throw new Error("Give this board a name before saving.");
      persist(
        update ? "update" : "create",
        capture(update ? baseline.id : newId()),
        update
          ? "Board updated with the current workspace, captured reports, notes, and evidence."
          : "Research board saved in this browser.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not capture this board. Your draft is preserved.",
      );
    }
  }
  function preview(board?: any) {
    try {
      const captured = board || capture();
      setBrief(buildFundBoardBrief(captured));
      setMessage(
        "Exact brief preview captured. Both downloads preserve this preview; later edits require a new preview.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not create the research brief.",
      );
    }
  }
  const html = brief ? fundBoardBriefHtml(brief) : "";
  const canWrite = ready && !storageError && pendingBoardId === null;
  return (
    <section className={s.panel} aria-label="Fund research boards">
      <div className={s.sectionHeading}>
        <div>
          <p className={s.eyebrow}>
            <FolderOpen size={15} /> Research boards
          </p>
          <h2>Keep the evidence with the decision.</h2>
          <p className={s.caption}>
            Save complete research settings, exact portfolio reports,
            source-backed findings, and your notes. Boards stay in this browser
            and do not automatically sync across devices.
          </p>
        </div>
        <button className={s.secondary} onClick={() => selectBoard(null)}>
          <Plus size={15} /> New board
        </button>
      </div>
      <p role="status" className={b.status}>
        {message}
      </p>
      {storageError && (
        <p role="alert" className={s.notice}>
          {storageError} Current notes and evidence can still be exported below.
        </p>
      )}
      {pendingBoardId !== null && (
        <div role="alert" className={s.notice}>
          <p>
            The link requested{" "}
            {store.boards.find((board: any) => board.id === pendingBoardId)
              ?.name ||
              (pendingBoardId ? "another saved board" : "a new board draft")}
            , while you have unsaved edits to{" "}
            {baseline?.name || "your current draft"}. Saving is paused until you
            choose. Your current pins are preserved.
          </p>
          <div className={s.actions}>
            <button
              className={s.secondary}
              onClick={() => {
                onPatch({ board: baseline?.id || "" });
                setPendingBoardId(null);
                setMessage(
                  "Current board edits retained. Public research settings remain as shown; restoring a saved board is a separate action.",
                );
              }}
            >
              Keep editing current board
            </button>
            <button
              className={s.secondary}
              onClick={() => loadRequestedBoard(pendingBoardId)}
            >
              Discard edits and open requested board
            </button>
          </div>
        </div>
      )}
      <div className={b.layout}>
        <aside className={b.list} aria-label="Saved research boards">
          <h3>
            Saved boards{" "}
            <span>
              {store.boards.length}/{FUND_BOARD_LIMIT}
            </span>
          </h3>
          {!store.boards.length && (
            <p className={s.caption}>
              Build a fund selection, pin a finding from any research tab, and
              save your first board.
            </p>
          )}
          {store.boards.map((board: any) => (
            <button
              key={board.id}
              className={`${b.boardCard} ${baseline?.id === board.id ? b.selected : ""}`}
              aria-pressed={baseline?.id === board.id}
              onClick={() => selectBoard(board)}
            >
              <strong>{board.name}</strong>
              <span>
                {board.settings.tickers.join(" · ") || "Research filters"}
              </span>
              <small>
                {board.evidence.length} evidence items · saved{" "}
                {board.updatedAt.slice(0, 10)}
              </small>
            </button>
          ))}
        </aside>
        <div className={b.editor}>
          <div className={b.editorHeading}>
            <h3>
              {baseline
                ? "Board notes and research"
                : "Create a research board"}
            </h3>
            <span>
              {dirty
                ? "Unsaved name / notes"
                : baseline
                  ? `Saved revision ${baseline.revision}`
                  : "New draft"}
            </span>
          </div>
          {conflict && (
            <p className={s.notice}>
              This board changed elsewhere or was restored from backup. Your
              draft is preserved. Reload the saved version or save the current
              workspace as a new board.
            </p>
          )}
          <label>
            Board name
            <input
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="US equity concentration review"
            />
          </label>
          <label>
            Research notes
            <textarea
              value={notes}
              maxLength={8000}
              rows={7}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="What did you find? What remains uncertain? Which reporting dates and coverage gaps matter?"
            />
          </label>
          <p className={s.caption}>
            {notes.length.toLocaleString()} / 8,000 characters. Notes are
            private to this browser and your exports; sharing research settings
            does not share notes.
          </p>
          <div className={s.actions}>
            <button
              className={s.primary}
              disabled={!canWrite || store.boards.length >= FUND_BOARD_LIMIT}
              onClick={() => saveCurrent()}
            >
              <Bookmark size={15} /> Save current workspace as new board
            </button>
            <button
              className={s.secondary}
              disabled={pendingBoardId !== null}
              onClick={() => preview()}
            >
              <FileText size={15} /> Preview current workspace brief
            </button>
            {dirty && (
              <button
                className={s.secondary}
                onClick={() => {
                  setName(baseline?.name || "");
                  setNotes(baseline?.notes || "");
                  setMessage(
                    "Unsaved name and note edits discarded. Your research selection and evidence are unchanged.",
                  );
                }}
              >
                Discard name / note edits
              </button>
            )}
          </div>
          {baseline && (
            <div className={b.savedActions}>
              <p className={s.caption}>
                Saved capture: {baseline.capturedAt} ·{" "}
                {baseline.snapshots.length}/{baseline.settings.tickers.length}{" "}
                matching portfolio snapshots · {baseline.evidence.length}{" "}
                evidence items. Evidence may refer to additional reporting
                dates, listed in the brief.
              </p>
              {baseline.missingSnapshots.length > 0 && (
                <p className={s.notice}>
                  No matching snapshot was captured for{" "}
                  {baseline.missingSnapshots.join(", ")}. Missing coverage
                  remains unavailable.
                </p>
              )}
              <div className={s.actions}>
                <button
                  className={s.secondary}
                  disabled={!canWrite || !dirty || conflict}
                  onClick={() =>
                    persist(
                      "update",
                      { ...baseline, name: name.trim(), notes },
                      "Board name and notes saved. Its captured reports, values, and evidence are preserved.",
                    )
                  }
                >
                  Save name and notes
                </button>
                <button
                  className={s.secondary}
                  disabled={!canWrite || conflict}
                  onClick={() => saveCurrent(true)}
                >
                  Update board from current workspace
                </button>
                <button
                  className={s.secondary}
                  disabled={dirty}
                  onClick={() => {
                    if (onRestoreEvidence(baseline.evidence) === false) {
                      setMessage(
                        "The workspace could not restore this board’s evidence. Your saved board is preserved.",
                      );
                      return;
                    }
                    onPatch({
                      ...baseline.settings,
                      view: "boards",
                      board: baseline.id,
                    });
                    setMessage(
                      "Saved research settings, exact report selections, and pinned evidence restored. Open any research tab to continue.",
                    );
                  }}
                >
                  Restore board workspace and evidence
                </button>
                <button
                  className={s.secondary}
                  onClick={() => preview(baseline)}
                >
                  Preview saved board
                </button>
                <button
                  className={s.secondary}
                  disabled={
                    !canWrite ||
                    dirty ||
                    store.boards.length >= FUND_BOARD_LIMIT
                  }
                  onClick={() => {
                    const now = new Date().toISOString();
                    persist(
                      "create",
                      {
                        ...baseline,
                        id: newId(),
                        revision: 1,
                        name: `${baseline.name.slice(0, 114)} copy`,
                        createdAt: now,
                        updatedAt: now,
                      },
                      "Board duplicated with its original captured reports and evidence.",
                    );
                  }}
                >
                  Duplicate saved board
                </button>
                <button
                  className={s.secondary}
                  disabled={!currentSaved}
                  onClick={() => {
                    setBaseline(currentSaved);
                    setName(currentSaved.name);
                    setNotes(currentSaved.notes);
                    setMessage(
                      "Latest saved board loaded. Local name and note edits have been discarded.",
                    );
                  }}
                >
                  Reload saved version
                </button>
                <button
                  className={s.secondary}
                  disabled={!canWrite || conflict}
                  onClick={() => setDeletePending(true)}
                >
                  <Trash2 size={14} /> Delete board
                </button>
              </div>
              {deletePending && (
                <div className={b.deleteConfirm}>
                  <p>
                    Delete “{baseline.name}” from this browser? Export it first
                    if you need to keep a copy.
                  </p>
                  <button
                    className={s.secondary}
                    onClick={() =>
                      persist(
                        "delete",
                        baseline,
                        "Research board deleted. Current workspace evidence is still available.",
                      )
                    }
                  >
                    Delete this saved board
                  </button>
                  <button
                    className={s.secondary}
                    onClick={() => setDeletePending(false)}
                  >
                    Keep board
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <section className={b.pins} aria-label="Current pinned fund evidence">
        <div className={s.sectionHeading}>
          <div>
            <h3>
              Current workspace evidence{" "}
              <span>
                {evidence.length}/{FUND_EVIDENCE_LIMIT}
              </span>
            </h3>
            <p className={s.caption}>
              Pins preserve their original values and filing dates. Saving a
              board captures these pins; removing them here does not alter an
              existing saved board.
            </p>
          </div>
          {evidence.length > 0 && (
            <button
              className={s.secondary}
              onClick={() => {
                onClearEvidence();
                setMessage(
                  "Current workspace evidence cleared. Saved boards retain their captured evidence.",
                );
              }}
            >
              Clear current pins
            </button>
          )}
        </div>
        {!evidence.length && (
          <p className={s.caption}>
            Use “Pin evidence” in Security Finder, comparisons, allocations, or
            portfolio changes to collect a finding.
          </p>
        )}
        <div className={b.pinGrid}>
          {evidence.map((entry: any) => (
            <article key={entry.id} className={b.pin}>
              <div className={b.editorHeading}>
                <strong>{entry.title}</strong>
                <button
                  className={s.secondary}
                  aria-label={`Remove pinned ${entry.title}`}
                  onClick={() => {
                    if (
                      onRestoreEvidence(
                        evidence.filter((item: any) => item.id !== entry.id),
                      ) !== false
                    )
                      setMessage(
                        "Evidence removed from the current workspace. Saved boards are preserved.",
                      );
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <p>{entry.summary}</p>
              <small>
                {entry.sources
                  .map((source: any) => `${source.ticker} ${source.asOf}`)
                  .join(" · ")}
              </small>
              <details>
                <summary>Recorded values and SEC sources</summary>
                <dl className={b.values}>
                  {entry.values.map((value: any, index: number) => (
                    <div key={index}>
                      <dt>{value.label}</dt>
                      <dd>
                        {value.value === null
                          ? "Unavailable"
                          : String(value.value)}{" "}
                        {value.unit}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className={s.caption}>{entry.methodology}</p>
                {entry.sources.map((source: any, index: number) => (
                  <a
                    key={index}
                    href={source.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.ticker} · {source.accession} · filed{" "}
                    {source.filingDate} ↗
                  </a>
                ))}
              </details>
            </article>
          ))}
        </div>
      </section>
      {brief && (
        <section
          ref={previewRef}
          tabIndex={-1}
          className={b.preview}
          aria-label="Exact fund research brief preview"
        >
          <div className={s.sectionHeading}>
            <div>
              <h3>Exact research brief preview</h3>
              <p className={s.caption}>
                Captured for export {brief.exportedAt}. The HTML and CSV
                downloads use this exact preview; later edits require a new
                preview.
              </p>
            </div>
            <div className={s.actions}>
              <button
                className={s.primary}
                onClick={() => {
                  downloadText(
                    `fund-board-${brief.board.id}.html`,
                    html,
                    "text/html",
                  );
                  setMessage(
                    "HTML brief download started from the exact preview.",
                  );
                }}
              >
                <Download size={15} /> Download HTML
              </button>
              <button
                className={s.secondary}
                onClick={() => {
                  downloadText(
                    `fund-board-${brief.board.id}.csv`,
                    fundBoardBriefCsv(brief),
                    "text/csv",
                  );
                  setMessage(
                    "Structured CSV download started with captured evidence, source links, settings, and notes.",
                  );
                }}
              >
                <Download size={15} /> Download CSV
              </button>
              <button className={s.secondary} onClick={() => setBrief(null)}>
                Close preview
              </button>
            </div>
          </div>
          <iframe
            title="Exact fund board brief"
            srcDoc={html}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            className={b.frame}
          />
        </section>
      )}
    </section>
  );
}
