"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  Download,
  FileUp,
  Search,
  ShieldCheck,
} from "lucide-react";
import { downloadText } from "../../utils/download.js";
import {
  RESEARCH_BACKUP_LIMIT,
  RESEARCH_STORAGE_EVENT,
  readResearchVault,
  exportResearchBackup,
  parseResearchBackup,
  previewResearchRestore,
  restoreResearchVault,
} from "../../utils/researchVault.js";
import styles from "./ResearchVault.module.css";

type Vault = ReturnType<typeof readResearchVault>;
type Backup = ReturnType<typeof parseResearchBackup>;
const emptyStorage = { getItem: () => null };
const browserStorage = {
  get length() {
    return window.localStorage.length;
  },
  key: (index: number) => window.localStorage.key(index),
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) =>
    window.localStorage.setItem(key, value),
  removeItem: (key: string) => window.localStorage.removeItem(key),
};

export default function ResearchVault() {
  const [vault, setVault] = useState<Vault>(() =>
    readResearchVault(emptyStorage),
  );
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("");
  const [backup, setBackup] = useState<Backup | null>(null);
  const [preview, setPreview] = useState<
    ReturnType<typeof previewResearchRestore>
  >([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [safetyBackup, setSafetyBackup] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [restored, setRestored] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectionGeneration = useRef(0);
  const refresh = useCallback(() => {
    setVault(readResearchVault(browserStorage));
    setReady(true);
  }, []);
  useEffect(() => {
    const pendingSelection = selectionGeneration;
    refresh();
    const sync = () => refresh();
    window.addEventListener("storage", sync);
    window.addEventListener(RESEARCH_STORAGE_EVENT, sync);
    window.addEventListener("focus", sync);
    return () => {
      pendingSelection.current++;
      window.removeEventListener("storage", sync);
      window.removeEventListener(RESEARCH_STORAGE_EVENT, sync);
      window.removeEventListener("focus", sync);
    };
  }, [refresh]);
  const rows = useMemo(() => {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return vault.entries.filter(
      (e) =>
        (source === "all" || e.source === source) &&
        (kind === "all" || e.type === kind) &&
        terms.every((term) =>
          `${e.ticker} ${e.title} ${e.text} ${e.source}`
            .toLowerCase()
            .includes(term),
        ),
    );
  }, [vault, query, source, kind]);
  const pages = Math.max(1, Math.ceil(rows.length / 12));
  const currentPage = Math.min(page, pages - 1);
  const visible = rows.slice(currentPage * 12, currentPage * 12 + 12);
  const filter = (callback: () => void) => {
    callback();
    setPage(0);
  };
  function downloadBackup(safety = false) {
    try {
      const raw = exportResearchBackup(browserStorage);
      downloadText(
        `edgar-${safety ? "before-restore" : "research-backup"}-${new Date().toISOString().slice(0, 10)}.json`,
        raw,
        "application/json",
      );
      if (safety) {
        setSafetyBackup(raw);
        setConfirmed(false);
      }
      setStatus(
        safety
          ? "Safety backup download started. Confirm you have kept the file before restoring selected stores."
          : "Full research backup download started. It includes all six research tools and every saved fund notebook in this browser.",
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "The backup could not be exported.",
      );
    }
  }
  async function chooseFile(file?: File) {
    const generation = ++selectionGeneration.current;
    setBackup(null);
    setPreview([]);
    setSelected([]);
    setSafetyBackup("");
    setConfirmed(false);
    setRestored(false);
    if (!file) return;
    setReading(true);
    setStatus("Validating backup…");
    try {
      if (file.size > RESEARCH_BACKUP_LIMIT)
        throw new Error("Choose a JSON backup no larger than 16 MiB.");
      const parsed = parseResearchBackup(await file.text());
      if (generation !== selectionGeneration.current) return;
      const next = previewResearchRestore(browserStorage, parsed);
      setBackup(parsed);
      setPreview(next);
      setSelected(
        next.filter((s) => s.available && !s.conflict).map((s) => s.key),
      );
      setStatus(
        "Backup validated. Selecting a file does not change saved research. Review each store below.",
      );
    } catch (error) {
      if (generation === selectionGeneration.current)
        setStatus(
          error instanceof Error
            ? error.message
            : "This backup could not be read.",
        );
    } finally {
      if (generation === selectionGeneration.current) setReading(false);
    }
  }
  function restore() {
    if (!backup || !safetyBackup || !confirmed) return;
    let success = false;
    try {
      const result = restoreResearchVault(
        browserStorage,
        backup,
        selected,
        safetyBackup,
      );
      window.dispatchEvent(new Event(RESEARCH_STORAGE_EVENT));
      setRestored(true);
      setStatus(
        `${result.restored} research ${result.restored === 1 ? "store" : "stores"} restored. Reload the workspace to refresh every open research component.`,
      );
      refresh();
      success = true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Restore failed.");
      setSafetyBackup("");
      setConfirmed(false);
      setPreview(previewResearchRestore(browserStorage, backup));
      refresh();
    }
    if (success) window.location.assign("/workspace");
  }
  return (
    <section
      className={styles.vault}
      id="research-vault"
      aria-labelledby="vault-title"
    >
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>
            <Archive size={15} /> Research library
          </span>
          <h2 id="vault-title">Every insight, one place.</h2>
          <p>
            Find saved evidence, research notes, searches, and pending reviews
            across the terminal.
          </p>
        </div>
        <button className={styles.button} type="button" onClick={refresh}>
          Refresh library
        </button>
      </div>
      <div className={styles.stats}>
        {[
          ["Evidence", vault.totals.evidence],
          ["Saved searches", vault.totals.searches],
          ["Pending reviews", vault.totals.queued],
          ["Entities", vault.totals.companies],
        ].map(([label, value]) => (
          <div key={label}>
            <b>{value}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className={styles.filters}>
        <label className={styles.search}>
          <Search size={16} />
          <span className={styles.srOnly}>Search saved research</span>
          <input
            value={query}
            onChange={(e) => filter(() => setQuery(e.target.value))}
            placeholder="Search ticker, quotation, note, or topic"
          />
        </label>
        <label>
          Research tool
          <select
            value={source}
            onChange={(e) => filter(() => setSource(e.target.value))}
          >
            <option value="all">All tools</option>
            {[
              "Analysis",
              "Compare",
              "Disclosures",
              "Filings",
              "Market",
              "Funds",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Item type
          <select
            value={kind}
            onChange={(e) => filter(() => setKind(e.target.value))}
          >
            <option value="all">All research</option>
            {[
              ["evidence", "Evidence"],
              ["note", "Notes"],
              ["search", "Saved searches"],
              ["queue", "Pending reviews"],
              ["company", "Companies"],
              ["fund", "Funds"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!ready ? (
        <p className={styles.empty}>Loading saved research…</p>
      ) : visible.length ? (
        <div className={styles.entries}>
          {visible.map((entry) => (
            <article className={styles.entry} key={entry.id}>
              <div className={styles.meta}>
                <span>
                  {entry.source} ·{" "}
                  {entry.type === "queue" ? "Pending review" : entry.type}
                </span>
                {entry.ticker && <strong>{entry.ticker}</strong>}
                {entry.date && <time>{entry.date.slice(0, 10)}</time>}
              </div>
              <h3>
                <Link href={entry.href}>
                  {entry.title}
                  <ArrowUpRight size={15} />
                </Link>
              </h3>
              {entry.text && <p>{entry.text}</p>}
              {entry.text &&
                ["note", "evidence", "queue"].includes(entry.type) && (
                  <details className={styles.savedText}>
                    <summary>
                      Read saved{" "}
                      {entry.type === "evidence" ? "evidence" : "notes"}
                    </summary>
                    <p>{entry.text}</p>
                    <Link href={entry.href}>
                      Open research tool <ArrowUpRight size={12} />
                    </Link>
                  </details>
                )}
            </article>
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          <h3>
            {vault.entries.length
              ? "No saved research matches these filters."
              : "Your research starts where you work."}
          </h3>
          <p>
            {vault.entries.length
              ? "Try another ticker, topic, or tool."
              : "Save a financial metric, a filing passage, a search, or a fund. It will appear here with a link back to its research tool."}
          </p>
          <Link href="/analysis/JPM?view=notebook">
            Open a company notebook <ArrowUpRight size={14} />
          </Link>
        </div>
      )}
      {rows.length > 12 && (
        <div className={styles.pagination}>
          <span>
            {rows.length} items · Page {currentPage + 1} of {pages}
          </span>
          <button
            className={styles.button}
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <button
            className={styles.button}
            disabled={currentPage >= pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}
      {vault.issues.length > 0 && (
        <div className={styles.warning} role="status">
          <strong>Some saved research could not be indexed.</strong>
          <p>
            Existing data is preserved and remains included in the full backup.
          </p>
          <ul>
            {vault.issues.map((issue) => (
              <li key={issue.key}>
                {issue.label}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className={styles.backup}>
        <summary>
          <ShieldCheck size={18} />
          <span>Backup and restore your complete research library</span>
          <span className={styles.badge}>6 research tools</span>
        </summary>
        <p>
          Download a portable copy before clearing browser data or moving
          computers. Backups include quotations and your private notes. Research
          stays in this browser until you export it.
        </p>
        <div className={styles.actions}>
          <button
            className={styles.primary}
            disabled={!ready}
            onClick={() => downloadBackup()}
          >
            <Download size={16} />
            Download full backup
          </button>
          <button
            className={styles.button}
            disabled={!ready || reading}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp size={16} />
            {reading ? "Reading backup…" : "Choose backup to restore"}
          </button>
          <input
            ref={fileInput}
            className={styles.srOnly}
            type="file"
            accept="application/json,.json"
            aria-label="Choose research backup JSON"
            onChange={(e) => void chooseFile(e.target.files?.[0])}
          />
        </div>
        {backup && (
          <div className={styles.restore}>
            <h3>Review what will be restored</h3>
            <p>
              {backup.exportedAt
                ? `Backup exported ${backup.exportedAt.slice(0, 19).replace("T", " ")} UTC. `
                : "Legacy company workspace backup. "}
              Each selected store replaces that tool’s current saved data in
              full. Stores with existing data are unchecked initially;
              unselected stores remain intact.
            </p>
            <div className={styles.storeList}>
              {preview.map((store) => (
                <label className={styles.store} key={store.key}>
                  <input
                    type="checkbox"
                    disabled={!store.available || restored}
                    checked={selected.includes(store.key)}
                    onChange={(e) => {
                      setSelected((s) =>
                        e.target.checked
                          ? [...s, store.key]
                          : s.filter((k) => k !== store.key),
                      );
                      setConfirmed(false);
                    }}
                  />
                  <span>
                    <strong>{store.label}</strong>
                    <small>
                      {store.error ||
                        (store.incomingEmpty
                          ? "No data in this backup; skipped"
                          : store.identical
                            ? "Already identical; no change"
                            : `${store.currentCount} current indexed items → ${store.incomingCount} backup items${store.conflict ? " · replaces existing data" : " · currently empty"}`)}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            {restored ? (
              <button
                className={styles.primary}
                onClick={() => window.location.assign("/workspace")}
              >
                Reload workspace
              </button>
            ) : (
              <>
                <div className={styles.actions}>
                  <button
                    className={styles.button}
                    disabled={!selected.length}
                    onClick={() => downloadBackup(true)}
                  >
                    <Download size={15} />
                    1. Download current data as safety backup
                  </button>
                </div>
                {safetyBackup && (
                  <label className={styles.confirm}>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    I have kept the safety backup and reviewed the selected
                    replacements.
                  </label>
                )}
                <button
                  className={styles.primary}
                  disabled={!selected.length || !safetyBackup || !confirmed}
                  onClick={restore}
                >
                  2. Restore {selected.length || "selected"} research{" "}
                  {selected.length === 1 ? "store" : "stores"}
                </button>
              </>
            )}
          </div>
        )}
      </details>
      <p className={styles.status} role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
