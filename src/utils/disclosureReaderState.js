const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const DOCUMENT = /^[\w][\w./-]*\.(?:htm|html|txt)$/i;
const LANGUAGES = [
  "all",
  "Reported-event wording",
  "Hypothetical wording",
  "Mixed language",
  "Unclassified wording",
];
const CHANGES = [
  "all",
  "changed",
  "added",
  "revised",
  "removed",
  "unchanged",
  "unavailable",
];
const SETTINGS = [
  "query",
  "tickers",
  "mode",
  "start",
  "end",
  "forms",
  "section",
  "scope",
  "depth",
  "amendments",
  "comparison",
];

export function disclosureReaderFilters(input = {}) {
  return {
    section: /^(?:all|other|risk|mda|notes|8k:\d\.\d{2})$/.test(
      input.section || "",
    )
      ? input.section
      : "all",
    change: CHANGES.includes(input.change) ? input.change : "all",
    language: LANGUAGES.includes(input.language) ? input.language : "all",
    find: String(input.find || "")
      .trim()
      .slice(0, 200),
  };
}

export function disclosurePassageSide(passage) {
  return passage?.change === "removed" ? "prior" : "current";
}

export function disclosurePassageAnchor(passage) {
  return `disclosure-passage-${disclosurePassageSide(passage)}-${passage.index}`;
}

/** Only public research settings and SEC identifiers enter share links. */
export function makeDisclosurePassageUrl({
  filing,
  passage,
  settings,
  filters = {},
  origin = "",
}) {
  const params = new URLSearchParams();
  for (const key of SETTINGS) {
    if (settings[key] !== undefined && settings[key] !== null)
      params.set(key, String(settings[key]));
  }
  params.set("rTicker", filing.ticker || "");
  params.set("rCik", String(filing.cik || ""));
  params.set("rAccession", filing.accession);
  params.set("rDocument", filing.primaryDoc);
  params.set("rSide", disclosurePassageSide(passage));
  params.set("rIndex", String(passage.index));
  if (filing.pair?.prior?.accession)
    params.set("rBaseline", filing.pair.prior.accession);
  const normalized = disclosureReaderFilters(filters);
  for (const [key, value] of Object.entries(normalized)) {
    if (value && value !== "all")
      params.set(`reader${key[0].toUpperCase()}${key.slice(1)}`, value);
  }
  let safeOrigin = "";
  if (origin) {
    const parsed = new URL(origin);
    if (!["https:", "http:"].includes(parsed.protocol))
      throw new Error("Use a web origin for disclosure links.");
    safeOrigin = parsed.origin;
  }
  if (!parseDisclosureReaderState(params))
    throw new Error("This passage does not have valid SEC source identifiers.");
  return `${safeOrigin}/disclosures?${params}#${disclosurePassageAnchor(passage)}`;
}

/** Invalid pointers never select a different filing or silently default to paragraph zero. */
export function parseDisclosureReaderState(params) {
  if (!(params instanceof URLSearchParams)) return null;
  const ticker = params.get("rTicker") || "";
  const cik = params.get("rCik") || "";
  const accession = params.get("rAccession") || "";
  const primaryDoc = params.get("rDocument") || "";
  const side = params.get("rSide");
  const indexText = params.get("rIndex") || "";
  const baselineAccession = params.get("rBaseline") || "";
  if (
    !ACCESSION.test(accession) ||
    !/^\d{1,10}$/.test(cik) ||
    (ticker && !/^[A-Za-z0-9.^-]{1,20}$/.test(ticker)) ||
    !DOCUMENT.test(primaryDoc) ||
    primaryDoc.includes("..") ||
    !["current", "prior"].includes(side) ||
    !/^\d{1,7}$/.test(indexText) ||
    (baselineAccession && !ACCESSION.test(baselineAccession)) ||
    (side === "prior" && !baselineAccession)
  )
    return null;
  return {
    filing: {
      ticker,
      cik,
      accession,
      primaryDoc,
      companyName: "Loading verified SEC filing metadata…",
      form: "",
      filingDate: "",
      reportDate: "",
      documentUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/${primaryDoc}`,
    },
    side,
    index: Number(indexText),
    baselineAccession,
    filters: disclosureReaderFilters({
      section: params.get("readerSection"),
      change: params.get("readerChange"),
      language: params.get("readerLanguage"),
      find: params.get("readerFind"),
    }),
  };
}

export function disclosurePassageCitation(filing, passage) {
  const prior = disclosurePassageSide(passage) === "prior";
  const source = prior ? filing.pair?.prior : filing;
  if (!source?.accession || !source.documentUrl)
    throw new Error("The source filing is unavailable for this quotation.");
  const quote = prior ? passage.priorText || "" : passage.text || "";
  return [
    `${filing.companyName || filing.ticker} (${filing.ticker || `CIK ${filing.cik}`}) — ${source.form}, filed ${source.filingDate}; reporting period ${source.reportDate || "not supplied"}.`,
    `${passage.section}; extracted paragraph ${passage.index + 1} (reader position, not SEC numbering). Accession ${source.accession}.`,
    `“${quote}”`,
    source.documentUrl,
    prior
      ? "Quotation is from the prior filing; it was unmatched in the selected current section."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function disclosureReaderNavigation(key, index, count) {
  if (!count) return null;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
