export const DISCLOSURE_COLLECTION_LIMIT = 1000;
export const DISCLOSURE_EVIDENCE_LIMIT = 10000;

export const disclosureTags = (text = "") => [
  ...new Map(
    String(text)
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => [tag.toLocaleLowerCase(), tag]),
  ).values(),
];

export function filterDisclosureEvidence(
  items,
  { search = "", company = "", tag = "", change = "" } = {},
) {
  const needle = search.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (!company || item.ticker === company) &&
      (!change || item.change === change) &&
      (!tag ||
        disclosureTags(item.tags).some(
          (value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase(),
        )) &&
      (!needle ||
        [
          item.quote,
          item.priorQuote,
          item.notes,
          item.tags,
          item.ticker,
          item.companyName,
          item.section,
          item.accession,
        ].some((value) =>
          String(value || "")
            .toLocaleLowerCase()
            .includes(needle),
        )),
  );
}

export const disclosureEvidenceSnapshot = (item) => JSON.stringify(item);
const fail = (message) => {
  throw new Error(message);
};
const getCollection = (notebook, id) =>
  notebook.collections.find((c) => c.id === id) ||
  fail(
    "This collection was removed in another tab. Choose a current collection.",
  );
const patchCollection = (notebook, id, update) => ({
  ...notebook,
  collections: notebook.collections.map((c) => (c.id === id ? update(c) : c)),
});

export function createDisclosureCollection(notebook, id, name) {
  const label = name.trim();
  if (!label || label.length > 100)
    fail("Use a collection name between 1 and 100 characters.");
  if (notebook.collections.length >= DISCLOSURE_COLLECTION_LIMIT)
    fail(
      "The collection limit has been reached. Reuse an existing collection.",
    );
  if (notebook.collections.some((c) => c.id === id))
    fail("The collection identifier already exists. Try again.");
  return {
    ...notebook,
    collections: [...notebook.collections, { id, name: label, items: [] }],
  };
}

export function renameDisclosureCollection(notebook, id, expectedName, name) {
  const collection = getCollection(notebook, id);
  if (collection.name !== expectedName)
    fail(
      "This collection was renamed elsewhere. Reload its saved name before renaming it.",
    );
  const label = name.trim();
  if (!label || label.length > 100)
    fail("Use a collection name between 1 and 100 characters.");
  return patchCollection(notebook, id, (c) => ({ ...c, name: label }));
}

export function saveDisclosureAnnotations(
  notebook,
  collectionId,
  evidenceId,
  expected,
  values,
) {
  const collection = getCollection(notebook, collectionId);
  const item = collection.items.find((e) => e.id === evidenceId);
  if (!item)
    fail(
      "This passage was moved or removed. Your draft is still available here.",
    );
  if (
    (item.notes || "") !== expected.notes ||
    (item.tags || "") !== expected.tags
  )
    fail(
      "Saved notes or tags changed in another tab. Compare the saved version before keeping your draft.",
    );
  if (
    typeof values.notes !== "string" ||
    values.notes.length > 12000 ||
    typeof values.tags !== "string" ||
    values.tags.length > 300
  )
    fail("Notes allow 12,000 characters and tags allow 300 characters.");
  return patchCollection(notebook, collectionId, (c) => ({
    ...c,
    items: c.items.map((e) =>
      e.id === evidenceId
        ? { ...e, notes: values.notes, tags: values.tags }
        : e,
    ),
  }));
}

