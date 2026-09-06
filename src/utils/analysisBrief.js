import { analysisPath, analysisValue } from "./analysisNotebook.js";
import { analysisChecks } from "./analysisResearch.js";
import { evidenceSources, evidenceCalculations } from "./researchEvidence.js";

export const BRIEF_SECTIONS = [
  {
    key: "summary",
    label: "Research summary",
    description: "Company, reporting basis, coverage and selected highlights.",
  },
  {
    key: "metrics",
    label: "Selected-period metrics",
    description: "Values, formulas, missing inputs and source references.",
  },
  {
    key: "history",
    label: "Four-period financial table",
    description: "Selected metrics through the chosen reporting period.",
  },
  {
    key: "coverage",
    label: "Data quality and coverage",
    description: "Availability, reconciliation checks and limitations.",
  },
  {
    key: "notes",
    label: "Private research notes",
    description: "Include the notes currently shown in this notebook.",
  },
  {
    key: "evidence",
    label: "Collected evidence",
    description:
      "Saved figures and notes, including evidence from other financial views.",
  },
  {
    key: "sources",
    label: "Detailed source appendix",
    description:
      "Add intermediate calculations and source revision histories. Compact citations are always included.",
  },
];
export const DEFAULT_BRIEF_SECTIONS = BRIEF_SECTIONS.filter(
  (s) => s.key !== "sources",
).map((s) => s.key);

const text = (value) =>
  ["string", "number", "boolean"].includes(typeof value) ? String(value) : "";
export const escapeBriefHtml = (value) =>
  text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export function safeBriefSecUrl(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" &&
      ["www.sec.gov", "sec.gov", "data.sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
      ? url.href
      : "";
  } catch {
    return "";
  }
}
export function briefMetricKeys(data, settings = {}) {
  const valid = new Set((data.definitions || []).map((d) => d.key));
  const requested =
    Array.isArray(settings.briefMetrics) && settings.briefMetrics.length
      ? settings.briefMetrics
      : data.highlights || ["netIncome", "totalAssets", "operatingCashFlow"];
  const selected = [
    ...new Set(requested.filter((key) => valid.has(key))),
  ].slice(0, 24);
  // A saved metric set from a different industry must still open a useful brief.
  return selected.length
    ? selected
    : (data.definitions || [])
        .filter((d) =>
          ["income", "balance", "cashflow", "ratios"].includes(d.category),
        )
        .slice(0, 6)
        .map((d) => d.key);
}
export function briefSectionKeys(settings = {}) {
  return Array.isArray(settings.briefSections)
    ? [
        ...new Set(
          settings.briefSections.filter((key) =>
            BRIEF_SECTIONS.some((s) => s.key === key),
          ),
        ),
      ]
    : [...DEFAULT_BRIEF_SECTIONS];
}

