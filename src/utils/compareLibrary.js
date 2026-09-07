const fail = (message) => {
  throw new Error(message);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const compareTags = (text = "") => [
  ...new Map(
    String(text)
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => [tag.toLowerCase(), tag]),
  ).values(),
];
export const comparePinSnapshot = (pin) => JSON.stringify(pin);
export const compareAnnotations = (pin) => ({
  notes: pin.notes || "",
  tags: pin.tags || "",
});
export const compareMemo = (notebook) => ({
  collectionName: notebook.collectionName || "Peer comparison research",
  notes: notebook.notes || "",
});

export function filterComparePins(
  pins,
  { search = "", company = "", metric = "", tag = "" } = {},
) {
  const needle = search.trim().toLowerCase();
  return pins.filter(
    (pin) =>
      (!company || pin.ticker === company) &&
      (!metric || pin.metric === metric) &&
      (!tag ||
        compareTags(pin.tags).some(
          (value) => value.toLowerCase() === tag.toLowerCase(),
        )) &&
      (!needle ||
        [
          pin.ticker,
          pin.name,
          pin.label,
          pin.notes,
          pin.tags,
          pin.point?.period?.end,
          pin.point?.formula,
          ...(pin.point?.sources || []).flatMap((source) => [
            source.tag,
            source.accession,
          ]),
        ].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(needle),
        )),
  );
}

export function checkedCompareSelection(pins, selected) {
  const ids = Object.keys(selected);
  if (!ids.length) fail("Select at least one observation first.");
  const chosen = pins.filter((pin) => ids.includes(pin.id));
  if (
    chosen.length !== ids.length ||
    chosen.some((pin) => comparePinSnapshot(pin) !== selected[pin.id])
  )
    fail(
      "Selected evidence changed or was removed in another tab. Clear the selection and select the current observations before continuing.",
    );
  return chosen;
}

export function saveCompareAnnotations(notebook, id, expected, values) {
  const pin = notebook.pins.find((item) => item.id === id);
  if (!pin)
    fail(
      "This observation was removed elsewhere. Your draft is still available here.",
    );
  if (!equal(compareAnnotations(pin), expected))
    fail(
      "Saved notes or tags changed elsewhere. Review the latest saved version before keeping your draft.",
    );
  if (
    typeof values.notes !== "string" ||
    values.notes.length > 8000 ||
    typeof values.tags !== "string" ||
    values.tags.length > 300
  )
    fail(
      "Observation notes allow 8,000 characters and tags allow 300 characters.",
    );
  return {
    ...notebook,
    pins: notebook.pins.map((item) =>
      item.id === id
        ? { ...item, notes: values.notes, tags: values.tags }
        : item,
    ),
  };
}

export function saveCompareMemo(notebook, expected, values) {
  if (!equal(compareMemo(notebook), expected))
    fail(
      "The saved collection name or memo changed elsewhere. Review the saved version before keeping your draft.",
    );
  if (
    typeof values.collectionName !== "string" ||
    !values.collectionName.trim() ||
    values.collectionName.length > 120 ||
    typeof values.notes !== "string" ||
    values.notes.length > 16000
  )
    fail(
      "Use a collection name of 1–120 characters and a memo of up to 16,000 characters.",
    );
  return {
    ...notebook,
    collectionName: values.collectionName,
    notes: values.notes,
  };
}

export function bulkComparePins(notebook, { selected, action, tags = "" }) {
  const chosen = checkedCompareSelection(notebook.pins, selected);
  const ids = new Set(chosen.map((pin) => pin.id));
  if (action === "remove")
    return {
      ...notebook,
      pins: notebook.pins.filter((pin) => !ids.has(pin.id)),
    };
  if (action !== "tag") fail("Choose a supported evidence action.");
  if (!compareTags(tags).length) fail("Enter at least one tag to add.");
  const updates = new Map(
    chosen.map((pin) => [
      pin.id,
      compareTags(`${pin.tags || ""},${tags}`).join(", "),
    ]),
  );
  if ([...updates.values()].some((value) => value.length > 300))
    fail(
      "Combined tags exceed 300 characters for a selected observation. Shorten the tags first.",
    );
  return {
    ...notebook,
    pins: notebook.pins.map((pin) =>
      ids.has(pin.id) ? { ...pin, tags: updates.get(pin.id) } : pin,
    ),
  };
}

export function reorderComparePins(notebook, id, direction, expectedOrder) {
  if (
    !equal(
      notebook.pins.map((pin) => pin.id),
      expectedOrder,
    )
  )
    fail(
      "Evidence order changed elsewhere. Review the current order and try again.",
    );
  const from = notebook.pins.findIndex((pin) => pin.id === id),
    to = from + direction;
  if (
    from < 0 ||
    ![-1, 1].includes(direction) ||
    to < 0 ||
    to >= notebook.pins.length
  )
    return notebook;
  const pins = [...notebook.pins];
  [pins[from], pins[to]] = [pins[to], pins[from]];
  return { ...notebook, pins };
}

export const compareBriefDefaults = (notebook) => ({
  title: notebook.collectionName || "Peer comparison research brief",
  researchQuestion: "",
  narrative: "",
  conclusions: "",
  groupBy: "order",
  ...notebook.brief,
});
export function saveCompareBrief(notebook, expected, values) {
  if (!equal(compareBriefDefaults(notebook), expected))
    fail(
      "The saved brief changed elsewhere. Review its current fields before keeping your draft.",
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
  if (!["order", "company", "metric"].includes(values.groupBy))
    fail("Choose a supported brief grouping.");
  return { ...notebook, brief: { ...values } };
}
