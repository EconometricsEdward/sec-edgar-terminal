/** Deliberate, browser-local research writing with preserved SEC citations. */
export const RESEARCH_BRIEFS_KEY = "edgar:research-briefs:v1";
export const RESEARCH_BRIEF_LIMIT = 50;
export const RESEARCH_BRIEF_STORAGE_LIMIT = 1024 * 1024;
export const BRIEF_STATUSES = ["draft", "investigating", "ready"];
const FIELDS = [
  "title",
  "question",
  "thesis",
  "risks",
  "nextSteps",
  "status",
  "ticker",
  "cik",
  "portfolioId",
  "sources",
];
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bytes = (v) => new TextEncoder().encode(v).length;
const clone = (v) => JSON.parse(JSON.stringify(v));
const idValid = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const dateValid = (v) =>
  typeof v === "string" &&
  v.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T/.test(v) &&
  Number.isFinite(Date.parse(v));
function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
function boundedText(v, max, label) {
  requireValue(
    typeof v === "string" && v.length <= max,
    `${label} exceeds its text limit or is invalid.`,
  );
}
function inspect(value, depth = 0) {
  requireValue(depth <= 8, "Research brief data is too deeply nested.");
  if (Array.isArray(value)) {
    requireValue(value.length <= 100, "A research brief list is too large.");
    value.forEach((item) => inspect(item, depth + 1));
  } else if (object(value)) {
    requireValue(
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
      "Unsupported research brief object.",
    );
    for (const [key, item] of Object.entries(value)) {
      requireValue(!FORBIDDEN.has(key), "Unsafe field in research brief data.");
      inspect(item, depth + 1);
    }
  } else {
    requireValue(
      value === null ||
        value === undefined ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)),
      "Unsupported research brief value.",
    );
    if (typeof value === "string")
      boundedText(value, 12000, "Research brief text");
  }
}
export function isBriefSourceUrl(value) {
  try {
    const url = new URL(value);
    return (
      typeof value === "string" &&
      value.length <= 2000 &&
      !/[\u0000-\u0020\u007f\\]/.test(value) &&
      url.protocol === "https:" &&
      ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}
export function validateResearchBrief(brief) {
  inspect(brief);
  requireValue(object(brief), "A research brief must be an object.");
  requireValue(
    Object.keys(brief).every((key) =>
      [...FIELDS, "id", "createdAt", "updatedAt"].includes(key),
    ),
    "Unknown research brief field.",
  );
  requireValue(idValid(brief.id), "Research brief ID is invalid.");
  boundedText(brief.title, 200, "Brief title");
  requireValue(Boolean(brief.title.trim()), "Give the research brief a title.");
  for (const key of ["question", "thesis", "risks", "nextSteps"])
    boundedText(brief[key], 12000, `Brief ${key}`);
  requireValue(
    BRIEF_STATUSES.includes(brief.status),
    "Choose a valid brief status.",
  );
  requireValue(
    brief.ticker === "" ||
      (typeof brief.ticker === "string" &&
        /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(brief.ticker)),
    "The optional company ticker is invalid.",
  );
  requireValue(
    brief.cik === "" ||
      (typeof brief.cik === "string" && /^\d{10}$/.test(brief.cik)),
    "The optional CIK must contain ten digits.",
  );
  requireValue(
    brief.portfolioId === "" || idValid(brief.portfolioId),
    "The linked portfolio ID is invalid.",
  );
  requireValue(
    dateValid(brief.createdAt) && dateValid(brief.updatedAt),
    "Research brief timestamps are invalid.",
  );
  requireValue(
    Array.isArray(brief.sources) && brief.sources.length <= 100,
    "A brief supports up to 100 SEC sources.",
  );
  const sourceIds = new Set();
  for (const source of brief.sources) {
    requireValue(
      object(source) &&
        Object.keys(source).every((key) =>
          [
            "id",
            "label",
            "url",
            "annotation",
            "notes",
            "capturedAt",
            "origin",
          ].includes(key),
        ),
      "A research source contains invalid fields.",
    );
    requireValue(
      idValid(source.id) && !sourceIds.has(source.id),
      "Research source IDs must be unique.",
    );
    sourceIds.add(source.id);
    requireValue(
      isBriefSourceUrl(source.url),
      "Research sources must use HTTPS on SEC.gov.",
    );
    boundedText(source.label, 300, "Source label");
    requireValue(Boolean(source.label.trim()), "Add a label to each source.");
    boundedText(source.notes, 4000, "Source annotation");
    boundedText(source.origin, 300, "Source origin");
    requireValue(
      ["supports", "contradicts", "context"].includes(source.annotation),
      "A source annotation is invalid.",
    );
    requireValue(
      dateValid(source.capturedAt),
      "A source capture timestamp is invalid.",
    );
  }
  return clone(brief);
}
export function validateResearchBriefs(store) {
  inspect(store);
  requireValue(
    object(store) &&
      Object.keys(store).every((key) =>
        ["version", "briefs", "activeId"].includes(key),
      ) &&
      store.version === 1,
    "Unsupported research briefs version.",
  );
  requireValue(
    Array.isArray(store.briefs) && store.briefs.length <= RESEARCH_BRIEF_LIMIT,
    `You can save up to ${RESEARCH_BRIEF_LIMIT} research briefs.`,
  );
  const briefs = store.briefs.map(validateResearchBrief);
  requireValue(
    new Set(briefs.map((b) => b.id)).size === briefs.length,
    "Research brief IDs must be unique.",
  );
  requireValue(
    store.activeId === null || briefs.some((b) => b.id === store.activeId),
    "The active research brief is invalid.",
  );
  const result = { version: 1, briefs, activeId: store.activeId };
  requireValue(
    bytes(JSON.stringify(result)) <= RESEARCH_BRIEF_STORAGE_LIMIT,
    "Research briefs exceed the 1 MiB browser storage limit. Export and remove older briefs first.",
  );
  return result;
}
export function readResearchBriefs(raw) {
  if (raw === null || raw === undefined || raw === "")
    return { version: 1, briefs: [], activeId: null };
  requireValue(
    typeof raw === "string" && bytes(raw) <= RESEARCH_BRIEF_STORAGE_LIMIT,
    "Research briefs exceed the 1 MiB browser storage limit.",
  );
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Saved research briefs could not be read. Your existing data has been preserved.",
    );
  }
  return validateResearchBriefs(parsed);
}
const makeId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `brief-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
export function createResearchBrief(input = {}) {
  inspect(input);
  const now = input.now || new Date().toISOString();
  return validateResearchBrief({
    id: input.id || makeId(),
    title: input.title ?? "Untitled research brief",
    question: input.question ?? "",
    thesis: input.thesis ?? "",
    risks: input.risks ?? "",
    nextSteps: input.nextSteps ?? "",
    status: input.status ?? "draft",
    ticker: input.ticker ?? "",
    cik: input.cik ?? "",
    portfolioId: input.portfolioId ?? "",
    sources: input.sources ?? [],
    createdAt: now,
    updatedAt: now,
  });
}
/** Every mutation starts from current storage; revisions prevent stale editor overwrites. */
export function writeResearchBrief(storage, operation) {
  const current = readResearchBriefs(storage.getItem(RESEARCH_BRIEFS_KEY));
  requireValue(object(operation), "A research brief operation is required.");
  const existing = current.briefs.find((b) => b.id === operation.id);
  const now = operation.now || new Date().toISOString();
  requireValue(
    dateValid(now),
    "Research brief operation timestamp is invalid.",
  );
  let next = current;
  if (operation.mode === "create") {
    const brief = createResearchBrief({ ...operation.brief, now });
    requireValue(
      !current.briefs.some((b) => b.id === brief.id),
      "A brief with this ID already exists.",
    );
    next = {
      ...current,
      briefs: [brief, ...current.briefs],
      activeId: brief.id,
    };
  } else if (
    ["update", "delete", "duplicate", "activate"].includes(operation.mode)
  ) {
    requireValue(
      Boolean(existing),
      "This brief was removed in another tab. Save your draft as a new brief.",
    );
    if (operation.mode !== "activate")
      requireValue(
        operation.expectedUpdatedAt === existing.updatedAt,
        "This brief changed in another tab. Reload it or save your draft as a new brief to preserve both versions.",
      );
    if (operation.mode === "update") {
      requireValue(
        object(operation.patch) &&
          Object.keys(operation.patch).every((key) => FIELDS.includes(key)),
        "A brief update contains unsupported fields.",
      );
      const updatedAt = new Date(
        Math.max(Date.parse(now), Date.parse(existing.updatedAt) + 1),
      ).toISOString();
      const brief = validateResearchBrief({
        ...existing,
        ...operation.patch,
        updatedAt,
      });
      next = {
        ...current,
        briefs: current.briefs.map((b) => (b.id === existing.id ? brief : b)),
        activeId: brief.id,
      };
    } else if (operation.mode === "delete") {
      const briefs = current.briefs.filter((b) => b.id !== existing.id);
      next = {
        ...current,
        briefs,
        activeId:
          current.activeId === existing.id
            ? briefs[0]?.id || null
            : current.activeId,
      };
    } else if (operation.mode === "duplicate") {
      const brief = createResearchBrief({
        ...existing,
        id: operation.newId || makeId(),
        title: operation.title || `${existing.title.slice(0, 193)} (copy)`,
        now,
      });
      requireValue(
        !current.briefs.some((b) => b.id === brief.id),
        "A brief with this ID already exists.",
      );
      next = {
        ...current,
        briefs: [brief, ...current.briefs],
        activeId: brief.id,
      };
    } else next = { ...current, activeId: existing.id };
  } else throw new Error("Unknown research brief operation.");
  next = validateResearchBriefs(next);
  try {
    storage.setItem(RESEARCH_BRIEFS_KEY, JSON.stringify(next));
  } catch {
    throw new Error(
      "The brief could not be saved in this browser. Your draft and previous saved data are preserved; export your draft to keep a copy.",
    );
  }
  return next;
}
/** Copy only a user-selected SEC source; never import private vault text implicitly. */
export function createBriefSource(input, now = new Date().toISOString()) {
  inspect(input);
  requireValue(object(input), "A source must be an object.");
  requireValue(
    !input.capturedAt || dateValid(input.capturedAt),
    "A source capture timestamp is invalid.",
  );
  const source = {
    id: input.id || makeId(),
    label: String(input.label ?? input.title ?? "SEC source").slice(0, 300),
    url: input.url || input.sourceUrl || input.href,
    annotation: input.annotation || "context",
    notes: input.notes || "",
    capturedAt:
      input.capturedAt && dateValid(input.capturedAt) ? input.capturedAt : now,
    origin: String(input.origin || "Added by researcher").slice(0, 300),
  };
  validateResearchBrief(createResearchBrief({ sources: [source], now }));
  return source;
}
export function briefExportPackage(brief, options = {}) {
  const valid = validateResearchBrief(brief);
  const includePrivate = options.includePrivate === true;
  const exportedAt = options.now || new Date().toISOString();
  requireValue(dateValid(exportedAt), "Export timestamp is invalid.");
  return {
    schema_version: "edgar.research-brief.v1",
    exported_at: exportedAt,
    content_state: options.unsaved === true ? "unsaved-draft" : "saved-brief",
    private_writing_included: includePrivate,
    authorship:
      "Researcher-authored notes; SEC sources are citations, not verification of the researcher's conclusions.",
    brief: {
      id: valid.id,
      title: valid.title,
      status: valid.status,
      ticker: valid.ticker,
      cik: valid.cik,
      portfolioId: valid.portfolioId,
      createdAt: valid.createdAt,
      updatedAt: valid.updatedAt,
      ...(includePrivate
        ? {
            question: valid.question,
            thesis: valid.thesis,
            risks: valid.risks,
            nextSteps: valid.nextSteps,
          }
        : {}),
      sources: valid.sources.map((source) => ({
        id: source.id,
        label: source.label,
        url: source.url,
        capturedAt: source.capturedAt,
        origin: source.origin,
        ...(includePrivate
          ? { annotation: source.annotation, notes: source.notes }
          : {}),
      })),
    },
    omission: includePrivate
      ? "Private research writing and source annotations were explicitly included."
      : "Private questions, thesis, risks, next steps, source interpretations and annotations were omitted.",
  };
}
export function briefJson(brief, options = {}) {
  return JSON.stringify(briefExportPackage(brief, options), null, 2);
}
const markdownText = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}])/g, "\\$1")
    .replace(/^(\s*)([#>+-]|\d+\.)/gm, "$1\\$2");
export function briefMarkdown(brief, options = {}) {
  const pack = briefExportPackage(brief, options),
    b = pack.brief;
  const lines = [
    `# ${markdownText(b.title).replace(/\n/g, " ")}`,
    "",
    `Status: ${b.status} | Company: ${markdownText(b.ticker || b.cik || "Unassigned")}`,
    `Captured export: ${pack.exported_at}`,
    `${pack.content_state === "unsaved-draft" ? "Draft base timestamp" : "Last saved"}: ${b.updatedAt}`,
    `Content: ${pack.content_state}`,
    "",
    pack.authorship,
    "",
    pack.omission,
    "",
  ];
  if (pack.private_writing_included)
    for (const [key, label] of [
      ["question", "Research question"],
      ["thesis", "Working thesis"],
      ["risks", "Risks and counterevidence"],
      ["nextSteps", "Next steps"],
    ])
      lines.push(
        `## ${label}`,
        "",
        markdownText(b[key] || "No writing added."),
        "",
      );
  lines.push("## SEC source register", "");
  if (!b.sources.length)
    lines.push(
      "No SEC sources attached. This brief has no linked source evidence.",
      "",
    );
  b.sources.forEach((s, index) => {
    lines.push(
      `${index + 1}. [${markdownText(s.label).replace(/\n/g, " ")}](<${s.url
        .replace(/</g, "%3C")
        .replace(/>/g, "%3E")
        .replace(/\s/g, (c) => encodeURIComponent(c))}>)`,
      `   Captured: ${s.capturedAt} · Origin: ${markdownText(s.origin).replace(/\n/g, " ")}`,
    );
    if (pack.private_writing_included)
      lines.push(
        `   Researcher classification: ${s.annotation}`,
        `   ${markdownText(s.notes || "No annotation.")}`,
      );
    lines.push("");
  });
  return lines.join("\n");
}
