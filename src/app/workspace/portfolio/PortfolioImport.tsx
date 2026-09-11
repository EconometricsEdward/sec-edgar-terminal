"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  FileUp,
  ListPlus,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import {
  applyDuplicateDecision,
  createPortfolioRows,
  duplicateGroups,
  MAX_PORTFOLIO_CELL_LENGTH,
  MAX_PORTFOLIO_ROWS,
  PORTFOLIO_COLUMNS,
  PORTFOLIO_SCHEMA_VERSION,
  resolvePortfolioRowCandidate,
  undoPortfolioMerge,
  validatePortfolioRow,
} from "../../../utils/portfolioModel.js";
import {
  mapPortfolioColumns,
  parsePortfolioFile,
  parseTickerList,
} from "../../../utils/portfolioFiles.js";
import s from "./PortfolioImport.module.css";

type Props = {
  initialRows?: any[];
  watchlist: any[];
  onCommit: (
    rows: any[],
    name: string,
    settings?: { allocation?: any; research?: any },
  ) => void;
  onCancel?: () => void;
  initialName?: string;
  initialAction?: "new" | "paste" | "watchlist";
  onDirtyChange?: (dirty: boolean) => void;
};

const IDENTITY_FIELDS = ["ticker", "company_name", "cik", "exchange"];
const FIELD_LABELS: Record<string, string> = {
  ticker: "Ticker",
  company_name: "Company name",
  cik: "SEC CIK",
  exchange: "Exchange",
  weight_pct: "Weight (%)",
  market_value: "Total position value",
  shares: "Shares",
  currency: "Value currency",
  as_of_date: "Holdings date",
  notes: "Private notes",
};
const BATCH_SIZE = 25;
const hasValue = (value: any) =>
  value !== "" && value !== null && value !== undefined;
const inputLabel = (row: any) =>
  row.input?.ticker ||
  row.input?.company_name ||
  (row.input?.cik ? `CIK ${row.input.cik}` : "Missing identifier");
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "This step could not be completed. Please retry.";
const COPY_EXAMPLE = JSON.stringify(
  {
    schema_version: PORTFOLIO_SCHEMA_VERSION,
    name: "Example research universe",
    holdings: [{ ticker: "AAPL" }, { ticker: "MSFT" }],
    allocation: { basis: "none", normalize: false },
    research: { basis: "annual" },
  },
  null,
  2,
);

