"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BRIEF_STATUSES,
  RESEARCH_BRIEFS_KEY,
  briefJson,
  briefMarkdown,
  createBriefSource,
  createResearchBrief,
  isBriefSourceUrl,
  readResearchBriefs,
  writeResearchBrief,
} from "../../utils/researchBriefs.js";
import { readResearchVault } from "../../utils/researchVault.js";
import styles from "./ResearchBriefs.module.css";

type Brief = ReturnType<typeof createResearchBrief>;
type BriefSource = Brief["sources"][number];
type BriefRequest = {
  nonce: number;
  briefId?: string;
  title?: string;
  ticker?: string;
  cik?: string;
  portfolioId?: string;
  question?: string;
  sources?: unknown[];
};
type Props = {
  request?: BriefRequest;
  onNavigate: (view: string, options?: { portfolioId?: string }) => void;
};
type VaultEntry = {
  id: string;
  title: string;
  ticker: string;
  source: string;
  type: string;
  href?: string;
  sourceUrl?: string;
  sources?: { url: string; label?: string; capturedAt?: string }[];
};
type Pending =
  | { kind: "new" }
  | { kind: "existing"; id: string }
  | { kind: "request"; request: BriefRequest };
const emptyStore = {
  version: 1,
  briefs: [] as Brief[],
  activeId: null as string | null,
};
const formatDate = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The research brief could not be updated.";
const writingFields = [
  {
    key: "question",
    label: "Research question",
    hint: "What specific question will this brief answer?",
    placeholder:
      "Can the company sustain its operating cash flow as investment grows?",
    rows: 2,
  },
  {
    key: "thesis",
    label: "Working thesis",
    hint: "State your interpretation. Cite source numbers when you make a claim.",
    placeholder:
      "My current interpretation, with the evidence that supports it…",
    rows: 5,
  },
  {
    key: "risks",
    label: "Risks and counterevidence",
    hint: "Record what could change your view and any contradictory evidence.",
    placeholder:
      "What would challenge this thesis? What evidence is still missing?",
    rows: 4,
  },
  {
    key: "nextSteps",
    label: "Next steps",
    hint: "Turn open questions into the next research actions.",
    placeholder: "Review the next filing, verify a source, compare a peer…",
    rows: 3,
  },
] as const;

