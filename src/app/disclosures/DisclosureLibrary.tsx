"use client";
import { useState } from "react";
import {
  Download,
  ExternalLink,
  FolderPlus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  exportDisclosureBrief,
  exportDisclosureCsv,
} from "../../utils/disclosureNotebook.js";
import type {
  DisclosureNotebook,
  Filing,
  SavedSearch,
  SearchSettings,
} from "./disclosureTypes";
import s from "./disclosures.module.css";

export function downloadDisclosure(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type Change = (
  update: (current: DisclosureNotebook) => DisclosureNotebook,
) => void;
export function DisclosureInbox({
  notebook,
  change,
  check,
  open,
  load,
  checking,
}: {
  notebook: DisclosureNotebook;
  change: Change;
  check: (saved: SavedSearch) => void;
  open: (filing: Filing, settings: SearchSettings) => void;
  load: (settings: SearchSettings) => void;
  checking: string;
}) {
  const [showReviewed, setShowReviewed] = useState(false);
  const patch = (id: string, values: Partial<SavedSearch>) =>
    change((current) => ({
      ...current,
      searches: current.searches.map((item) =>
        item.id === id ? { ...item, ...values } : item,
      ),
    }));
  return (
    <section className={s.panel}>
      <div className={s.panelHeading}>
        <div>
          <span className={s.eyebrow}>Your disclosure monitoring inbox</span>
          <h2>Saved searches</h2>
        </div>
        <label className={s.check}>
          <input
            type="checkbox"
            checked={showReviewed}
            onChange={(e) => setShowReviewed(e.target.checked)}
          />{" "}
          Show reviewed matches
        </label>
      </div>
      <p className={s.muted}>
        Stored in this browser. Each check reruns the complete saved query and
        scope. Optional checks run when this page is opened and every 15 minutes
        while it is visible. No background server schedule or external
        notifications are enabled.
      </p>
      {!notebook.searches.length && (
        <div className={s.empty}>
          Run a search, name it, and select “Save search” to establish a review
          baseline.
        </div>
      )}
      {notebook.searches.map((saved) => (
        <article className={s.savedSearch} key={saved.id}>
          <div className={s.panelHeading}>
            <div>
              <h3>{saved.name}</h3>
              <code>{saved.settings.query}</code>
              <p className={s.muted}>
                {saved.settings.tickers} · {saved.settings.forms} ·{" "}
                {saved.settings.section} · {saved.settings.scope}
                <br />
                Last checked:{" "}
                {saved.lastChecked
                  ? new Date(saved.lastChecked).toLocaleString()
                  : "Never"}
              </p>
            </div>
            <div className={s.actions}>
              <button disabled={Boolean(checking)} onClick={() => check(saved)}>
                <RefreshCw size={14} />{" "}
                {checking === saved.id ? "Checking…" : "Check now"}
              </button>
              <button onClick={() => load(saved.settings)}>Load search</button>
              <button
                aria-label={`Delete saved search ${saved.name}`}
                onClick={() =>
                  change((current) => ({
                    ...current,
                    searches: current.searches.filter((x) => x.id !== saved.id),
                  }))
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          <div className={s.filterRow}>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={saved.autoCheck}
                onChange={(e) =>
                  patch(saved.id, { autoCheck: e.target.checked })
                }
              />{" "}
              Check automatically while Disclosures is open
            </label>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={saved.followLatest}
                onChange={(e) =>
                  patch(saved.id, { followLatest: e.target.checked })
                }
              />{" "}
              Extend the filing end date to today on each check
            </label>
          </div>
          {saved.lastCoverage && (
            <details className={s.method}>
              <summary>Latest check coverage</summary>
              {saved.lastCoverage.map((c) => (
                <p key={c.ticker}>
                  {c.ticker}: {c.reviewed} reviewed · {c.failed} fetch failures
                  · {c.sectionUnavailable} sections unavailable
                  {c.limited ? " · bounded history/depth" : ""}
                  {c.error ? ` · ${c.error}` : ""}
                </p>
              ))}
            </details>
          )}
          {saved.inbox.filter((item) => showReviewed || !item.reviewed)
            .length === 0 && (
            <p className={s.muted}>
              No unreviewed new matches. Check coverage before concluding that
              no new language is available.
            </p>
          )}
          {saved.inbox
            .filter((item) => showReviewed || !item.reviewed)
            .map((item) => (
              <div className={s.inboxItem} key={item.id}>
                <div>
                  <strong>
                    {item.ticker} · {item.form}
                  </strong>
                  <p className={s.muted}>
                    Filed {item.filingDate} · {item.reason}
                  </p>
                </div>
                <button
                  onClick={() =>
                    open(item, {
                      ...saved.settings,
                      end: saved.followLatest
                        ? new Date().toISOString().slice(0, 10)
                        : saved.settings.end,
                    })
                  }
                >
                  Read evidence
                </button>
                <button
                  onClick={() =>
                    patch(saved.id, {
                      inbox: saved.inbox.map((x) =>
                        x.id === item.id ? { ...x, reviewed: !x.reviewed } : x,
                      ),
                    })
                  }
                >
                  {item.reviewed ? "Mark unreviewed" : "Mark reviewed"}
                </button>
              </div>
            ))}
        </article>
      ))}
    </section>
  );
}

export function DisclosureCollections({
  notebook,
  change,
  notice,
}: {
  notebook: DisclosureNotebook;
  change: Change;
  notice: (value: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [active, setActive] = useState(
    notebook.collections[0]?.id || "default",
  );
  const collection =
    notebook.collections.find((c) => c.id === active) ||
    notebook.collections[0];
  const edit = (id: string, values: object) =>
    change((current) => ({
      ...current,
      collections: current.collections.map((c) =>
        c.id === collection.id
          ? {
              ...c,
              items: c.items.map((item) =>
                item.id === id ? { ...item, ...values } : item,
              ),
            }
          : c,
      ),
    }));
  return (
    <section className={s.panel}>
      <div className={s.panelHeading}>
        <div>
          <span className={s.eyebrow}>Quotations → research brief</span>
          <h2>Evidence collections</h2>
        </div>
        <div className={s.actions}>
          <button
            disabled={!collection?.items.length}
            onClick={() => {
              downloadDisclosure(
                "disclosure-evidence.csv",
                exportDisclosureCsv(collection),
                "text/csv;charset=utf-8",
              );
              notice(
                "Evidence CSV exported with source metadata and search settings.",
              );
            }}
          >
            <Download size={14} /> CSV
          </button>
          <button
            disabled={!collection?.items.length}
            onClick={() => {
              downloadDisclosure(
                "disclosure-research-brief.html",
                exportDisclosureBrief(collection),
                "text/html;charset=utf-8",
              );
              notice(
                "Research brief exported. Open it in a browser to read or print to PDF.",
              );
            }}
          >
            <Download size={14} /> Research brief
          </button>
        </div>
      </div>
      <div className={s.filterRow}>
        <label>
          Collection
          <select
            value={collection?.id || ""}
            onChange={(e) => setActive(e.target.value)}
          >
            {notebook.collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.items.length}
              </option>
            ))}
          </select>
        </label>
        <label>
          New collection
          <input
            aria-label="New collection name"
            value={newName}
            maxLength={100}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Bank refinancing review"
          />
        </label>
        <button
          disabled={!newName.trim()}
          onClick={() => {
            const id = crypto.randomUUID();
            change((current) => ({
              ...current,
              collections: [
                ...current.collections,
                { id, name: newName.trim(), items: [] },
              ],
            }));
            setActive(id);
            setNewName("");
          }}
        >
          <FolderPlus size={15} /> Create collection
        </button>
      </div>
      <p className={s.muted}>
        Save passages from the evidence reader. Notes and tags stay in this
        browser; exports contain the exact saved quotation, accession, reporting
        dates, source URL, comparison wording, and complete search settings.
      </p>
      {!collection?.items.length && (
        <div className={s.empty}>
          Your source-backed research starts with a passage. Open a filing and
          choose “Save this passage.”
        </div>
      )}
      {collection?.items.map((item) => (
        <article className={s.collectionItem} key={item.id}>
          <div className={s.panelHeading}>
            <div>
              <h3>
                {item.ticker} · {item.section}
              </h3>
              <p className={s.muted}>
                {item.form} · filed {item.filingDate} · period{" "}
                {item.reportDate || "not supplied"}
                <br />
                {item.accession}
              </p>
            </div>
            <button
              aria-label={`Remove ${item.ticker} passage from collection`}
              onClick={() =>
                change((current) => ({
                  ...current,
                  collections: current.collections.map((c) =>
                    c.id === collection.id
                      ? { ...c, items: c.items.filter((e) => e.id !== item.id) }
                      : c,
                  ),
                }))
              }
            >
              <Trash2 size={15} />
            </button>
          </div>
          <blockquote>{item.quote}</blockquote>
          <a
            className={s.sourceLink}
            href={item.documentUrl}
            target="_blank"
            rel="noreferrer"
          >
            Original SEC source <ExternalLink size={13} />
          </a>
          <div className={s.noteFields}>
            <label>
              Research notes
              <textarea
                value={item.notes}
                onChange={(e) => edit(item.id, { notes: e.target.value })}
                placeholder="Why this passage matters to your review…"
                rows={3}
                maxLength={12000}
              />
            </label>
            <label>
              Tags
              <input
                value={item.tags}
                onChange={(e) => edit(item.id, { tags: e.target.value })}
                placeholder="liquidity, follow-up"
                maxLength={300}
              />
            </label>
          </div>
          <small>
            {item.languageLabel} ·{" "}
            {item.labelReviewed ? "analyst reviewed" : "automated, unreviewed"}{" "}
            · Saved observation {new Date(item.observedAt).toLocaleString()}
          </small>
        </article>
      ))}
    </section>
  );
}