export default function PortfolioImport({
  initialRows = [],
  watchlist,
  onCommit,
  onCancel,
  initialName = "My research universe",
  initialAction = "new",
  onDirtyChange,
}: Props) {
  const [name, setName] = useState(initialName);
  const [rows, setRows] = useState<any[]>(initialRows);
  const [parsed, setParsed] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [sourceName, setSourceName] = useState("");
  const [pasteOpen, setPasteOpen] = useState(initialAction !== "new");
  const [paste, setPaste] = useState(
    initialAction === "watchlist"
      ? watchlist
          .map((entry) => (typeof entry === "string" ? entry : entry.ticker))
          .filter(Boolean)
          .join("\n")
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("all");
  const [candidates, setCandidates] = useState<Record<string, string>>({});
  const [importSettings, setImportSettings] = useState<any>(null);
  const [applyImportSettings, setApplyImportSettings] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const pasteInput = useRef<HTMLTextAreaElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [initialDraft] = useState(() => ({
    name: initialName,
    rows: JSON.stringify(initialRows),
  }));
  const rowSignature = useMemo(() => JSON.stringify(rows), [rows]);
  const dirty =
    name !== initialDraft.name ||
    rowSignature !== initialDraft.rows ||
    paste.length > 0 ||
    parsed !== null ||
    reading ||
    applyImportSettings;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (initialAction !== "new") pasteInput.current?.focus();
  }, [initialAction]);

  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );

  const duplicates = useMemo(() => duplicateGroups(rows), [rows]);
  const pendingDuplicates = duplicates.filter((group) => !group.decided);
  const included = rows.filter((row) => !row.excluded);
  const resolved = included.filter(
    (row) => row.resolution?.status === "resolved",
  );
  const needsReview = included.filter(
    (row) =>
      row.resolution?.status !== "resolved" || !validatePortfolioRow(row).valid,
  );
  const visibleRows = rows.filter(
    (row) =>
      filter === "all" ||
      (filter === "review"
        ? !row.excluded &&
          (row.resolution?.status !== "resolved" ||
            !validatePortfolioRow(row).valid)
        : row.excluded),
  );
  const anyAllocation = rows.some((row) =>
    ["weight_pct", "market_value", "shares"].some((field) =>
      hasValue(row.input?.[field]),
    ),
  );
  const working = busy || reading;

  function cancelLookup() {
    generation.current++;
    controller.current?.abort();
    setBusy(false);
    setReading(false);
    setStatus(
      "Stopped. Completed matches are retained; you can retry the remaining rows.",
    );
  }

  async function resolveRows(nextRows: any[]) {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const token = ++generation.current;
    const pending = nextRows.filter(
      (row) => !row.excluded && row.resolution?.status !== "resolved",
    );
    if (!pending.length) {
      setStatus("Included identities are ready for review.");
      return;
    }
    setError("");
    setBusy(true);
    setCompleted(0);
    setTotal(pending.length);
    setStatus(`Checking ${pending.length} identities against SEC directories…`);
    let checked = 0,
      failed = 0;
    try {
      for (let start = 0; start < pending.length; start += BATCH_SIZE) {
        request.signal.throwIfAborted();
        const batch = pending.slice(start, start + BATCH_SIZE);
        try {
          const response = await fetch("/api/v1/portfolio-research", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(55000),
            ]),
            body: JSON.stringify({
              schema_version: PORTFOLIO_SCHEMA_VERSION,
              action: "resolve",
              holdings: batch.map((row) =>
                Object.fromEntries(
                  IDENTITY_FIELDS.map((field) => [
                    field,
                    String(row.input?.[field] ?? ""),
                  ]),
                ),
              ),
            }),
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(
              result.error ||
                "The SEC identity lookup failed. Retry these rows.",
            );
          if (
            !Array.isArray(result.rows) ||
            result.rows.length !== batch.length ||
            result.rows.some(
              (row: any) =>
                !row.resolution || typeof row.resolution.status !== "string",
            )
          )
            throw new Error(
              "The identity lookup returned an incomplete response. Retry these rows.",
            );
          if (generation.current !== token || request.signal.aborted) return;
          // Server rows deliberately contain only identifiers. Private position inputs
          // and original upload cells stay in the browser and are never replaced.
          const resolutions = new Map(
            batch.map((row, index) => [row.id, result.rows[index].resolution]),
          );
          setRows((previous) =>
            previous.map((row) =>
              resolutions.has(row.id)
                ? { ...row, resolution: resolutions.get(row.id) }
                : row,
            ),
          );
        } catch (failure) {
          if (request.signal.aborted || generation.current !== token) return;
          failed += batch.length;
          const ids = new Set(batch.map((row) => row.id));
          setRows((previous) =>
            previous.map((row) =>
              ids.has(row.id)
                ? {
                    ...row,
                    resolution: {
                      ...row.resolution,
                      status: "unresolved",
                      warnings: [
                        `Identity lookup failed: ${errorMessage(failure)}`,
                      ],
                    },
                  }
                : row,
            ),
          );
        }
        checked += batch.length;
        setCompleted(checked);
        setStatus(
          `Checked ${checked} of ${pending.length} identities${failed ? `; ${failed} need a retry` : ""}.`,
        );
      }
      if (generation.current === token)
        setStatus(
          failed
            ? `Identity checks finished with ${failed} retrieval failures. Other matches remain usable. Retry or correct the affected rows.`
            : "Identity checks finished. Review the companies, any flagged rows, and duplicate decisions below.",
        );
    } catch (failure) {
      if (!request.signal.aborted && generation.current === token)
        setError(errorMessage(failure));
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }

  function beginReview(
    holdings: any[],
    importedWarnings: string[] = [],
    rowChoices: any[] = [],
    settings: any = null,
  ) {
    if (!holdings.length)
      throw new Error("Add at least one company before reviewing the import.");
    const nextRows = createPortfolioRows(holdings, rowChoices);
    setRows(nextRows);
    setParsed(null);
    setWarnings(importedWarnings);
    setCandidates({});
    setFilter("all");
    setError("");
    setImportSettings(settings);
    setApplyImportSettings(false);
    window.requestAnimationFrame(() => reviewHeading.current?.focus());
    void resolveRows(nextRows);
  }

  async function readFile(file: File) {
    controller.current?.abort();
    const token = ++generation.current;
    setBusy(false);
    setReading(true);
    setError("");
    setStatus(`Reading ${file.name} in this browser…`);
    try {
      const next = await parsePortfolioFile(file);
      if (generation.current !== token) return;
      if (!next.records.length)
        throw new Error(
          "This template has no company rows yet. Enter at least one ticker, company name, or CIK, then upload it again.",
        );
      setParsed(next);
      setMapping(next.suggestedMapping as Record<string, string>);
      setSourceName(file.name);
      setWarnings(next.warnings || []);
      if (next.metadata?.name) setName(next.metadata.name);
      setStatus(
        `${next.records.length} rows read locally. Confirm the column mapping, then review company identities.`,
      );
    } catch (failure) {
      if (generation.current === token) setError(errorMessage(failure));
    } finally {
      if (generation.current === token) setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function importMapped() {
    try {
      const notices = [...(parsed.warnings || [])];
      if (parsed.metadata?.row_choices?.length) {
        notices.push(
          "This JSON file supplies explicit keep or exclude decisions for duplicate positions. Review the included and excluded rows below before saving.",
        );
      }
      const settings =
        parsed.metadata?.format === "json"
          ? {
              allocation: parsed.metadata.allocation,
              research: parsed.metadata.research,
            }
          : null;
      beginReview(
        mapPortfolioColumns(parsed, mapping),
        notices,
        parsed.metadata?.row_choices || [],
        settings,
      );
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  function editRow(rowId: string, field: string, value: string) {
    setRows((previous) =>
      previous.map((row) => {
        if (row.id !== rowId) return row;
        const changedIdentity = IDENTITY_FIELDS.includes(field);
        return {
          ...row,
          originalInput: row.originalInput || { ...row.input },
          input: { ...row.input, [field]: value },
          duplicateChoice: null,
          ...(changedIdentity
            ? {
                resolution: {
                  status: "unresolved",
                  kind: "unknown",
                  ticker: "",
                  cik: "",
                  name: "",
                  candidates: [],
                  warnings: [
                    "Identifier edited. Recheck identities to verify this row.",
                  ],
                },
              }
            : {}),
        };
      }),
    );
    if (IDENTITY_FIELDS.includes(field))
      setCandidates((previous) => ({ ...previous, [rowId]: "" }));
  }

  function chooseCandidate(row: any) {
    try {
      const selected = row.resolution.candidates[Number(candidates[row.id])];
      if (!selected)
        throw new Error("Choose a company before confirming its identity.");
      setRows((previous) =>
        previous.map((item) =>
          item.id === row.id
            ? {
                ...resolvePortfolioRowCandidate(item, selected),
                duplicateChoice: null,
              }
            : item,
        ),
      );
      setError("");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  function decideDuplicate(ids: string[], decision: string) {
    try {
      setRows(applyDuplicateDecision(rows, ids, decision));
      setError("");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  async function copyExample() {
    try {
      await navigator.clipboard.writeText(COPY_EXAMPLE);
      setStatus(
        "The JSON research-universe example was copied. It contains no allocation assumptions.",
      );
    } catch {
      setError(
        "Clipboard access was unavailable. Select and copy the visible JSON example below.",
      );
    }
  }

  return (
    <section className={s.importer} aria-labelledby="portfolio-import-title">
      <header className={s.header}>
        <div>
          <span className={s.eyebrow}>1. Import · 2. Review · 3. Research</span>
          <h2 id="portfolio-import-title">
            {initialRows.length
              ? "Edit your research universe"
              : "Start with your companies"}
          </h2>
          <p>A ticker list is enough. Holdings and allocations are optional.</p>
        </div>
        {onCancel && (
          <button
            type="button"
            className={s.secondary}
            onClick={() => {
              cancelLookup();
              onCancel();
            }}
          >
            Cancel
          </button>
        )}
      </header>

      <label className={s.nameLabel}>
        Portfolio or research-universe name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          placeholder="My research universe"
          autoComplete="off"
        />
      </label>

      <div className={s.entryGrid}>
        <div className={s.entryCard}>
          <Download size={21} aria-hidden="true" />
          <strong>Download a blank template</strong>
          <p>Fill in tickers; add allocations only if useful.</p>
          <div className={s.inlineLinks}>
            <a href="/portfolio/portfolio-template.csv" download>
              Blank CSV
            </a>
            <a href="/portfolio/portfolio-template.xlsx" download>
              Blank Excel
            </a>
          </div>
        </div>
        <div
          className={`${s.entryCard} ${s.dropzone} ${dragging ? s.dragging : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!working) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (working) return;
            if (event.dataTransfer.files.length !== 1) {
              setError("Drop one CSV, XLSX, or JSON file at a time.");
              return;
            }
            void readFile(event.dataTransfer.files[0]);
          }}
        >
          <FileUp size={21} aria-hidden="true" />
          <strong>Upload portfolio</strong>
          <p>Drop a CSV, XLSX, or JSON file here.</p>
          <button
            type="button"
            className={s.secondary}
            disabled={working}
            onClick={() => fileInput.current?.click()}
          >
            Choose file
          </button>
          <input
            ref={fileInput}
            type="file"
            className={s.srOnly}
            tabIndex={-1}
            aria-label="Upload portfolio CSV, XLSX, or JSON"
            accept=".csv,.xlsx,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
        </div>
        <div className={s.entryCard}>
          <ListPlus size={21} aria-hidden="true" />
          <strong>Paste tickers</strong>
          <p>Use commas, spaces, or a new line for each.</p>
          <button
            type="button"
            className={s.secondary}
            disabled={working}
            onClick={() => {
              setPasteOpen(true);
              window.requestAnimationFrame(() => pasteInput.current?.focus());
            }}
          >
            Paste a list
          </button>
        </div>
        <div className={s.entryCard}>
          <CheckCircle2 size={21} aria-hidden="true" />
          <strong>Use watchlist</strong>
          <p>Make a separate copy of your saved list.</p>
          <button
            type="button"
            className={s.secondary}
            disabled={working || !watchlist.length}
            onClick={() => {
              try {
                setSourceName("Watchlist");
                beginReview(
                  watchlist.map((entry) => ({
                    ticker:
                      typeof entry === "string" ? entry : entry.ticker || "",
                    ...(!entry.ticker && typeof entry !== "string" && entry.cik
                      ? { cik: String(entry.cik) }
                      : {}),
                  })),
                );
              } catch (failure) {
                setError(errorMessage(failure));
              }
            }}
          >
            Use watchlist ({watchlist.length})
          </button>
        </div>
      </div>

      <aside className={s.demo} aria-labelledby="portfolio-demo-title">
        <div>
          <h3 id="portfolio-demo-title">Try the hypothetical weighted demo</h3>
          <p>
            Explore 100 companies with example weights totaling 100%. After CSV
            or Excel import, select supplied weight percentages in Allocation
            settings.
          </p>
        </div>
        <div className={s.inlineLinks}>
          <a href="/portfolio/portfolio-demo-100.csv" download>
            <Download size={14} aria-hidden="true" /> Weighted CSV
          </a>
          <a href="/portfolio/portfolio-demo-100.xlsx" download>
            <Download size={14} aria-hidden="true" /> Weighted Excel
          </a>
          <a href="/workspace/demo" target="_blank" rel="noopener noreferrer">
            Preview example results (new tab) ↗
          </a>
        </div>
      </aside>

      <div className={s.privacy}>
        <ShieldCheck size={17} aria-hidden="true" />
        <p>
          Files are parsed in this browser. Only company identifiers are sent
          for SEC lookups; allocations and notes stay here. Limits: 2 MB per
          file, {MAX_PORTFOLIO_ROWS} rows,{" "}
          {MAX_PORTFOLIO_CELL_LENGTH.toLocaleString()} characters per cell. Use
          values-only XLSX workbooks without formulas, macros, or external
          links.
        </p>
      </div>
      {!!rows.length && (
        <p className={s.hint}>
          A new upload, ticker list, or watchlist replaces this draft. Your
          saved research changes only when you save below.
        </p>
      )}

      {pasteOpen && (
        <div className={s.pastePanel}>
          <label htmlFor="portfolio-ticker-paste">Tickers to research</label>
          <textarea
            ref={pasteInput}
            id="portfolio-ticker-paste"
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            maxLength={MAX_PORTFOLIO_ROWS * (MAX_PORTFOLIO_CELL_LENGTH + 1)}
            placeholder="AAPL, MSFT, JPM"
            rows={3}
            disabled={working}
          />
          <div className={s.actions}>
            <button
              type="button"
              className={s.primary}
              disabled={working || !paste.trim()}
              onClick={() => {
                try {
                  setSourceName("Pasted tickers");
                  beginReview(parseTickerList(paste));
                  setPasteOpen(false);
                } catch (failure) {
                  setError(errorMessage(failure));
                }
              }}
            >
              Review tickers
            </button>
            <button
              type="button"
              className={s.secondary}
              disabled={working}
              onClick={() => setPasteOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}

      <details className={s.help}>
        <summary>Format help, sample files, and AI-generated inputs</summary>
        <p>
          Use <code>ticker</code>, <code>company_name</code>, or{" "}
          <code>cik</code> to identify a company. Company-name matches require
          confirmation. An exact CIK identifies a company; it does not assume a
          share class.
        </p>
        <dl className={s.definitions}>
          <div>
            <dt>weight_pct</dt>
            <dd>
              Percentage points: 12.5 means 12.5%. No automatic normalization.
            </dd>
          </div>
          <div>
            <dt>market_value</dt>
            <dd>Total position value, with its currency; not a share price.</dd>
          </div>
          <div>
            <dt>shares</dt>
            <dd>Share count only. Shares alone do not establish weights.</dd>
          </div>
          <div>
            <dt>currency / as_of_date</dt>
            <dd>
              Value currency, such as USD, and holdings date in YYYY-MM-DD
              format.
            </dd>
          </div>
          <div>
            <dt>notes</dt>
            <dd>
              Optional private text, excluded from research exports unless you
              opt in.
            </dd>
          </div>
        </dl>
        <div className={s.inlineLinks}>
          <a href="/portfolio/portfolio-example.csv" download>
            Fictional allocation example (CSV)
          </a>
          <a href="/portfolio/portfolio-example.json" download>
            JSON example
          </a>
          <a href="/portfolio/portfolio-schema.json" download>
            Versioned JSON schema
          </a>
          <a href="/workspace/portfolio-guide">Format & API documentation</a>
        </div>
        <p>
          Examples illustrate the format and are not a recommended portfolio.
          AI-prepared files go through the same validation and review.
        </p>
        <button type="button" className={s.secondary} onClick={copyExample}>
          Copy ticker-only JSON example
        </button>
        <pre tabIndex={0} aria-label="Copyable JSON portfolio example">
          {COPY_EXAMPLE}
        </pre>
      </details>

      {(status || working) && (
        <div className={s.status} role="status" aria-live="polite">
          {working && (
            <Loader2 size={17} className={s.spinner} aria-hidden="true" />
          )}
          <span>{status}</span>
          {working && (
            <button
              type="button"
              className={s.secondary}
              onClick={cancelLookup}
            >
              Stop
            </button>
          )}
        </div>
      )}
      {busy && (
        <progress
          className={s.progress}
          max={total || 1}
          value={completed}
          aria-label={`${completed} of ${total} company identities checked`}
        />
      )}
      {error && (
        <div role="alert" className={s.error}>
          {error}
        </div>
      )}

      {parsed && (
        <section className={s.mapping} aria-labelledby="portfolio-map-title">
          <h3 id="portfolio-map-title">Review columns in {sourceName}</h3>
          <p>
            {parsed.records.length} rows found. Map each source column to one
            field. Unmapped columns are retained as original input for review.
          </p>
          <div className={s.mappingGrid}>
            {parsed.headers.map((header: string, index: number) => (
              <label key={header}>
                <strong>{header}</strong>
                <span className={s.sample}>
                  Example:{" "}
                  {String(parsed.records[0]?.[index] ?? "Empty") || "Empty"}
                </span>
                <select
                  value={mapping[header] || ""}
                  disabled={working}
                  onChange={(event) =>
                    setMapping((previous) => ({
                      ...previous,
                      [header]: event.target.value,
                    }))
                  }
                  aria-label={`Map source column ${header}`}
                >
                  <option value="">Do not map</option>
                  {PORTFOLIO_COLUMNS.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className={s.actions}>
            <button
              type="button"
              className={s.primary}
              disabled={working}
              onClick={importMapped}
            >
              Review {parsed.records.length} rows
            </button>
            <button
              type="button"
              className={s.secondary}
              disabled={working}
              onClick={() => {
                setParsed(null);
                setWarnings([]);
                setStatus(
                  "File import dismissed. Existing draft rows are unchanged.",
                );
              }}
            >
              Dismiss file
            </button>
          </div>
        </section>
      )}
      {!!warnings.length && (
        <div className={s.notice}>
          <strong>Import notes</strong>
          <ul>
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {!!rows.length && (
        <section className={s.review} aria-labelledby="portfolio-review-title">
          <div className={s.reviewHeading}>
            <div>
              <h3 id="portfolio-review-title" ref={reviewHeading} tabIndex={-1}>
                Review your companies
              </h3>
              <p>
                {rows.length} input rows · {resolved.length} identified ·{" "}
                {needsReview.length} to review · {rows.length - included.length}{" "}
                excluded
              </p>
            </div>
            <button
              type="button"
              className={s.secondary}
              disabled={
                working ||
                !included.some((row) => row.resolution?.status !== "resolved")
              }
              onClick={() => void resolveRows(rows)}
            >
              Recheck identities
            </button>
          </div>
          <p className={s.hint}>
            {anyAllocation
              ? "Allocation values are retained exactly as entered. Choose an explicit weighting method in the research dashboard; unsupported or incomplete allocations will be flagged."
              : "No allocations supplied: this will be a company research universe. No weights or economic exposure are assumed."}{" "}
            Unresolved rows can be saved for correction while identified
            companies remain usable.
          </p>

          {!!duplicates.length && (
            <div className={s.duplicatePanel}>
              <h4>Review duplicate securities</h4>
              <p>
                Separate share classes remain separate positions. For repeated
                securities, choose how to retain them before saving.
              </p>
              {duplicates.map((group) => (
                <div key={group.key} className={s.duplicateGroup}>
                  <strong>
                    {group.key.replace(/^[^:]+:/, "")} · rows{" "}
                    {group.rowIds
                      .map((id) => rows.findIndex((row) => row.id === id) + 1)
                      .join(", ")}
                  </strong>
                  {group.decided ? (
                    <p>
                      Confirmed: keep separate positions. Company evidence is
                      retrieved once.
                    </p>
                  ) : (
                    <>
                      <div className={s.actions}>
                        <button
                          type="button"
                          className={s.secondary}
                          disabled={working}
                          onClick={() => decideDuplicate(group.rowIds, "keep")}
                        >
                          Keep separate
                        </button>
                        <button
                          type="button"
                          className={s.secondary}
                          disabled={working || !group.canMerge}
                          onClick={() => decideDuplicate(group.rowIds, "merge")}
                        >
                          Merge compatible rows
                        </button>
                        <button
                          type="button"
                          className={s.secondary}
                          disabled={working}
                          onClick={() =>
                            decideDuplicate(group.rowIds.slice(1), "remove")
                          }
                        >
                          Keep first; exclude repeats
                        </button>
                      </div>
                      {!group.canMerge && (
                        <p className={s.hint}>
                          Merge unavailable: {group.issues.join(" ")}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className={s.filterBar}>
            <label>
              Show rows
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">All ({rows.length})</option>
                <option value="review">
                  Needs review ({needsReview.length})
                </option>
                <option value="excluded">
                  Excluded ({rows.length - included.length})
                </option>
              </select>
            </label>
            <span>
              Expand a row to correct input or inspect private allocation
              fields.
            </span>
          </div>
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="Import review table; scroll horizontally on narrow screens"
          >
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Input row</th>
                  <th scope="col">Resolved company / security</th>
                  <th scope="col">Validation & action</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const index = rows.findIndex((item) => item.id === row.id);
                  const validation = validatePortfolioRow(row);
                  const resolution = row.resolution || {};
                  const original = row.originalInput || row.input;
                  const rowCandidates = resolution.candidates || [];
                  const mergedPosition =
                    Array.isArray(row.mergedRowIds) &&
                    row.mergedRowIds.length > 0;
                  const mergeLocked = !!row.mergedInto || mergedPosition;
                  return (
                    <tr
                      key={row.id}
                      className={row.excluded ? s.excluded : undefined}
                    >
                      <td>
                        <span className={s.rowNumber}>Row {index + 1}</span>
                        <strong className={s.inputName}>
                          {inputLabel(row)}
                        </strong>
                        <details className={s.rowDetails}>
                          <summary>Original input & edit</summary>
                          <div className={s.original}>
                            <strong>Original input</strong>
                            {Object.entries(original)
                              .filter(([, value]) => hasValue(value))
                              .map(([field, value]) => (
                                <div key={field}>
                                  <span>{field}</span>
                                  <span>{String(value)}</span>
                                </div>
                              ))}
                          </div>
                          {mergeLocked && (
                            <p className={s.hint}>
                              Undo the merge before editing these preserved
                              position inputs.
                            </p>
                          )}
                          <div className={s.rowEditor}>
                            {IDENTITY_FIELDS.map((field) => (
                              <label key={field}>
                                {FIELD_LABELS[field]}
                                <input
                                  value={row.input?.[field] ?? ""}
                                  disabled={working || mergeLocked}
                                  maxLength={MAX_PORTFOLIO_CELL_LENGTH}
                                  onChange={(event) =>
                                    editRow(row.id, field, event.target.value)
                                  }
                                  aria-label={`Row ${index + 1} ${FIELD_LABELS[field]}`}
                                />
                              </label>
                            ))}
                          </div>
                          <details className={s.allocationDetails}>
                            <summary>
                              Optional allocation & private notes
                            </summary>
                            <div className={s.rowEditor}>
                              {PORTFOLIO_COLUMNS.filter(
                                (field) => !IDENTITY_FIELDS.includes(field),
                              ).map((field) => (
                                <label key={field}>
                                  {FIELD_LABELS[field]}
                                  {field === "notes" ? (
                                    <textarea
                                      value={row.input?.[field] ?? ""}
                                      disabled={working || mergeLocked}
                                      maxLength={MAX_PORTFOLIO_CELL_LENGTH}
                                      onChange={(event) =>
                                        editRow(
                                          row.id,
                                          field,
                                          event.target.value,
                                        )
                                      }
                                      rows={3}
                                      aria-label={`Row ${index + 1} private notes`}
                                    />
                                  ) : (
                                    <input
                                      value={row.input?.[field] ?? ""}
                                      disabled={working || mergeLocked}
                                      inputMode={
                                        [
                                          "weight_pct",
                                          "market_value",
                                          "shares",
                                        ].includes(field)
                                          ? "decimal"
                                          : "text"
                                      }
                                      maxLength={MAX_PORTFOLIO_CELL_LENGTH}
                                      placeholder={
                                        field === "as_of_date"
                                          ? "YYYY-MM-DD"
                                          : field === "currency"
                                            ? "USD"
                                            : ""
                                      }
                                      onChange={(event) =>
                                        editRow(
                                          row.id,
                                          field,
                                          event.target.value,
                                        )
                                      }
                                      aria-label={`Row ${index + 1} ${FIELD_LABELS[field]}`}
                                    />
                                  )}
                                </label>
                              ))}
                            </div>
                          </details>
                        </details>
                        {["weight_pct", "market_value", "shares"].some(
                          (field) => hasValue(row.input?.[field]),
                        ) && (
                          <div className={s.allocationPreview}>
                            {hasValue(row.input?.weight_pct) && (
                              <span>Weight: {row.input.weight_pct}%</span>
                            )}
                            {hasValue(row.input?.market_value) && (
                              <span>
                                Value: {row.input.market_value}{" "}
                                {row.input.currency || "(currency missing)"}
                              </span>
                            )}
                            {hasValue(row.input?.shares) && (
                              <span>Shares: {row.input.shares}</span>
                            )}
                            {hasValue(row.input?.as_of_date) && (
                              <span>As of {row.input.as_of_date}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        <strong>
                          {resolution.name || "Identity not confirmed"}
                        </strong>
                        <div className={s.identifiers}>
                          {resolution.ticker && (
                            <span>{resolution.ticker}</span>
                          )}
                          {resolution.cik && <span>CIK {resolution.cik}</span>}
                        </div>
                        {resolution.kind === "fund" && (
                          <p>
                            Fund: company financial metrics are unavailable.{" "}
                            <a
                              href={
                                resolution.ticker
                                  ? `/fund?tickers=${encodeURIComponent(resolution.ticker)}`
                                  : "/fund"
                              }
                            >
                              Open Funds
                            </a>
                          </p>
                        )}
                        {resolution.needsVerification && (
                          <p>
                            Company CIK will be verified against SEC submissions
                            during research.
                          </p>
                        )}
                        {!!rowCandidates.length && (
                          <div className={s.candidateChoice}>
                            <label>
                              Confirm the intended company
                              <select
                                value={candidates[row.id] ?? ""}
                                disabled={
                                  working || row.excluded || mergeLocked
                                }
                                onChange={(event) =>
                                  setCandidates((previous) => ({
                                    ...previous,
                                    [row.id]: event.target.value,
                                  }))
                                }
                                aria-label={`Choose company for row ${index + 1}`}
                              >
                                <option value="">
                                  Choose a verified candidate
                                </option>
                                {rowCandidates.map(
                                  (candidate: any, candidateIndex: number) => (
                                    <option
                                      key={`${candidate.cik}:${candidate.ticker}`}
                                      value={candidateIndex}
                                    >
                                      {candidate.name} ·{" "}
                                      {candidate.ticker || "Company"} · CIK{" "}
                                      {candidate.cik}
                                    </option>
                                  ),
                                )}
                              </select>
                            </label>
                            <button
                              type="button"
                              className={s.secondary}
                              disabled={
                                working ||
                                row.excluded ||
                                mergeLocked ||
                                candidates[row.id] === undefined ||
                                candidates[row.id] === ""
                              }
                              onClick={() => chooseCandidate(row)}
                            >
                              Confirm identity
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        <span
                          className={`${s.badge} ${row.excluded ? s.neutral : resolution.status === "resolved" && validation.valid ? s.good : s.attention}`}
                        >
                          {row.mergedInto
                            ? `Already incorporated into row ${rows.findIndex((item) => item.id === row.mergedInto) + 1}. Undo that merge to restore this position.`
                            : row.excluded
                              ? "Excluded"
                              : resolution.status === "resolved" &&
                                  validation.valid
                                ? resolution.kind === "fund"
                                  ? "Fund · limited research"
                                  : "Identified"
                                : "Needs review"}
                        </span>
                        {!!resolution.warnings?.length && (
                          <ul className={s.rowWarnings}>
                            {resolution.warnings.map(
                              (warning: string, warningIndex: number) => (
                                <li key={warningIndex}>{warning}</li>
                              ),
                            )}
                          </ul>
                        )}
                        {!validation.valid && (
                          <ul className={s.rowWarnings}>
                            {validation.issues.map((issue: any) => (
                              <li key={issue.field}>{issue.message}</li>
                            ))}
                          </ul>
                        )}
                        <p className={s.proposedAction}>
                          {row.excluded
                            ? "Will be excluded from research and allocation calculations."
                            : row.duplicateChoice === "merge"
                              ? "Keep the merged position; original rows are retained."
                              : resolution.status === "resolved"
                                ? "Keep this position for research."
                                : "Retain for correction; no company research until resolved."}
                        </p>
                        <label className={s.includeToggle}>
                          <input
                            type="checkbox"
                            checked={!row.excluded}
                            disabled={working || !!row.mergedInto}
                            onChange={(event) =>
                              setRows((previous) =>
                                previous.map((item) =>
                                  item.id === row.id
                                    ? {
                                        ...item,
                                        excluded: !event.target.checked,
                                        duplicateChoice: mergedPosition
                                          ? "merge"
                                          : event.target.checked
                                            ? null
                                            : "remove",
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                          Include row {index + 1}
                        </label>
                        {mergedPosition && (
                          <button
                            type="button"
                            className={s.secondary}
                            disabled={working}
                            onClick={() => {
                              try {
                                setRows(undoPortfolioMerge(rows, row.id));
                                setError("");
                              } catch (failure) {
                                setError(errorMessage(failure));
                              }
                            }}
                          >
                            Undo merge
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!visibleRows.length && (
              <p className={s.empty}>No rows in this view.</p>
            )}
          </div>

          {importSettings && (
            <div className={s.notice}>
              <strong>Analysis settings in this JSON file</strong>
              <p>
                Weighting:{" "}
                {importSettings.allocation?.basis === "equal"
                  ? "Model as equal-weighted — an explicit assumption, not supplied holdings"
                  : importSettings.allocation?.basis === "weights"
                    ? "Supplied weight percentages"
                    : importSettings.allocation?.basis === "market_value"
                      ? "Comparable position values"
                      : "Research universe; no assumed weights"}
                . Normalization:{" "}
                {importSettings.allocation?.normalize
                  ? "requested; original inputs will be retained"
                  : "off"}
                . Reporting basis:{" "}
                {importSettings.research?.basis === "ttm"
                  ? "supported trailing twelve months"
                  : "latest annual"}
                .
              </p>
              <label className={s.includeToggle}>
                <input
                  type="checkbox"
                  checked={applyImportSettings}
                  onChange={(event) =>
                    setApplyImportSettings(event.target.checked)
                  }
                />
                Apply these imported analysis settings
              </label>
              <p className={s.hint}>
                Leave unchecked to use the dashboard’s existing settings. You
                can change the method after import.
              </p>
            </div>
          )}
          <div className={s.commitBar}>
            <div>
              <strong>
                {included.length}{" "}
                {included.length === 1 ? "position" : "positions"} to keep
              </strong>
              <p>
                {pendingDuplicates.length
                  ? "Choose how to handle each duplicate group before saving."
                  : `${resolved.length} identified; ${included.length - resolved.length} retained for identity review. Your existing watchlist is unchanged.`}
              </p>
            </div>
            <button
              type="button"
              className={s.primary}
              disabled={
                working ||
                !name.trim() ||
                !included.length ||
                !!pendingDuplicates.length ||
                !!parsed
              }
              onClick={() =>
                onCommit(
                  rows,
                  name.trim(),
                  applyImportSettings ? importSettings : undefined,
                )
              }
            >
              {initialRows.length ? "Save changes" : "Save & open research"}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
