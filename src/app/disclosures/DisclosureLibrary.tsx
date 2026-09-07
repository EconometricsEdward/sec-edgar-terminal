"use client";
import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  FolderPlus,
  Trash2,
} from "lucide-react";
import {
  bulkDisclosureEvidence,
  createDisclosureCollection,
  disclosureEvidenceSnapshot,
  disclosureTags,
  filterDisclosureEvidence,
  renameDisclosureCollection,
  reorderDisclosureEvidence,
  safeDisclosureSourceUrl,
  saveDisclosureAnnotations,
} from "../../utils/disclosureCollections.js";
import {
  DisclosureBriefComposer,
  type BriefDraft,
} from "./DisclosureBriefComposer";
import type { DisclosureNotebook, Evidence } from "./disclosureTypes";
import s from "./disclosures.module.css";
import c from "./disclosureCollections.module.css";

export function downloadDisclosure(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export type DisclosureCollectionChange = (
  update: (current: DisclosureNotebook) => DisclosureNotebook,
) => boolean;
type AnnotationDraft = {
  collectionId: string;
  evidenceId: string;
  notes: string;
  tags: string;
  base: { notes: string; tags: string };
};
const draftKey = (collectionId: string, evidenceId: string) =>
  JSON.stringify([collectionId, evidenceId]);
const annotations = (item: Evidence) => ({
  notes: item.notes || "",
  tags: item.tags || "",
});

export function DisclosureCollections({
  notebook,
  change,
  notice,
}: {
  notebook: DisclosureNotebook;
  change: DisclosureCollectionChange;
  notice: (value: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [active, setActive] = useState(
    notebook.collections[0]?.id || "default",
  );
  const [search, setSearch] = useState("");
  const [company, setCompany] = useState("");
  const [tag, setTag] = useState("");
  const [changeFilter, setChangeFilter] = useState("");
  const [selectedByCollection, setSelectedByCollection] = useState<
    Record<string, Record<string, string>>
  >({});
  const [destination, setDestination] = useState("");
  const [bulkTags, setBulkTags] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [message, setMessage] = useState("");
  const [renames, setRenames] = useState<
    Record<string, { value: string; base: string }>
  >({});
  const [drafts, setDrafts] = useState<Record<string, AnnotationDraft>>({});
  const [briefDrafts, setBriefDrafts] = useState<Record<string, BriefDraft>>(
    {},
  );
  const collection =
    notebook.collections.find((item) => item.id === active) ||
    notebook.collections[0];
  const dirty =
    Object.keys(drafts).length > 0 || Object.keys(briefDrafts).length > 0;
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const report = (value: string) => {
    setMessage(value);
    notice(value);
  };
  const mutate = (
    update: (current: DisclosureNotebook) => DisclosureNotebook,
    success: string,
  ) => {
    let error = "";
    const saved = change((current) => {
      try {
        return update(current);
      } catch (cause) {
        error =
          cause instanceof Error
            ? cause.message
            : "Collection could not be updated.";
        return current;
      }
    });
    if (error) {
      report(error);
      return false;
    }
    if (!saved) {
      setMessage(
        "Changes could not be saved. Your draft and selection have been kept; check the storage notice above.",
      );
      return false;
    }
    report(success);
    return true;
  };
  const create = () => {
    const id = crypto.randomUUID();
    if (
      mutate(
        (current) => createDisclosureCollection(current, id, newName),
        "Collection created.",
      )
    ) {
      setActive(id);
      setNewName("");
    }
  };
  if (!collection)
    return (
      <section className={s.panel}>
        <h2>Evidence collections</h2>
        <label>
          New collection
          <input
            value={newName}
            maxLength={100}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <button disabled={!newName.trim()} onClick={create}>
          Create collection
        </button>
        <p role="status">{message}</p>
      </section>
    );
  const selected = selectedByCollection[collection.id] || {};
  const selectedIds = Object.keys(selected);
  const visible = filterDisclosureEvidence(collection.items, {
    search,
    company,
    tag,
    change: changeFilter,
  }) as Evidence[];
  const companies = [
    ...new Set(collection.items.map((item) => item.ticker)),
  ].sort();
  const tags = [
    ...new Set(collection.items.flatMap((item) => disclosureTags(item.tags))),
  ].sort() as string[];
  const changes = [...new Set(collection.items.map((item) => item.change))]
    .filter(Boolean)
    .sort();
  const setSelected = (next: Record<string, string>) => {
    setSelectedByCollection((current) => ({
      ...current,
      [collection.id]: next,
    }));
    setConfirmRemove(false);
  };
  const setDraft = (item: Evidence, values: Partial<AnnotationDraft>) => {
    const key = draftKey(collection.id, item.id);
    setDrafts((current) => {
      const draft = {
        ...(current[key] || {
          collectionId: collection.id,
          evidenceId: item.id,
          ...annotations(item),
          base: annotations(item),
        }),
        ...values,
      };
      const next = { ...current, [key]: draft };
      if (draft.notes === draft.base.notes && draft.tags === draft.base.tags)
        delete next[key];
      return next;
    });
  };
  const clearDraft = (key: string) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  const saveDraft = (
    item: Evidence,
    draft: AnnotationDraft,
    keepDraft = false,
  ) => {
    if (
      mutate(
        (current) =>
          saveDisclosureAnnotations(
            current,
            collection.id,
            item.id,
            keepDraft ? annotations(item) : draft.base,
            { notes: draft.notes, tags: draft.tags },
          ),
        "Notes and tags saved. Source evidence is unchanged.",
      )
    ) {
      clearDraft(draftKey(collection.id, item.id));
      if (selected[item.id]) {
        const next = { ...selected };
        delete next[item.id];
        setSelected(next);
      }
    }
  };
  const bulk = (action: string) => {
    if (selectedIds.some((id) => drafts[draftKey(collection.id, id)])) {
      report(
        "Save or discard drafts for the selected passages before using a bulk action.",
      );
      return;
    }
    if (
      mutate(
        (current) =>
          bulkDisclosureEvidence(current, {
            sourceId: collection.id,
            targetId: destination,
            action,
            selected,
            tags: bulkTags,
          }),
        `${selectedIds.length} selected passage${selectedIds.length === 1 ? "" : "s"} ${action === "tag" ? "tagged" : action === "copy" ? "copied" : action === "move" ? "moved" : "removed"}.`,
      )
    ) {
      setSelected({});
      setBulkTags("");
    }
  };
  const orphanedDrafts = Object.entries(drafts).filter(
    ([, draft]) =>
      !notebook.collections
        .find((saved) => saved.id === draft.collectionId)
        ?.items.some((item) => item.id === draft.evidenceId),
  );
  return (
    <section className={s.panel}>
      <div className={s.panelHeading}>
        <div>
          <span className={s.eyebrow}>
            Organize evidence, preserve the source
          </span>
          <h2>Evidence collections</h2>
        </div>
        <span className={c.count}>
          {collection.items.length} saved passages
        </span>
      </div>
      <p className={s.muted}>
        Build a research set, annotate quotations, and prepare a brief from an
        explicit selection. Saved quotations and filing metadata stay intact
        when you edit notes, tags or order.
      </p>
      <div className={c.collectionControls}>
        <label>
          Collection
          <select
            value={collection.id}
            onChange={(event) => {
              setActive(event.target.value);
              setCompany("");
              setTag("");
              setChangeFilter("");
              setConfirmRemove(false);
              setDestination("");
            }}
          >
            {notebook.collections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.items.length}
              </option>
            ))}
          </select>
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
          className={c.inlineForm}
        >
          <label>
            New collection
            <input
              aria-label="New collection name"
              value={newName}
              maxLength={100}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Bank refinancing review"
            />
          </label>
          <button disabled={!newName.trim()}>
            <FolderPlus size={15} /> Create
          </button>
        </form>
      </div>
      <details className={s.method}>
        <summary>Rename this collection</summary>
        <form
          className={c.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            const draft = renames[collection.id];
            if (
              draft &&
              mutate(
                (current) =>
                  renameDisclosureCollection(
                    current,
                    collection.id,
                    draft.base,
                    draft.value,
                  ),
                "Collection renamed.",
              )
            )
              setRenames((current) => {
                const next = { ...current };
                delete next[collection.id];
                return next;
              });
          }}
        >
          <label>
            Collection name
            <input
              value={renames[collection.id]?.value ?? collection.name}
              maxLength={100}
              onChange={(event) =>
                setRenames((current) => ({
                  ...current,
                  [collection.id]: {
                    base: current[collection.id]?.base ?? collection.name,
                    value: event.target.value,
                  },
                }))
              }
            />
          </label>
          <button disabled={!renames[collection.id]?.value.trim()}>
            Save name
          </button>
          <button
            type="button"
            onClick={() =>
              setRenames((current) => {
                const next = { ...current };
                delete next[collection.id];
                return next;
              })
            }
          >
            Use saved name
          </button>
        </form>
      </details>
      <div className={c.filters}>
        <label className={c.search}>
          Search saved evidence
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Quotation, notes, tags or accession"
          />
        </label>
        <label>
          Company
          <select
            value={company}
            onChange={(event) => setCompany(event.target.value)}
          >
            <option value="">All companies</option>
            {companies.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Tag
          <select value={tag} onChange={(event) => setTag(event.target.value)}>
            <option value="">All tags</option>
            {tags.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Wording change
          <select
            value={changeFilter}
            onChange={(event) => setChangeFilter(event.target.value)}
          >
            <option value="">All changes</option>
            {changes.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      <div className={c.selectionBar}>
        <span>
          <strong>{visible.length}</strong> of {collection.items.length} shown ·{" "}
          <strong>{selectedIds.length}</strong> selected (
          {
            selectedIds.filter((id) => !visible.some((item) => item.id === id))
              .length
          }{" "}
          hidden by filters)
        </span>
        <div className={s.actions}>
          <button
            disabled={!visible.length}
            onClick={() =>
              setSelected({
                ...selected,
                ...Object.fromEntries(
                  visible.map((item) => [
                    item.id,
                    disclosureEvidenceSnapshot(item),
                  ]),
                ),
              })
            }
          >
            Select shown
          </button>
          <button
            disabled={!selectedIds.length}
            onClick={() => setSelected({})}
          >
            Clear selection
          </button>
          <button
            disabled={!search && !company && !tag && !changeFilter}
            onClick={() => {
              setSearch("");
              setCompany("");
              setTag("");
              setChangeFilter("");
            }}
          >
            Clear filters
          </button>
        </div>
      </div>
      {selectedIds.length > 0 && (
        <div className={c.bulk}>
          <div className={c.inlineForm}>
            <label>
              Destination collection
              <select
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              >
                <option value="">Choose a destination</option>
                {notebook.collections
                  .filter((item) => item.id !== collection.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <button disabled={!destination} onClick={() => bulk("copy")}>
              Copy selected
            </button>
            <button disabled={!destination} onClick={() => bulk("move")}>
              Move selected
            </button>
          </div>
          <div className={c.inlineForm}>
            <label>
              Add tags to selected
              <input
                value={bulkTags}
                maxLength={300}
                onChange={(event) => setBulkTags(event.target.value)}
                placeholder="liquidity, follow-up"
              />
            </label>
            <button disabled={!bulkTags.trim()} onClick={() => bulk("tag")}>
              Add tags
            </button>
            <button onClick={() => setConfirmRemove(true)}>
              <Trash2 size={14} /> Remove selected
            </button>
          </div>
          {confirmRemove && (
            <div className={c.confirm} role="alert">
              <p>
                Remove these {selectedIds.length} selected passages from “
                {collection.name}”? This also removes their saved notes from
                this collection.
              </p>
              <button onClick={() => bulk("remove")}>
                Confirm removal of {selectedIds.length} passages
              </button>
              <button onClick={() => setConfirmRemove(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {message && (
        <p className={c.feedback} role="status">
          {message}
        </p>
      )}
      {dirty && (
        <p className={c.draftNotice}>
          You have unsaved research drafts. Save them before leaving
          Disclosures. Drafts remain available while you change these collection
          filters.
        </p>
      )}
      <DisclosureBriefComposer
        collection={collection}
        selectedIds={selectedIds}
        draft={briefDrafts[collection.id]}
        setDraft={(draft) =>
          setBriefDrafts((current) => {
            const next = { ...current };
            if (draft) next[collection.id] = draft;
            else delete next[collection.id];
            return next;
          })
        }
        mutate={mutate}
      />
      {!collection.items.length ? (
        <div className={s.empty}>
          Open a filing in the evidence reader and choose “Save this passage” to
          start this collection.
        </div>
      ) : !visible.length ? (
        <div className={s.empty}>
          No saved passages match these filters. Clear the filters to review the
          rest of your collection.
        </div>
      ) : (
        <div className={c.evidenceList}>
          {visible.map((item) => {
            const key = draftKey(collection.id, item.id),
              draft = drafts[key],
              values = draft || annotations(item);
            const conflict = Boolean(
              draft &&
              (draft.base.notes !== (item.notes || "") ||
                draft.base.tags !== (item.tags || "")),
            );
            const position = collection.items.findIndex(
                (value) => value.id === item.id,
              ),
              source = safeDisclosureSourceUrl(item.documentUrl);
            return (
              <article
                key={item.id}
                className={`${s.collectionItem} ${selected[item.id] ? c.selected : ""}`}
              >
                <div className={s.panelHeading}>
                  <div className={c.itemHeading}>
                    <label className={s.check}>
                      <input
                        type="checkbox"
                        checked={Boolean(selected[item.id])}
                        aria-label={`Select ${item.ticker} passage ${position + 1}`}
                        onChange={(event) => {
                          const next = { ...selected };
                          if (event.target.checked)
                            next[item.id] = disclosureEvidenceSnapshot(item);
                          else delete next[item.id];
                          setSelected(next);
                        }}
                      />
                    </label>
                    <div>
                      <h3>
                        {position + 1}. {item.ticker} · {item.section}
                      </h3>
                      <p className={s.muted}>
                        {item.form} · filed {item.filingDate} · period{" "}
                        {item.reportDate || "not supplied"}
                        <br />
                        {item.accession}
                      </p>
                    </div>
                  </div>
                  <div className={s.actions}>
                    <button
                      aria-label={`Move ${item.ticker} passage ${position + 1} up`}
                      disabled={position === 0}
                      onClick={() =>
                        mutate(
                          (current) =>
                            reorderDisclosureEvidence(
                              current,
                              collection.id,
                              item.id,
                              -1,
                              collection.items.map((value) => value.id),
                            ),
                          "Collection order saved.",
                        )
                      }
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      aria-label={`Move ${item.ticker} passage ${position + 1} down`}
                      disabled={position === collection.items.length - 1}
                      onClick={() =>
                        mutate(
                          (current) =>
                            reorderDisclosureEvidence(
                              current,
                              collection.id,
                              item.id,
                              1,
                              collection.items.map((value) => value.id),
                            ),
                          "Collection order saved.",
                        )
                      }
                    >
                      <ArrowDown size={15} />
                    </button>
                  </div>
                </div>
                <div className={c.badges}>
                  <span>{item.change || "Comparison not supplied"}</span>
                  <span>
                    {item.languageLabel || "Unclassified wording"} ·{" "}
                    {item.labelReviewed
                      ? "analyst reviewed label"
                      : "unreviewed label"}
                  </span>
                  {disclosureTags(item.tags).map((value) => (
                    <span key={String(value)}>{String(value)}</span>
                  ))}
                </div>
                {item.change === "removed" && (
                  <p className={s.muted}>
                    Archived prior-report quotation; source and filing date
                    below belong to that prior report.
                  </p>
                )}
                <blockquote>{item.quote}</blockquote>
                {item.priorQuote && item.priorQuote !== item.quote && (
                  <details className={s.method}>
                    <summary>
                      Archived comparison wording ·{" "}
                      {item.comparisonAccession || "accession not supplied"}
                    </summary>
                    <blockquote>{item.priorQuote}</blockquote>
                  </details>
                )}
                {source ? (
                  <a
                    className={s.sourceLink}
                    href={source}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Original SEC source <ExternalLink size={13} />
                  </a>
                ) : (
                  <p className={s.muted}>
                    SEC source link unavailable; locate the filing with the
                    accession above.
                  </p>
                )}
                <div className={s.noteFields}>
                  <label>
                    Research notes
                    <textarea
                      aria-label={`Research notes for ${item.ticker} passage ${position + 1}`}
                      value={values.notes}
                      onChange={(event) =>
                        setDraft(item, { notes: event.target.value })
                      }
                      rows={3}
                      maxLength={12000}
                      placeholder="Why this passage matters to your review…"
                    />
                  </label>
                  <label>
                    Tags
                    <input
                      aria-label={`Tags for ${item.ticker} passage ${position + 1}`}
                      value={values.tags}
                      onChange={(event) =>
                        setDraft(item, { tags: event.target.value })
                      }
                      maxLength={300}
                      placeholder="liquidity, follow-up"
                    />
                  </label>
                </div>
                <div className={c.annotationFooter}>
                  <span role="status">
                    {conflict
                      ? "Conflict: saved notes or tags changed elsewhere"
                      : draft
                        ? "Unsaved draft"
                        : "Notes and tags saved"}
                  </span>
                  <div className={s.actions}>
                    <button
                      disabled={!draft || conflict}
                      onClick={() => draft && saveDraft(item, draft)}
                    >
                      Save notes and tags
                    </button>
                    {draft && (
                      <button onClick={() => clearDraft(key)}>
                        Use saved notes and tags
                      </button>
                    )}
                  </div>
                </div>
                {conflict && draft && (
                  <div className={c.conflict}>
                    <strong>Latest saved version</strong>
                    <p>{item.notes || "No saved notes"}</p>
                    <p>Tags: {item.tags || "None"}</p>
                    <button onClick={() => saveDraft(item, draft, true)}>
                      Keep my draft over this saved version
                    </button>
                  </div>
                )}
                <small>
                  Saved observation {item.observedAt || "not supplied"}
                </small>
                <details className={s.method}>
                  <summary>Search settings saved with this evidence</summary>
                  <pre className={c.settings}>
                    {JSON.stringify(item.settings, null, 2)}
                  </pre>
                </details>
              </article>
            );
          })}
        </div>
      )}
      {orphanedDrafts.map(([key, draft]) => (
        <div key={key} className={c.conflict}>
          <strong>
            A passage with an unsaved draft was moved or removed elsewhere.
          </strong>
          <p>Copy this draft before discarding it: {draft.notes}</p>
          <p>Tags: {draft.tags}</p>
          <button onClick={() => clearDraft(key)}>
            Discard this unattached draft
          </button>
        </div>
      ))}
    </section>
  );
}