/** All rendered and exported figures use this one source-preserving report model. */
export function buildAnalysisBrief(
  data,
  settings,
  index,
  notes = "",
  evidence = [],
) {
  if (!data?.periods?.[index])
    throw new Error(
      "Choose an available reporting period before creating a brief.",
    );
  const sections = briefSectionKeys(settings);
  const keys = briefMetricKeys(data, settings);
  const definitions = keys.map((key) =>
    data.definitions.find((d) => d.key === key),
  );
  const period = data.periods[index];
  const periods = data.periods.slice(
    index,
    index + (sections.includes("history") ? 4 : 1),
  );
  const sources = [],
    sourceIndex = new Map();
  function record(definition, point, recordPeriod, kind, recordNotes = "") {
    const inputs = evidenceSources(point);
    const refs = inputs.map((source) => {
      const normalized = {
        ...source,
        documentUrl: safeBriefSecUrl(source.documentUrl),
      };
      const id = JSON.stringify(normalized);
      if (!sourceIndex.has(id)) {
        sourceIndex.set(id, sources.length + 1);
        sources.push({ ...normalized, reference: sources.length + 1 });
      }
      return sourceIndex.get(id);
    });
    const value = Number.isFinite(point?.value) ? point.value : null;
    return {
      key: definition.key || "",
      label: text(definition.label),
      format: definition.format || "currency",
      kind,
      value,
      formatted: analysisValue(
        value,
        definition.format,
        settings.units || "auto",
      ),
      period: point?.period || recordPeriod || {},
      originalCutoff:
        text(point?.period?.asOf) ||
        "Not recorded; may have used latest available",
      instant: inputs.length > 0 && inputs.every((s) => !s.start),
      classification: text(point?.classification) || "unavailable",
      formula: text(point?.formula),
      reason:
        value == null
          ? text(point?.reason) ||
            "A required reported input is unavailable; missing values are not zero."
          : "",
      note: text(point?.note),
      notes: text(recordNotes),
      refs: [...new Set(refs)],
      calculations: evidenceCalculations(point),
    };
  }
  const includeMetrics = sections.some((key) =>
    ["summary", "metrics", "history"].includes(key),
  );
  const rows = includeMetrics
    ? definitions.map((definition) => ({
        definition,
        points: periods.map((p, offset) =>
          record(
            definition,
            data.metrics[definition.key]?.[index + offset],
            p,
            "Selected metric",
          ),
        ),
      }))
    : [];
  const selectedAvailable = definitions.filter((d) =>
    Number.isFinite(data.metrics[d.key]?.[index]?.value),
  ).length;
  const quality = sections.includes("coverage")
    ? analysisChecks(data, index)
    : null;
  const checks = quality
    ? quality.checks.map((check) => ({
        ...check,
        record: record(
          { key: check.key, label: check.title, format: "currency" },
          check.point,
          period,
          "Data check",
        ),
      }))
    : [];
  const collected = sections.includes("evidence")
    ? (Array.isArray(evidence) ? evidence : []).map((entry) => {
        const item = record(
          {
            label: entry.label || "Collected evidence",
            format: entry.format || "currency",
          },
          entry.point,
          {},
          "Collected evidence",
          entry.notes || entry.text,
        );
        return {
          ...item,
          originalCutoff:
            typeof entry.analysisSettings?.asOf === "string"
              ? entry.analysisSettings.asOf || "Latest available when collected"
              : item.originalCutoff,
          collectedAt: text(entry.collectedAt),
        };
      })
    : [];
  return {
    title:
      text(settings.briefTitle).trim().slice(0, 160) ||
      `${data.ticker} financial research brief`,
    ticker: text(data.ticker),
    name: text(data.name),
    cik: text(data.cik),
    lens: text(data.lens),
    basis: text(data.basis || settings.basis),
    asOf: text(settings.asOf) || "Latest available",
    requestedEnd: text(settings.end) || "latest",
    observedAt: text(data.observedAt),
    note: text(data.note),
    units: settings.units || "auto",
    period,
    periods,
    sections,
    keys,
    rows,
    quality,
    checks,
    selectedAvailable,
    selectedTotal: definitions.length,
    notes: text(notes),
    evidence: collected,
    sources,
    path: analysisPath(data.ticker, { ...settings, end: period.end }),
  };
}

const h = escapeBriefHtml;
const link = (url, label) =>
  url
    ? `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">${h(label)}</a>`
    : h("SEC link unavailable");
const refs = (record) =>
  record.refs
    .map((id) => `<a href="#source-${id}" class="reference">[${id}]</a>`)
    .join(" ");
const periodText = (record) =>
  `${record.instant ? "Instant" : record.period?.start || "Start unavailable"} → ${record.period?.end || "End unavailable"}`;
function pointHtml(record) {
  return `<strong>${h(record.formatted)}</strong> ${refs(record)}<p class="metadata">${h(record.period.kind || "Basis unavailable")} · ${h(periodText(record))} · ${h(record.classification)}</p>${record.formula ? `<p>Formula: ${h(record.formula)}</p>` : ""}${record.reason ? `<p class="missing">${h(record.reason)}</p>` : ""}${record.note ? `<p>${h(record.note)}</p>` : ""}`;
}
const sectionHtml = (title, content) =>
  `<section><h2>${h(title)}</h2>${content}</section>`;