export function bulkDisclosureEvidence(
  notebook,
  { sourceId, targetId = "", action, selected, tags = "" },
) {
  const source = getCollection(notebook, sourceId);
  const ids = Object.keys(selected);
  if (!ids.length) fail("Select at least one passage first.");
  const chosen = source.items.filter((e) => ids.includes(e.id));
  if (
    chosen.length !== ids.length ||
    chosen.some((e) => disclosureEvidenceSnapshot(e) !== selected[e.id])
  )
    fail(
      "Selected evidence changed in another tab. Clear the selection and select the current passages before continuing.",
    );
  if (action === "remove")
    return patchCollection(notebook, sourceId, (c) => ({
      ...c,
      items: c.items.filter((e) => !ids.includes(e.id)),
    }));
  if (action === "tag") {
    const additions = disclosureTags(tags);
    if (!additions.length) fail("Enter at least one tag to add.");
    const nextTags = new Map(
      chosen.map((e) => [
        e.id,
        disclosureTags([e.tags, ...additions].join(", ")).join(", "),
      ]),
    );
    if ([...nextTags.values()].some((value) => value.length > 300))
      fail(
        "The combined tags exceed 300 characters for a selected passage. Shorten the tags first.",
      );
    return patchCollection(notebook, sourceId, (c) => ({
      ...c,
      items: c.items.map((e) =>
        nextTags.has(e.id) ? { ...e, tags: nextTags.get(e.id) } : e,
      ),
    }));
  }
  if (!["copy", "move"].includes(action))
    fail("Choose a supported collection action.");
  if (sourceId === targetId) fail("Choose a different destination collection.");
  const target = getCollection(notebook, targetId);
  if (target.items.length + chosen.length > DISCLOSURE_EVIDENCE_LIMIT)
    fail("The destination has reached its evidence limit.");
  if (target.items.some((e) => ids.includes(e.id)))
    fail(
      "The destination already contains a selected passage. Deselect that passage so its saved notes are not overwritten.",
    );
  return {
    ...notebook,
    collections: notebook.collections.map((c) =>
      c.id === targetId
        ? { ...c, items: [...c.items, ...chosen] }
        : c.id === sourceId && action === "move"
          ? { ...c, items: c.items.filter((e) => !ids.includes(e.id)) }
          : c,
    ),
  };
}

export function reorderDisclosureEvidence(
  notebook,
  collectionId,
  evidenceId,
  direction,
  expectedOrder,
) {
  const collection = getCollection(notebook, collectionId);
  if (
    JSON.stringify(collection.items.map((e) => e.id)) !==
    JSON.stringify(expectedOrder)
  )
    fail(
      "Collection order changed elsewhere. Review the current order and try again.",
    );
  const from = collection.items.findIndex((e) => e.id === evidenceId);
  const to = from + direction;
  if (
    from < 0 ||
    ![-1, 1].includes(direction) ||
    to < 0 ||
    to >= collection.items.length
  )
    return notebook;
  const items = [...collection.items];
  [items[from], items[to]] = [items[to], items[from]];
  return patchCollection(notebook, collectionId, (c) => ({ ...c, items }));
}

export const disclosureBriefDefaults = (collection) => ({
  title: collection.name || "Disclosure research brief",
  researchQuestion: "",
  narrative: "",
  conclusions: "",
  groupBy: "order",
  ...collection.brief,
});
export function saveDisclosureBriefDraft(
  notebook,
  collectionId,
  expected,
  values,
) {
  const collection = getCollection(notebook, collectionId);
  if (
    JSON.stringify(disclosureBriefDefaults(collection)) !==
    JSON.stringify(expected)
  )
    fail(
      "The saved brief changed in another tab. Review its saved version before keeping your draft.",
    );
  for (const [field, max] of Object.entries({
    title: 160,
    researchQuestion: 3000,
    narrative: 12000,
    conclusions: 12000,
  }))
    if (typeof values[field] !== "string" || values[field].length > max)
      fail(`The brief ${field} is too long or invalid.`);
  if (!values.title.trim()) fail("Give the brief a title before saving.");
  if (!["order", "company", "topic"].includes(values.groupBy))
    fail("Choose a supported brief grouping.");
  return patchCollection(notebook, collectionId, (c) => ({
    ...c,
    brief: { ...values },
  }));
}

export function safeDisclosureSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["www.sec.gov", "sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : "";
  } catch {
    return "";
  }
}
