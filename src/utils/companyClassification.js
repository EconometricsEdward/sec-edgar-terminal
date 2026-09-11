import membership from "../data/quant-coverage.json" with { type: "json" };
import sicCodes from "../data/sec-sic-codes.json" with { type: "json" };

export const SECTOR_NOT_COVERED = "Sector not covered";
export const FUND_CLASSIFICATION = "Funds (company metrics not applicable)";
const text = (value) => (typeof value === "string" ? value.trim() : "");
const usable = (value) => {
  const label = text(value);
  return /^(unclassified|unknown|unavailable|n\/a|general)$/i.test(label)
    ? ""
    : label;
};
const cikKey = (value) =>
  /^\d{1,10}$/.test(String(value ?? "").trim()) && Number(value) > 0
    ? String(value).trim().padStart(10, "0")
    : null;
const sicKey = (value) =>
  /^\d{3,4}$/.test(String(value ?? "").trim())
    ? String(value).trim().padStart(4, "0")
    : null;
const byCik = new Map(membership.rows.map((row) => [row.cik, row]));
const byDescription = new Map();
const normalizedDescription = (value) =>
  text(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
for (const [code, label] of Object.entries(sicCodes.codes)) {
  const key = normalizedDescription(label);
  // A description is usable as a reverse lookup only when it identifies one code.
  byDescription.set(key, byDescription.has(key) ? null : code);
}

/** Public classification reference; never guesses identity from a ticker or changes financial lenses. */
export function resolveCompanyClassification(
  company = {},
  kind = company?.kind,
) {
  if (kind === "fund")
    return {
      sic: null,
      industry: FUND_CLASSIFICATION,
      industrySource: null,
      sector: null,
      sectorSource: null,
    };
  const description = [
    company?.sicDescription,
    company?.classification?.sicDescription,
    company?.sic_description,
    company?.identity?.sicDescription,
  ]
    .map(usable)
    .find(Boolean);
  const explicitCode = [
    company?.sic,
    company?.classification?.sic,
    company?.identity?.sic,
  ]
    .map(sicKey)
    .find(Boolean);
  const sic =
    explicitCode ||
    byDescription.get(normalizedDescription(description)) ||
    null;
  const lookup = sic ? sicCodes.codes[sic] : null;
  const industry =
    description ||
    lookup ||
    (company?.industrySystem === "SEC SIC analytical groups"
      ? []
      : [company?.industry?.label, company?.industry]
    )
      .map(usable)
      .find(Boolean) ||
    "Unclassified";
  const member = byCik.get(cikKey(company?.cik || company?.identity?.cik));
  const source =
    member && membership.sources.find((entry) => entry.fund === member.fund);
  return {
    sic,
    industry,
    industrySource: description || lookup ? sicCodes.source : null,
    sector: source ? member.sector : null,
    sectorSource: source
      ? {
          provider: "iShares",
          fund: source.fund,
          asOf: source.as_of,
          url: source.url,
        }
      : null,
  };
}

/** Uses the original allocation denominator, combining share classes upstream by CIK. */
export function classificationGroups(
  holdings,
  dimension = "sector",
  weighted = false,
) {
  const groups = new Map();
  for (const holding of holdings) {
    const label =
      holding.kind === "fund"
        ? FUND_CLASSIFICATION
        : dimension === "sector"
          ? holding.sector || SECTOR_NOT_COVERED
          : holding.industry || "Unclassified";
    if (!groups.has(label))
      groups.set(label, {
        label,
        count: 0,
        weightPct: null,
        rowIds: [],
        ciks: [],
      });
    const group = groups.get(label);
    group.count++;
    if (
      weighted &&
      typeof holding.weightPct === "number" &&
      Number.isFinite(holding.weightPct)
    )
      group.weightPct = (group.weightPct ?? 0) + holding.weightPct;
    group.rowIds.push(...(holding.rowIds || []));
    group.ciks.push(holding.cik);
  }
  return [...groups.values()].sort(
    (a, b) =>
      (weighted
        ? (b.weightPct ?? -1) - (a.weightPct ?? -1)
        : b.count - a.count) || a.label.localeCompare(b.label),
  );
}