export function analysisBriefHtml(model) {
  const include = (key, content) =>
    model.sections.includes(key) ? content : "";
  const summary = `<p>${h(model.selectedAvailable)} of ${h(model.selectedTotal)} selected metrics have values for the selected period. This count describes data availability; it is not a financial risk rating.</p><div class="highlights">${model.rows
    .slice(0, 3)
    .map(
      (row) =>
        `<article><h3>${h(row.definition.label)}</h3>${pointHtml(row.points[0])}</article>`,
    )
    .join("")}</div>`;
  const selected = model.rows
    .map(
      (row) =>
        `<article><h3>${h(row.definition.label)}</h3>${pointHtml(row.points[0])}</article>`,
    )
    .join("");
  const history = `<p class="metadata">Up to four available periods ending at the selected period, newest first. Values retain the selected ${h(model.basis)} basis; no growth or period-to-period comparability is assumed.</p><div class="table-wrap"><table><thead><tr><th scope="col">Metric</th>${model.periods.map((p) => `<th scope="col">${h(p.end)}<small>${h(p.kind)} · ${h(p.start || "Start unavailable")}</small></th>`).join("")}</tr></thead><tbody>${model.rows.map((row) => `<tr><th scope="row">${h(row.definition.label)}</th>${row.points.map((point) => `<td>${h(point.formatted)} ${refs(point)}<small>${h(point.classification)}${point.instant ? " · Instant" : ""}${point.reason ? ` · ${h(point.reason)}` : ""}${point.formula ? ` · ${h(point.formula)}` : ""}</small></td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const coverage = model.quality
    ? `<p>${h(model.quality.available)} of ${h(model.quality.total)} standard statement and ratio metrics are available; ${h(model.quality.calculated)} are calculated. ${h(model.quality.revised)} source contexts contain different filed values. A revision can reflect a reporting change and does not establish an error.</p>${model.checks.map((check) => `<article><h3>${h(check.title)} · ${h(check.status)}</h3>${pointHtml(check.record)}<p class="metadata">Reconciliation tolerance: ${h(analysisValue(check.tolerance, "currency", "raw"))}. ${check.status === "Incomplete" ? "This check cannot be completed with the available inputs." : "A reconciled extract is not an audit of the filed statements."}</p></article>`).join("")}<p>Missing metrics: ${h(model.quality.missing.map((d) => d.label).join(", ") || "None in this standard metric set")}</p><p>${h(model.note)}</p>`
    : "";
  const evidence = `<p class="metadata">Collected evidence retains its original dates and values and can come from other financial views. The report cutoff above does not re-filter these saved figures; an original cutoff is shown only when it was stored.</p>${model.evidence.length ? model.evidence.map((record) => `<article><h3>${h(record.label)}</h3>${pointHtml(record)}<p class="metadata">Original filing cutoff: ${h(record.originalCutoff)}${record.collectedAt ? ` · collected ${h(record.collectedAt)}` : ""}</p>${record.notes ? `<pre>${h(record.notes)}</pre>` : ""}</article>`).join("") : "<p>No collected evidence was supplied.</p>"}`;
  const sources = model.sources.length
    ? sectionHtml(
        "Source references",
        `<p class="metadata">References are deduplicated across the report. Source values below are raw reported units; report values use ${h(model.units)} display units.</p><ol class="sources">${model.sources.map((source) => `<li id="source-${source.reference}"><strong>[${source.reference}] ${h(source.taxonomy ? `${source.taxonomy}:` : "")}${h(source.tag || "Tag unavailable")}</strong>: ${h(source.value)} ${h(source.unit)}; ${h(source.start || "Instant")} → ${h(source.end || "End unavailable")}; filed ${h(source.filed || "Unavailable")} (${h(source.form || "Form unavailable")}); accession ${h(source.accession || "Unavailable")}. ${link(source.documentUrl, "Original SEC filing")}</li>`).join("")}</ol>`,
      )
    : "";
  const records = [
    ...model.rows.flatMap((row) => row.points),
    ...model.checks.map((check) => check.record),
    ...model.evidence,
  ];
  const calculations = records
    .filter((record) => record.calculations.length)
    .map(
      (record) =>
        `<article><h3>${h(record.label)} · ${h(record.period.end)}</h3><ul>${record.calculations.map((c) => `<li>${h(c.start || "Instant")} → ${h(c.end)}: ${h(c.value)} ${h(c.unit)} = ${h(c.formula)}</li>`).join("")}</ul></article>`,
    )
    .join("");
  const revisions = model.sources
    .filter((source) => source.revised)
    .map(
      (source) =>
        `<article><h3>Source [${source.reference}] · ${h(source.tag)}</h3><ul>${(source.revisions || []).map((r) => `<li>Filed ${h(r.filed)}: ${h(r.value)} ${h(source.unit)}; ${h(r.form)}; accession ${h(r.accession || r.accn || "Unavailable")}. ${link(safeBriefSecUrl(r.documentUrl), "SEC revision")}</li>`).join("")}</ul></article>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${h(model.title)}</title><style>body{font:15px/1.6 system-ui,sans-serif;color:#1c2939;background:#fff;max-width:1040px;margin:0 auto;padding:32px}h1,h2,h3{line-height:1.25}h1{font-size:30px;margin:10px 0}h2{font-size:21px}h3{font-size:16px}p{margin:8px 0}header{border-bottom:3px solid #334c68;padding-bottom:20px}section{border-bottom:1px solid #ccd4dd;padding:14px 0}article{margin:16px 0;break-inside:avoid}.metadata,small{color:#48586b;font-size:12px}.brand{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}a{color:#125c9a;overflow-wrap:anywhere}.reference{font-size:11px;white-space:nowrap}.highlights{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:18px}.highlights article{border-left:3px solid #b7c8d8;padding-left:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.missing{color:#704700}.table-wrap{overflow:auto}table{border-collapse:collapse;font-size:12px;width:100%;table-layout:fixed}th,td{padding:9px 7px;border:1px solid #d0d8e1;text-align:left;vertical-align:top;overflow-wrap:anywhere}thead th{background:#eef3f8}small{display:block;line-height:1.5;margin-top:4px}.sources{list-style:none;padding:0;font-size:11px}.sources li{margin:8px 0;overflow-wrap:anywhere;break-inside:avoid}footer{padding-top:20px;font-size:12px}@media print{body{padding:0;font-size:10pt;max-width:none}h1{font-size:22pt}h2{break-after:avoid}thead{display:table-header-group}tr{break-inside:avoid}.table-wrap{overflow:visible}a{color:inherit}.metadata,small{font-size:9pt}.sources{font-size:8pt}}@page{size:auto;margin:16mm}</style></head><body><header><p class="brand">EDGAR Terminal · financial research</p><h1>${h(model.title)}</h1><p>${h(model.name)} (${h(model.ticker)}) · SEC CIK ${h(model.cik)} · ${h(model.lens)} financial lens</p><p>${h(model.basis)} basis · selected period ${h(model.period.start || "Start unavailable")} → ${h(model.period.end)}<br>Filing cutoff: ${h(model.asOf)} · requested end: ${h(model.requestedEnd)}<br>Data observed: ${h(model.observedAt)} · display units: ${h(model.units)}</p><p class="metadata">Normalized reported and calculated values; missing values remain missing. Table display settings such as common size do not alter this brief's reported metric units.</p></header>${include("summary", sectionHtml("Research summary", summary))}${include("metrics", sectionHtml("Selected-period metrics", selected))}${include("history", sectionHtml("Financial history", history))}${include("coverage", sectionHtml("Data quality and coverage", coverage))}${include("notes", sectionHtml("Private research notes", `<pre>${h(model.notes || "No research notes supplied.")}</pre>`))}${include("evidence", sectionHtml("Collected evidence", evidence))}${sources}${include("sources", sectionHtml("Detailed source appendix", calculations + revisions || "<p>No intermediate calculations or revision histories are available for these selections.</p>"))}<footer><p>${link(`https://secedgarterminal.com${model.path}`, "Reopen the configured financial view")}. Latest-available inputs can change as new filings arrive.</p><p>Notes and collected evidence are included only when selected. They remain private to your browser until you share this exported file. To save a PDF, open this HTML file in your browser and choose Print → Save as PDF.</p></footer></body></html>`;
}

const csvCell = (value) => {
  const raw = text(value);
  const safe =
    typeof value === "number" && Number.isFinite(value)
      ? raw
      : /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(raw)
        ? `'${raw}`
        : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};
/** Selected data, one row per source input. Analyst prose is never evaluated as a formula. */
export function analysisBriefCsv(model) {
  const header = [
    "Report title",
    "Ticker",
    "CIK",
    "Record type",
    "Metric",
    "Value",
    "Format",
    "Report basis",
    "Point basis",
    "Point start",
    "Point end",
    "Report filing cutoff",
    "Evidence original cutoff",
    "Requested end",
    "Data observed",
    "Classification",
    "Formula",
    "Missing reason",
    "Point note",
    "Evidence note",
    "Source reference",
    "Source tag",
    "Source value",
    "Source unit",
    "Source start",
    "Source end",
    "Source filed",
    "Source form",
    "Source accession",
    "SEC URL",
    "Intermediate calculations",
    "Research notes",
    "Report settings URL",
    "Evidence collected at",
  ];
  const records = [
    ...model.rows.flatMap((row) => row.points),
    ...model.checks.map((check) => check.record),
    ...model.evidence,
  ];
  const rows = records.flatMap((record) =>
    (record.refs.length ? record.refs : [null]).map((ref) => {
      const source = ref == null ? null : model.sources[ref - 1];
      return [
        model.title,
        model.ticker,
        model.cik,
        record.kind,
        record.label,
        record.value,
        record.format,
        model.basis,
        record.period.kind || "Unavailable",
        record.instant ? "Instant" : record.period.start,
        record.period.end,
        model.asOf,
        record.kind === "Collected evidence" ? record.originalCutoff : "",
        model.requestedEnd,
        model.observedAt,
        record.classification,
        record.formula,
        record.reason,
        record.note,
        record.notes,
        ref,
        source?.taxonomy ? `${source.taxonomy}:${source.tag}` : source?.tag,
        source?.value,
        source?.unit,
        source?.start || (source ? "Instant" : ""),
        source?.end,
        source?.filed,
        source?.form,
        source?.accession,
        source?.documentUrl,
        record.calculations.length ? JSON.stringify(record.calculations) : "",
        model.sections.includes("notes") ? model.notes : "",
        `https://secedgarterminal.com${model.path}`,
        record.collectedAt,
      ];
    }),
  );
  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}
