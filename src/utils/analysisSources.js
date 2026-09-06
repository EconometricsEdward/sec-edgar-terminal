import { analysisBaseline, commonSizePoint } from "./analysisResearch.js";
import { growthCompatibility } from "./analysisGrowth.js";
import { evidenceSources } from "./researchEvidence.js";

const date = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
const finite = (point) => Number.isFinite(point?.value);

/** A context identifies the reported concept, unit and dates, not a derived metric. */
export function analysisSourceContext(source) {
  return JSON.stringify([
    source.taxonomy || "",
    source.tag || "",
    source.unit || "",
    source.start || null,
    source.end || null,
  ]);
}

export function analysisSecUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["sec.gov", "www.sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      (url.pathname.startsWith("/Archives/") ||
        url.pathname === "/ixviewer/doc/action")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Labels can differ when one input feeds several formulas; count its provenance once. */
export function uniqueAnalysisSources(point) {
  const seen = new Set();
  return evidenceSources(point).filter((source) => {
    const key = JSON.stringify([
      analysisSourceContext(source),
      source.accession || null,
      source.value,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function analysisSourceState(point) {
  const available = finite(point);
  const sources = uniqueAnalysisSources(point);
  return {
    available,
    kind: !available
      ? "missing"
      : point.classification === "calculated"
        ? "calculated"
        : "reported",
    revised: sources.some(
      (source) =>
        source.revised ||
        new Set((source.revisions || []).map((r) => r.value)).size > 1,
    ),
    sourceCount: sources.length,
  };
}

/** Several filings can legitimately feed a TTM, average-balance or revised calculation. */
export function analysisSourceCoherence(point, asOf = "") {
  const sources = uniqueAnalysisSources(point);
  const filings = new Map();
  for (const source of sources) {
    const key = source.accession || `unknown:${source.filed || ""}`;
    if (!filings.has(key))
      filings.set(key, {
        accession: source.accession || null,
        filed: date(source.filed),
        form: source.form || null,
        documentUrl: analysisSecUrl(source.documentUrl),
        sourceCount: 0,
      });
    filings.get(key).sourceCount += 1;
  }
  const rows = [...filings.values()].sort((a, b) =>
    (b.filed || "").localeCompare(a.filed || ""),
  );
  const dates = sources
    .map((source) => date(source.filed))
    .filter(Boolean)
    .sort();
  const incomplete = sources.filter(
    (source) => !source.accession || !date(source.filed),
  ).length;
  const accessionDates = new Map();
  for (const source of sources) {
    if (!source.accession || !date(source.filed)) continue;
    if (!accessionDates.has(source.accession))
      accessionDates.set(source.accession, new Set());
    accessionDates.get(source.accession).add(source.filed);
  }
  const conflictingDates = [...accessionDates.values()].filter(
    (dates) => dates.size > 1,
  ).length;
  const afterCutoff = asOf
    ? sources.filter((source) => date(source.filed) && source.filed > asOf)
        .length
    : 0;
  const contexts = new Set(
    sources.map(
      (source) => `${source.start || "instant"}:${source.end || "unknown"}`,
    ),
  );
  return {
    filings: rows,
    filingCount: new Set(
      sources.map((source) => source.accession).filter(Boolean),
    ).size,
    sourceCount: sources.length,
    contextCount: contexts.size,
    incomplete,
    conflictingDates,
    afterCutoff,
    earliestFiled: dates[0] || null,
    latestFiled: dates.at(-1) || null,
    status: !sources.length
      ? "No source inputs"
      : conflictingDates
        ? "Inconsistent filing dates"
        : incomplete
          ? "Incomplete filing metadata"
          : rows.length > 1
            ? "Multiple source filings"
            : "One source filing",
    explanation: !sources.length
      ? "No reported input is available for inspection."
      : conflictingDates
        ? `${conflictingDates} accession${conflictingDates === 1 ? " has" : "s have"} different filing dates across the retained inputs. Check the original filing metadata.`
        : incomplete
          ? `${incomplete} input${incomplete === 1 ? " has" : "s have"} no accession or filing date; filing coherence cannot be fully assessed.`
          : rows.length > 1
            ? "Inputs come from more than one filing. This can be expected for trailing periods, opening balances, or later reported values; inspect the source contexts."
            : "Every retained input has a filing date and the same accession. This is a provenance check, not a financial reconciliation.",
  };
}

export function buildAnalysisSourceMatrix(data, settings = {}, index = 0) {
  const start = Math.max(0, index);
  const count = [4, 8, 12].includes(Number(settings.years))
    ? Number(settings.years)
    : 8;
  const periods = (data.periods || [])
    .slice(start, start + count)
    .map((period, offset) => ({ period, index: start + offset }));
  const rows = (data.definitions || []).map((definition) => ({
    definition,
    cells: periods.map(({ period, index: periodIndex }) => {
      const point = data.metrics[definition.key]?.[periodIndex];
      return {
        ...analysisSourceState(point),
        point,
        period,
        index: periodIndex,
      };
    }),
  }));
  const cells = rows.flatMap((row) => row.cells);
  return {
    periods,
    rows,
    totals: {
      total: cells.length,
      available: cells.filter((cell) => cell.available).length,
      reported: cells.filter((cell) => cell.kind === "reported").length,
      calculated: cells.filter((cell) => cell.kind === "calculated").length,
      missing: cells.filter((cell) => cell.kind === "missing").length,
      revised: cells.filter((cell) => cell.revised).length,
    },
  };
}

/** Deduplicate revision history shared by ratios, statements and adjacent TTM periods. */
export function analysisRevisionLedger(data, indices) {
  const periodIndices =
    indices || (data.periods || []).map((_, index) => index);
  const ledger = new Map();
  for (const definition of data.definitions || []) {
    for (const index of periodIndices) {
      const point = data.metrics[definition.key]?.[index];
      for (const source of uniqueAnalysisSources(point)) {
        const revisions = (source.revisions || []).filter((row) =>
          Number.isFinite(row.value),
        );
        if (!revisions.length) continue;
        const id = analysisSourceContext(source);
        if (!ledger.has(id))
          ledger.set(id, {
            id,
            source,
            revisions: new Map(),
            uses: new Map(),
            retainedHistoryLimit: 12,
          });
        const entry = ledger.get(id);
        for (const revision of revisions) {
          const key = JSON.stringify([
            revision.accession || null,
            revision.filed || null,
            revision.value,
          ]);
          entry.revisions.set(key, {
            ...revision,
            documentUrl: analysisSecUrl(revision.documentUrl),
          });
        }
        entry.uses.set(`${definition.key}:${index}`, {
          definition,
          index,
          period: data.periods[index],
          point,
        });
      }
    }
  }
  return [...ledger.values()]
    .map((entry) => ({
      ...entry,
      revisions: [...entry.revisions.values()].sort(
        (a, b) =>
          (a.filed || "").localeCompare(b.filed || "") ||
          (a.accession || "").localeCompare(b.accession || ""),
      ),
      uses: [...entry.uses.values()],
    }))
    .sort(
      (a, b) =>
        (b.revisions.at(-1)?.filed || "").localeCompare(
          a.revisions.at(-1)?.filed || "",
        ) || a.source.tag.localeCompare(b.source.tag),
    );
}

export function analysisComparisonIndex(
  data,
  point,
  fallback = 0,
  baseline = "year",
) {
  const index = (data?.periods || []).findIndex(
    (period) =>
      period.end === point?.period?.end && period.kind === point?.period?.kind,
  );
  return analysisBaseline(
    data?.periods || [],
    index >= 0 ? index : fallback,
    baseline,
  );
}

export function analysisEvidenceComparison(data, selection, beforeIndex) {
  const definition = data?.definitions?.find(
    (item) => item.key === selection?.definition?.key,
  );
  if (!definition || beforeIndex < 0 || !data.periods[beforeIndex]) return null;
  const common =
    definition.format === "currency" &&
    selection.definition.format === "percent" &&
    ["income", "balance", "cashflow"].includes(definition.category);
  const before = common
    ? commonSizePoint(data, definition.key, beforeIndex)
    : data.metrics[definition.key]?.[beforeIndex];
  const current = selection.point;
  const change = growthCompatibility(
    current,
    before,
    selection.definition.format,
  );
  const currentTags = new Set(
    uniqueAnalysisSources(current).map(
      (source) => `${source.taxonomy}:${source.tag}:${source.unit}`,
    ),
  );
  const previousTags = new Set(
    uniqueAnalysisSources(before).map(
      (source) => `${source.taxonomy}:${source.tag}:${source.unit}`,
    ),
  );
  const sourceTagsChanged =
    currentTags.size !== previousTags.size ||
    [...currentTags].some((tag) => !previousTags.has(tag));
  return { current, before, change, common, sourceTagsChanged };
}

/** A saved observation keeps its original cutoff, including an explicitly unknown one. */
export function analysisCollectionSettings(
  selection,
  data,
  settings,
  point,
  fromLoadedData = false,
) {
  if (
    !fromLoadedData &&
    Object.prototype.hasOwnProperty.call(selection || {}, "analysisSettings")
  )
    return selection.analysisSettings ?? null;
  return {
    basis: fromLoadedData
      ? data?.basis || point?.period?.kind || settings?.basis
      : point?.period?.kind || data?.basis || settings?.basis,
    end: point?.period?.end,
    asOf: typeof data?.asOf === "string" ? data.asOf : settings?.asOf || "",
  };
}
