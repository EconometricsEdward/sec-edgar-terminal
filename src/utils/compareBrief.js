import { compareBriefDefaults } from "./compareLibrary.js";

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
export function safeCompareSourceUrl(value) {
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
const exactValue = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "Unavailable";
const unit = (format) =>
  format === "currency" ? "USD" : format === "percent" ? "%" : "×";
/** @param {any} notebook
 * @param {{selectedIds?: string[], settings?: any, exportedAt?: string}} options */
export function buildCompareBrief(
  notebook,
  {
    selectedIds = [],
    settings = compareBriefDefaults(notebook),
    exportedAt = new Date().toISOString(),
  } = {},
) {
  const ids = new Set(selectedIds);
  const items = notebook.pins
    .filter((pin) => ids.has(pin.id))
    .map((pin) => JSON.parse(JSON.stringify(pin)));
  const groupKey = (pin) =>
    settings.groupBy === "company"
      ? pin.ticker
      : settings.groupBy === "metric"
        ? pin.label
        : "Selected observations";
  const groups = [...new Set(items.map(groupKey))].map((label) => ({
    label,
    items: items.filter((pin) => groupKey(pin) === label),
  }));
  return {
    settings: { ...settings },
    collectionName: notebook.collectionName || "Peer comparison research",
    memo: notebook.notes || "",
    exportedAt,
    selectedCount: items.length,
    omittedCount: notebook.pins.length - items.length,
    companyCount: new Set(items.map((pin) => pin.cik || pin.ticker)).size,
    sourceCount: new Set(
      items.flatMap((pin) =>
        (pin.point?.sources || [])
          .filter((source) => source.accession)
          .map((source) => `${pin.cik || pin.ticker}:${source.accession}`),
      ),
    ).size,
    items,
    groups,
  };
}

export function compareBriefHtml(brief) {
  const e = escapeHtml;
  const sourceHtml = (source) => {
    const href = safeCompareSourceUrl(source.documentUrl);
    return `<li><strong>${e(source.label || source.tag)}</strong> (${e(source.tag)})<br>${e(exactValue(source.value))} ${e(source.unit)} · ${e(source.start || "Balance at")} → ${e(source.end)}<br>${e(source.form)} · Filed ${e(source.filed)} · Accession ${e(source.accession)}${source.revised ? "<br>Different reported values exist for this context; this alone does not establish a restatement." : ""}${href ? `<br><a href="${e(href)}">Original SEC filing</a>` : ""}</li>`;
  };
  const pinHtml = (pin) =>
    `<article><h3>${e(pin.ticker)} · ${e(pin.label)}</h3><p><strong>${e(exactValue(pin.point?.value))} ${e(unit(pin.format))}</strong><br>${e(pin.name)} · CIK ${e(pin.cik)}<br>${e(pin.point?.period?.kind || pin.settings?.basis)} · ${e(pin.point?.period?.start || "Balance at")} → ${e(pin.point?.period?.end)}<br>Classification: ${e(pin.point?.classification || "Unavailable")} · Filing cutoff: ${e(pin.settings?.asOf || "Latest available at capture")}</p><p>${e(pin.point?.formula || pin.point?.reason || "Reported SEC observation")}<br>${e(pin.point?.note || "")}</p><p>Analyst notes: ${e(pin.notes || "None")}<br>Tags: ${e(pin.tags || "None")}</p><p class="meta">Captured ${e(pin.savedAt)} · Data version ${e(pin.version)}</p>${pin.point?.calculations?.length ? `<h4>Intermediate calculations</h4><ul>${pin.point.calculations.map((calculation) => `<li>${e(calculation.formula)}<br>${e(exactValue(calculation.value))} ${e(calculation.unit || "USD")} · ${e(calculation.start || "Balance at")} → ${e(calculation.end)}</li>`).join("")}</ul>` : ""}<h4>Original reported inputs</h4>${pin.point?.sources?.length ? `<ol>${pin.point.sources.map(sourceHtml).join("")}</ol>` : "<p>No original source inputs were captured for this observation.</p>"}<h4>Original comparison settings</h4><pre>${e(JSON.stringify(pin.settings || {}, null, 2))}</pre></article>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(brief.settings.title)}</title><style>body{max-width:960px;margin:36px auto;padding:0 24px;font:15px/1.65 system-ui;color:#172b40;background:#fff}h1{font-size:32px;line-height:1.2}h2{font-size:23px;border-top:2px solid #bdcbd7;padding-top:18px}h3{font-size:19px}h4{margin-bottom:8px}article{border-top:1px solid #c9d5df;margin-top:24px;padding-top:12px;break-inside:avoid}p,pre,li{white-space:pre-wrap;overflow-wrap:anywhere}li{margin-bottom:12px}pre{font:12px/1.5 monospace;background:#f2f6fa;padding:12px}.meta{font-size:12px;color:#4b6278}a{color:#096187}@media print{body{margin:0;padding:0}a{color:inherit}h2,h3,h4{break-after:avoid}}</style></head><body><h1>${e(brief.settings.title)}</h1><p class="meta">EDGAR Terminal · Peer comparison research · Prepared ${e(brief.exportedAt)}</p><p>${brief.selectedCount} selected observations · ${brief.companyCount} companies · ${brief.sourceCount} source filings · ${brief.omittedCount} saved observations omitted</p><p class="meta">This brief contains selected captured evidence, not a complete company review. Accounting ratios and numeric ranks are not investment or credit ratings. Dates, filing cutoffs and business models can differ across observations; compare the original settings and sources before drawing conclusions.</p>${brief.settings.researchQuestion ? `<h2>Research question</h2><p>${e(brief.settings.researchQuestion)}</p>` : ""}${brief.settings.narrative ? `<h2>Analyst narrative</h2><p>${e(brief.settings.narrative)}</p>` : ""}${brief.memo ? `<h2>Saved collection memo</h2><p>${e(brief.memo)}</p>` : ""}${brief.groups.map((group) => `<section><h2>${e(group.label)}</h2>${group.items.map(pinHtml).join("")}</section>`).join("")}${brief.settings.conclusions ? `<h2>Conclusions and open questions</h2><p>${e(brief.settings.conclusions)}</p>` : ""}</body></html>`;
}

const csvCell = (value) => {
  const raw = String(value ?? "");
  return `"${(typeof value === "string" && /^[\s]*[=+@-]/.test(raw) ? "'" : "") + raw.replaceAll('"', '""')}"`;
};
export function compareBriefCsv(brief) {
  const columns = [
    "brief_title",
    "research_question",
    "analyst_narrative",
    "conclusions",
    "collection",
    "collection_memo",
    "grouping",
    "prepared_at",
    "selected_observations",
    "omitted_observations",
    "evidence_order",
    "group",
    "ticker",
    "company",
    "cik",
    "metric",
    "metric_label",
    "metric_category",
    "metric_definition",
    "exact_value",
    "unit",
    "period_basis",
    "period_start",
    "period_end",
    "classification",
    "formula",
    "missing_reason",
    "calculation_note",
    "analyst_notes",
    "tags",
    "captured_at",
    "data_version",
    "original_settings",
    "intermediate_calculations",
    "source_tag",
    "source_value",
    "source_unit",
    "source_start",
    "source_end",
    "source_form",
    "source_filed",
    "source_accession",
    "source_revised",
    "source_url",
  ];
  let order = 0;
  const rows = brief.groups.flatMap((group) =>
    group.items.flatMap((pin) => {
      order++;
      return (pin.point?.sources?.length ? pin.point.sources : [{}]).map(
        (source) => [
          brief.settings.title,
          brief.settings.researchQuestion,
          brief.settings.narrative,
          brief.settings.conclusions,
          brief.collectionName,
          brief.memo,
          brief.settings.groupBy,
          brief.exportedAt,
          brief.selectedCount,
          brief.omittedCount,
          order,
          group.label,
          pin.ticker,
          pin.name,
          pin.cik,
          pin.metric,
          pin.label,
          pin.category,
          JSON.stringify(
            pin.metricDefinition || { definition: pin.definition || "" },
          ),
          pin.point?.value,
          unit(pin.format),
          pin.point?.period?.kind || pin.settings?.basis,
          pin.point?.period?.start,
          pin.point?.period?.end,
          pin.point?.classification,
          pin.point?.formula,
          pin.point?.reason,
          pin.point?.note,
          pin.notes,
          pin.tags,
          pin.savedAt,
          pin.version,
          JSON.stringify(pin.settings || {}),
          JSON.stringify(pin.point?.calculations || []),
          source.tag,
          source.value,
          source.unit,
          source.start,
          source.end,
          source.form,
          source.filed,
          source.accession,
          source.revised,
          safeCompareSourceUrl(source.documentUrl),
        ],
      );
    }),
  );
  return (
    "\uFEFF" +
    [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
  );
}