export default function ResearchBriefs({ request, onNavigate }: Props) {
  const [store, setStore] = useState(emptyStore);
  const [draft, setDraft] = useState<Brief>(() => createResearchBrief());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [pending, setPending] = useState<Pending | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [includePrivate, setIncludePrivate] = useState(false);
  const [copyFallback, setCopyFallback] = useState("");
  const seenRequest = useRef<number | null>(null);
  const editor = useRef({ draft, selectedId, dirty });
  const heading = useRef<HTMLInputElement>(null);

  function loadBrief(brief: Brief | null) {
    const next = brief ? structuredClone(brief) : createResearchBrief();
    editor.current = {
      draft: next,
      selectedId: brief?.id || null,
      dirty: false,
    };
    setDraft(next);
    setSelectedId(brief?.id || null);
    setDirty(false);
    setDeleteConfirm(false);
    setIncludePrivate(false);
    setCopyFallback("");
    setError("");
  }
  function updateDraft(patch: Partial<Brief>) {
    setDraft((current) => {
      const next = { ...current, ...patch };
      editor.current = { ...editor.current, draft: next, dirty: true };
      return next;
    });
    setDirty(true);
    setCopyFallback("");
  }

  useEffect(() => {
    const read = () => {
      try {
        const next = readResearchBriefs(
          localStorage.getItem(RESEARCH_BRIEFS_KEY),
        );
        setStore(next);
        setEntries(readResearchVault(localStorage).entries as VaultEntry[]);
        const current = editor.current;
        if (current.selectedId) {
          const saved = next.briefs.find(
            (brief: Brief) => brief.id === current.selectedId,
          );
          if (!saved || saved.updatedAt !== current.draft.updatedAt) {
            if (current.dirty)
              setNotice(
                "This brief changed in another tab. Your unsaved writing is preserved. Reload the saved version or save this draft as a new brief.",
              );
            else if (saved) loadBrief(saved);
            else {
              editor.current = { ...current, selectedId: null, dirty: true };
              setSelectedId(null);
              setDirty(true);
              setNotice(
                "This brief was removed elsewhere. Your open copy is preserved as an unsaved draft.",
              );
            }
          }
        }
      } catch (issue) {
        setError(messageOf(issue));
      }
      setLoaded(true);
    };
    read();
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith("edgar")) read();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("research-storage", read);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (editor.current.dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("research-storage", read);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  function applyRequest(next: BriefRequest) {
    try {
      if (next.briefId) {
        const saved = readResearchBriefs(
          localStorage.getItem(RESEARCH_BRIEFS_KEY),
        ).briefs.find((brief: Brief) => brief.id === next.briefId);
        if (!saved)
          throw new Error("This research brief is not saved in this browser.");
        loadBrief(saved);
        setNotice("Opened saved research brief.");
      } else {
        const sources: BriefSource[] = [];
        let skipped = 0;
        for (const value of next.sources || []) {
          if (value && typeof value === "object") {
            try {
              sources.push(createBriefSource(value));
            } catch {
              skipped += 1;
            }
          } else skipped += 1;
        }
        const nextDraft = createResearchBrief({
          title: next.title || "Untitled research brief",
          question: next.question || "",
          ticker: next.ticker || "",
          cik: next.cik || "",
          portfolioId: next.portfolioId || "",
          sources,
        });
        loadBrief(null);
        setDraft(nextDraft);
        setDirty(true);
        editor.current = { draft: nextDraft, selectedId: null, dirty: true };
        setNotice(
          `A new draft is ready for your research. Save it to keep it in this browser.${skipped ? ` ${skipped} source link${skipped === 1 ? " was" : "s were"} unavailable or invalid and could not be attached.` : ""}`,
        );
      }
      setPending(null);
      heading.current?.focus();
    } catch (issue) {
      setError(messageOf(issue));
    }
  }
  useEffect(() => {
    if (!loaded || !request || seenRequest.current === request.nonce) return;
    seenRequest.current = request.nonce;
    if (editor.current.dirty) setPending({ kind: "request", request });
    else applyRequest(request);
    // Each nonce is an explicit navigation action. Draft edits must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, request]);

  const filtered = useMemo(
    () =>
      store.briefs
        .filter(
          (brief) =>
            (statusFilter === "all" || brief.status === statusFilter) &&
            [brief.title, brief.question, brief.ticker, brief.cik].some(
              (value) =>
                value.toLowerCase().includes(query.toLowerCase().trim()),
            ),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [store.briefs, query, statusFilter],
  );
  const availableSources = useMemo(() => {
    const seen = new Set<string>();
    const choices: {
      id: string;
      label: string;
      ticker: string;
      origin: string;
      url: string;
      capturedAt?: string;
    }[] = [];
    for (const entry of entries) {
      const sources = [
        ...(entry.sources || []),
        ...(entry.sourceUrl ? [{ url: entry.sourceUrl }] : []),
        ...(entry.href && isBriefSourceUrl(entry.href)
          ? [{ url: entry.href }]
          : []),
      ];
      for (const source of sources) {
        const identity = `${entry.id}:${source.url}`;
        if (!isBriefSourceUrl(source.url) || seen.has(identity)) continue;
        seen.add(identity);
        choices.push({
          id: identity,
          label: "label" in source && source.label ? source.label : entry.title,
          ticker: entry.ticker,
          origin: entry.source,
          url: source.url,
          capturedAt: "capturedAt" in source ? source.capturedAt : undefined,
        });
      }
    }
    return choices.filter((source) =>
      [source.label, source.ticker, source.origin].some((value) =>
        value.toLowerCase().includes(sourceQuery.toLowerCase().trim()),
      ),
    );
  }, [entries, sourceQuery]);
  const sourceCounts = draft.sources.reduce(
    (counts: Record<string, number>, source: BriefSource) => ({
      ...counts,
      [source.annotation]: counts[source.annotation] + 1,
    }),
    { supports: 0, contradicts: 0, context: 0 },
  );

  function persist(mode: "create" | "update" | "duplicate" | "delete") {
    try {
      const current = editor.current;
      const {
        title,
        question,
        thesis,
        risks,
        nextSteps,
        status,
        ticker,
        cik,
        portfolioId,
        sources,
      } = current.draft;
      const fields = {
        title,
        question,
        thesis,
        risks,
        nextSteps,
        status,
        ticker,
        cik,
        portfolioId,
        sources,
      };
      const operation =
        mode === "create"
          ? { mode, brief: fields }
          : mode === "update"
            ? {
                mode,
                id: current.selectedId,
                expectedUpdatedAt: current.draft.updatedAt,
                patch: fields,
              }
            : {
                mode,
                id: current.selectedId,
                expectedUpdatedAt: current.draft.updatedAt,
              };
      const next = writeResearchBrief(localStorage, operation);
      setStore(next);
      loadBrief(
        next.briefs.find((brief: Brief) => brief.id === next.activeId) || null,
      );
      window.dispatchEvent(new Event("research-storage"));
      setNotice(
        mode === "delete"
          ? "Research brief deleted. Other research and source evidence were preserved."
          : mode === "duplicate"
            ? "Saved brief duplicated. Its source capture dates are preserved."
            : "Research brief saved in this browser.",
      );
      return true;
    } catch (issue) {
      setError(messageOf(issue));
      return false;
    }
  }
  function perform(action: Pending) {
    if (action.kind === "request") applyRequest(action.request);
    else if (action.kind === "new") {
      loadBrief(null);
      setNotice("New unsaved research brief.");
      setPending(null);
    } else {
      try {
        const saved = readResearchBriefs(
          localStorage.getItem(RESEARCH_BRIEFS_KEY),
        ).briefs.find((brief: Brief) => brief.id === action.id);
        if (!saved)
          throw new Error("This brief is no longer available in this browser.");
        loadBrief(saved);
        setNotice("");
        setPending(null);
      } catch (issue) {
        setError(messageOf(issue));
      }
    }
    heading.current?.focus();
  }
  function open(action: Pending) {
    if (dirty) setPending(action);
    else perform(action);
  }
  function addSource(source: {
    url: string;
    label?: string;
    origin?: string;
    capturedAt?: string;
  }) {
    try {
      if (draft.sources.length >= 100)
        throw new Error("A brief supports up to 100 SEC sources.");
      if (draft.sources.some((item: BriefSource) => item.url === source.url))
        throw new Error(
          "This SEC source is already attached. Add your interpretation to its annotation.",
        );
      const next = createBriefSource({
        url: source.url,
        label: source.label,
        origin: source.origin,
        capturedAt: source.capturedAt,
      });
      updateDraft({ sources: [...draft.sources, next] });
      setSourceUrl("");
      setSourceLabel("");
      setError("");
      setNotice(
        "Source attached to this draft. Add how it relates to your question, then save the brief.",
      );
    } catch (issue) {
      setError(messageOf(issue));
    }
  }
  function editSource(id: string, patch: Partial<BriefSource>) {
    updateDraft({
      sources: draft.sources.map((source: BriefSource) =>
        source.id === id ? { ...source, ...patch } : source,
      ),
    });
  }
  async function exportBrief(format: "markdown" | "json" | "copy") {
    try {
      const options = { includePrivate, unsaved: dirty || !selectedId };
      const content =
        format === "json"
          ? briefJson(draft, options)
          : briefMarkdown(draft, options);
      if (format === "copy") {
        try {
          await navigator.clipboard.writeText(content);
          setNotice(
            "Research context copied with the selected privacy setting.",
          );
        } catch {
          setCopyFallback(content);
          setNotice(
            "Automatic copy is unavailable. Select and copy the research context below.",
          );
        }
      } else {
        const blob = new Blob([content], {
          type:
            format === "json"
              ? "application/json;charset=utf-8"
              : "text/markdown;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${
          draft.title
            .replace(/[^a-z0-9-]/gi, "-")
            .replace(/-+/g, "-")
            .slice(0, 80) || "research-brief"
        }.${format === "json" ? "json" : "md"}`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice(
          `Downloaded ${format === "json" ? "JSON" : "Markdown"} with ${includePrivate ? "private writing included" : "private writing omitted"}.`,
        );
      }
      setError("");
    } catch (issue) {
      setError(messageOf(issue));
    }
  }

  return (
    <section className={styles.root} aria-labelledby="briefs-heading">
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>FROM EVIDENCE TO A POINT OF VIEW</p>
          <h2 id="briefs-heading">Build a sourced research brief.</h2>
          <p>
            Keep your question, interpretation, counterevidence, and next steps
            together. Every attached source stays one click away.
          </p>
        </div>
        <button
          type="button"
          className={styles.primary}
          onClick={() => open({ kind: "new" })}
          disabled={!loaded}
        >
          New research brief <span aria-hidden="true">＋</span>
        </button>
      </header>
      <p className={styles.privacy}>
        Private to this browser. Writing is yours; the app does not generate or
        verify your conclusions. Saved briefs are included in research backups.
      </p>
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {pending && (
        <section className={styles.pending} aria-label="Unsaved brief decision">
          <h3>Keep your unsaved writing?</h3>
          <p>
            A different brief is ready to open. Save your current draft first,
            or explicitly discard its unsaved changes.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                if (persist(selectedId ? "update" : "create")) perform(pending);
              }}
            >
              Save and continue
            </button>
            <button type="button" onClick={() => perform(pending)}>
              Discard changes and continue
            </button>
            <button type="button" onClick={() => setPending(null)}>
              Stay with this draft
            </button>
          </div>
        </section>
      )}
      <div className={styles.layout}>
        <aside className={styles.library} aria-label="Saved research briefs">
          <div className={styles.sectionTitle}>
            <h3>Your briefs</h3>
            <span>{store.briefs.length}/50</span>
          </div>
          <label>
            Search briefs
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Title, question, or company"
            />
          </label>
          <label>
            Status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              {BRIEF_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status[0].toUpperCase() + status.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.briefList}>
            {filtered.map((brief) => (
              <button
                type="button"
                key={brief.id}
                className={`${styles.briefCard} ${selectedId === brief.id ? styles.selected : ""}`}
                aria-pressed={selectedId === brief.id}
                onClick={() => open({ kind: "existing", id: brief.id })}
              >
                <span className={styles.cardStatus}>
                  {brief.status} {brief.ticker ? `· ${brief.ticker}` : ""}
                </span>
                <strong>{brief.title}</strong>
                <span>
                  {brief.sources.length} SEC source
                  {brief.sources.length === 1 ? "" : "s"}
                </span>
                <small>Updated {formatDate(brief.updatedAt)}</small>
              </button>
            ))}
          </div>
          {!filtered.length && (
            <p className={styles.empty}>
              {store.briefs.length
                ? "No briefs match these filters."
                : "Start with a question. Your saved briefs will appear here."}
            </p>
          )}
          <button
            type="button"
            className={styles.textButton}
            onClick={() => onNavigate("library")}
          >
            Open research library & backups →
          </button>
        </aside>
        <article
          className={styles.editor}
          aria-label={
            selectedId
              ? "Edit saved research brief"
              : "New unsaved research brief"
          }
        >
          <div className={styles.editorTop}>
            <span className={styles.draftBadge}>
              {selectedId
                ? dirty
                  ? "UNSAVED CHANGES"
                  : "SAVED BRIEF"
                : "NEW · UNSAVED DRAFT"}
            </span>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                onClick={() => persist(selectedId ? "update" : "create")}
                disabled={!loaded}
              >
                {selectedId ? "Save changes" : "Save brief"}
              </button>
              {selectedId && (
                <button type="button" onClick={() => persist("create")}>
                  Save as new brief
                </button>
              )}
            </div>
          </div>
          <label className={styles.titleInput}>
            Brief title
            <input
              ref={heading}
              value={draft.title}
              maxLength={200}
              onChange={(event) => updateDraft({ title: event.target.value })}
              placeholder="Give your research a clear title"
            />
          </label>
          <div className={styles.contextGrid}>
            <label>
              Research status
              <select
                value={draft.status}
                onChange={(event) =>
                  updateDraft({ status: event.target.value })
                }
              >
                {BRIEF_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status[0].toUpperCase() + status.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Company ticker <span className={styles.optional}>Optional</span>
              <input
                value={draft.ticker}
                maxLength={15}
                onChange={(event) =>
                  updateDraft({
                    ticker: event.target.value.toUpperCase().trim(),
                  })
                }
                placeholder="AAPL"
              />
            </label>
            <label>
              Company CIK{" "}
              <span className={styles.optional}>Optional · ten digits</span>
              <input
                value={draft.cik}
                inputMode="numeric"
                maxLength={10}
                onChange={(event) => updateDraft({ cik: event.target.value })}
                placeholder="0000320193"
              />
            </label>
          </div>
          {draft.portfolioId && (
            <div className={styles.contextLink}>
              <span>Linked to a saved portfolio</span>
              <button
                type="button"
                onClick={() =>
                  onNavigate("portfolios", { portfolioId: draft.portfolioId })
                }
              >
                Open portfolio →
              </button>
              <button
                type="button"
                onClick={() => updateDraft({ portfolioId: "" })}
              >
                Remove link
              </button>
            </div>
          )}
          <p className={styles.small}>
            Status reflects your workflow. “Ready” does not certify completeness
            or accuracy.
          </p>
          {writingFields.map((field, index) => (
            <section className={styles.writing} key={field.key}>
              <div className={styles.writingHeading}>
                <span aria-hidden="true">0{index + 1}</span>
                <label htmlFor={`brief-${field.key}`}>{field.label}</label>
              </div>
              <p id={`brief-${field.key}-hint`}>{field.hint}</p>
              <textarea
                id={`brief-${field.key}`}
                value={draft[field.key]}
                maxLength={12000}
                rows={field.rows}
                aria-describedby={`brief-${field.key}-hint`}
                placeholder={field.placeholder}
                onChange={(event) =>
                  updateDraft({ [field.key]: event.target.value })
                }
              />
              <small>
                {draft[field.key].length.toLocaleString()}/12,000 characters
              </small>
            </section>
          ))}
          <section
            className={styles.sources}
            aria-labelledby="brief-source-heading"
          >
            <div className={styles.sectionTitle}>
              <div>
                <p className={styles.eyebrow}>05 · THE EVIDENCE</p>
                <h3 id="brief-source-heading">SEC source register</h3>
              </div>
              <span>{draft.sources.length}/100</span>
            </div>
            <p>
              Attach a source, then explain its role. Your classifications are
              interpretations; a citation alone does not verify a claim.
            </p>
            <div className={styles.evidenceCounts}>
              <span>{sourceCounts.supports} support</span>
              <span>{sourceCounts.contradicts} challenge</span>
              <span>{sourceCounts.context} add context</span>
            </div>
            {!draft.sources.length && (
              <div className={styles.empty}>
                <strong>No sources attached yet.</strong>
                <p>
                  Add saved SEC evidence or paste a SEC link below. This brief
                  currently has no linked evidence.
                </p>
              </div>
            )}
            <ol className={styles.sourceList}>
              {draft.sources.map((source: BriefSource, index: number) => (
                <li key={source.id} className={styles.sourceCard}>
                  <div className={styles.sourceHeading}>
                    <span className={styles.sourceNumber}>[{index + 1}]</span>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.label} ↗
                    </a>
                    <button
                      type="button"
                      className={styles.textButton}
                      aria-label={`Remove source ${index + 1}: ${source.label}`}
                      onClick={() =>
                        updateDraft({
                          sources: draft.sources.filter(
                            (item: BriefSource) => item.id !== source.id,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                  <p className={styles.sourceUrl}>{source.url}</p>
                  <small>
                    Captured {formatDate(source.capturedAt)} · {source.origin}
                  </small>
                  <div className={styles.sourceFields}>
                    <label>
                      Role in your research
                      <select
                        value={source.annotation}
                        onChange={(event) =>
                          editSource(source.id, {
                            annotation: event.target.value,
                          })
                        }
                      >
                        <option value="context">Adds context</option>
                        <option value="supports">Supports thesis</option>
                        <option value="contradicts">Challenges thesis</option>
                      </select>
                    </label>
                    <label>
                      Your annotation
                      <textarea
                        rows={2}
                        maxLength={4000}
                        value={source.notes}
                        onChange={(event) =>
                          editSource(source.id, { notes: event.target.value })
                        }
                        placeholder="Which passage or figure matters, and why?"
                      />
                    </label>
                  </div>
                </li>
              ))}
            </ol>
            <details className={styles.sourcePicker}>
              <summary>
                Add evidence from your research library{" "}
                <span>{availableSources.length} SEC links</span>
              </summary>
              <p>
                Only the source label, SEC link, origin, and capture date are
                copied. Private notes stay in the original research.
              </p>
              <label>
                Find saved SEC evidence
                <input
                  type="search"
                  value={sourceQuery}
                  onChange={(event) => setSourceQuery(event.target.value)}
                  placeholder="Company, source, or title"
                />
              </label>
              <div className={styles.sourceChoices}>
                {availableSources.map((source) => {
                  const attached = draft.sources.some(
                    (item: BriefSource) => item.url === source.url,
                  );
                  return (
                    <div key={source.id} className={styles.sourceChoice}>
                      <div>
                        <strong>{source.label}</strong>
                        <small>
                          {source.ticker} · {source.origin}
                        </small>
                      </div>
                      <button
                        type="button"
                        disabled={attached || draft.sources.length >= 100}
                        onClick={() => addSource(source)}
                      >
                        {attached ? "Attached" : "Attach source"}
                      </button>
                    </div>
                  );
                })}
              </div>
              {!availableSources.length && (
                <p>
                  No saved SEC source links match. Save source evidence from
                  your research tools or add a SEC URL below.
                </p>
              )}
            </details>
            <details className={styles.manualSource}>
              <summary>Add a SEC source link</summary>
              <label>
                Source label
                <input
                  value={sourceLabel}
                  maxLength={300}
                  onChange={(event) => setSourceLabel(event.target.value)}
                  placeholder="Apple 2025 Form 10-K — cash flow statement"
                />
              </label>
              <label>
                HTTPS SEC URL
                <input
                  value={sourceUrl}
                  type="url"
                  maxLength={2000}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="https://www.sec.gov/Archives/…"
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  addSource({
                    label: sourceLabel.trim(),
                    url: sourceUrl.trim(),
                  })
                }
                disabled={!sourceLabel.trim() || !sourceUrl.trim()}
              >
                Attach SEC source
              </button>
            </details>
          </section>
          <section
            className={styles.export}
            aria-labelledby="brief-export-heading"
          >
            <p className={styles.eyebrow}>TAKE YOUR RESEARCH WITH YOU</p>
            <h3 id="brief-export-heading">Export a clear, cited brief.</h3>
            <p>
              Exports include the current draft, source URLs, source capture
              dates, and an export timestamp. Title and company context are
              always included.
            </p>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={includePrivate}
                onChange={(event) => {
                  setIncludePrivate(event.target.checked);
                  setCopyFallback("");
                }}
              />
              <span>Include my private writing and source interpretations</span>
            </label>
            <p
              className={includePrivate ? styles.privateWarning : styles.small}
            >
              {includePrivate
                ? "Your question, thesis, risks, next steps, and annotations will leave this browser in the exported file or copied text. Check before sharing or using another AI tool."
                : "Private writing and annotations are omitted by default. Export the source register alone, or explicitly include your writing above."}
            </p>
            <div className={styles.actions}>
              <button type="button" onClick={() => exportBrief("markdown")}>
                Download Markdown
              </button>
              <button type="button" onClick={() => exportBrief("json")}>
                Download JSON
              </button>
              <button type="button" onClick={() => exportBrief("copy")}>
                Copy research context
              </button>
            </div>
            {copyFallback && (
              <label>
                Research context — select all to copy
                <textarea
                  rows={10}
                  readOnly
                  value={copyFallback}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            )}
          </section>
          {selectedId && (
            <footer className={styles.manage}>
              <p>
                Created {formatDate(draft.createdAt)} · Saved{" "}
                {formatDate(draft.updatedAt)}
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={dirty}
                  onClick={() => persist("duplicate")}
                >
                  Duplicate saved brief
                </button>
                <button
                  type="button"
                  onClick={() => open({ kind: "existing", id: selectedId })}
                >
                  Reload saved version
                </button>
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => setDeleteConfirm(true)}
                >
                  Delete brief
                </button>
              </div>
              {dirty && (
                <p className={styles.small}>
                  Save or reload your changes before duplicating the saved
                  brief.
                </p>
              )}
              {deleteConfirm && (
                <div className={styles.pending}>
                  <strong>Delete “{draft.title}” from this browser?</strong>
                  <p>
                    This removes the brief and its annotations. Original saved
                    evidence remains in the research library. Export first if
                    you need a copy.
                  </p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.danger}
                      onClick={() => persist("delete")}
                    >
                      Confirm deletion
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirm(false)}
                    >
                      Keep brief
                    </button>
                  </div>
                </div>
              )}
            </footer>
          )}
        </article>
      </div>
    </section>
  );
}
