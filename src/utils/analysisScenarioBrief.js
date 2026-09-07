import { sourceDocumentUrl } from "./xbrlPeriods.js";
import {
  scenarioCaseCompatibility,
  scenarioCaseRows,
  validateScenarioCase,
} from "./analysisScenarioCases.js";

export const SCENARIO_MODEL_LIMITS =
  "Hypothetical sensitivities using user assumptions, not forecasts or reported SEC results. Operating and balance exercises are independent. No probabilities, taxes, regulatory capital treatment, management response, or secondary effects are modeled. Reported shareholder equity and consolidated assets can differ in accounting scope. Reported cash is not verified as unrestricted or available. Missing inputs remain unavailable. Saved inputs and results are immutable snapshots; restoring assumptions recalculates using the available financial data.";
export const SCENARIO_ASSUMPTION_LABELS = {
  scenarioModel: "Operating model",
  scenarioRevenue: "Revenue change (%)",
  scenarioMargin: "Operating margin change (pp)",
  scenarioLoss: "Incremental loss / baseline assets (%)",
  scenarioFunding: "Deposit withdrawal (%)",
  scenarioVariableCost: "Variable share of baseline operating costs (%)",
  scenarioCostChange: "Operating cost change (%)",
  scenarioCashAvailable: "Reported cash available (%)",
  scenarioReplacementFunding: "Replacement funding / baseline deposits (%)",
  goalMode: "Goal: solve for",
  goalTargetIncome: "Goal: target operating income (full USD)",
  goalAssumedRevenue: "Goal: assumed revenue (full USD)",
  goalAssumedMargin: "Goal: assumed operating margin (%)",
  goalEquityFloor: "Goal: minimum shareholder equity / assets (%)",
  goalOperatingSolved: "Operating target solved",
  goalAssetSolved: "Asset-loss target solved",
};
const h = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const raw = (value) => (Number.isFinite(value) ? String(value) : "Unavailable");
const unit = (format) =>
  format === "currency"
    ? "USD"
    : format === "percent"
      ? "%"
      : format === "percentagePoints"
        ? "pp"
        : format || "";
const csvCell = (value) =>
  `"${(typeof value === "number" ? String(value) : String(value ?? "").replace(/^[=+@-]/, "'$&")).replaceAll('"', '""')}"`;
export function scenarioSourceUrl(cik, source) {
  const candidate = source.documentUrl || sourceDocumentUrl(cik, source);
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" &&
      ["www.sec.gov", "data.sec.gov", "sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

/** The same model drives the on-screen document and both downloadable formats. */
export function buildScenarioBrief(
  cases,
  exportedAt = new Date().toISOString(),
) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 9)
    throw new Error("Choose one to nine scenario snapshots for the brief.");
  cases.forEach((entry) => validateScenarioCase(entry));
  cases = JSON.parse(JSON.stringify(cases));
  const reference = cases[0];
  return {
    title: `${reference.context.ticker} hypothetical scenario brief`,
    exportedAt,
    limits: SCENARIO_MODEL_LIMITS,
    cases: cases.map((entry) => ({
      ...entry,
      compatibility: scenarioCaseCompatibility(reference, entry),
      assumptions: Object.entries(entry.settings)
        .filter(
          ([key, value]) =>
            Object.hasOwn(SCENARIO_ASSUMPTION_LABELS, key) &&
            (!key.startsWith("goal") ||
              (value !== null && value !== "" && value !== false)),
        )
        .map(([key, value]) => ({
          key,
          label: SCENARIO_ASSUMPTION_LABELS[key],
          value,
        })),
      rows: scenarioCaseRows(entry).map((row) => ({
        ...row,
        unit: unit(row.format),
        delta:
          Number.isFinite(row.baseline) &&
          Number.isFinite(row.selection.point.value)
            ? row.selection.point.value - row.baseline
            : null,
      })),
      exercises: [
        ...(entry.snapshot.operating
          ? [{ label: "Operating sensitivity", ...entry.snapshot.operating }]
          : []),
        { label: "Balance sensitivity", ...entry.snapshot.balance },
      ],
    })),
  };
}

function sourceHtml(cik, source) {
  const url = scenarioSourceUrl(cik, source);
  return `<li><strong>${h(source.label || source.tag || "Reported input")}</strong>: ${h(raw(source.value))} ${h(source.unit)}; ${h(source.start || "Instant")} → ${h(source.end || "End unavailable")}; filed ${h(source.filed || "Unavailable")}; accession ${h(source.accession || "Unavailable")}. ${url ? `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">SEC source</a>` : "SEC link unavailable"}</li>`;
}

function additionalEvidence(entry) {
  const bridge = (entry.snapshot.operating?.bridge || []).map((row) => ({
    ...row,
    kind: "Operating income bridge",
  }));
  const calculations = entry.rows.flatMap((row) =>
    (row.selection.point.calculations || []).map((point) => ({
      label: row.label,
      point,
    })),
  );
  return { bridge, calculations };
}

function additionalEvidenceHtml(entry) {
  const extra = additionalEvidence(entry);
  return `<p>Goal targets are separate planning inputs. Solving a target does not apply it to the sensitivity case; assumptions change only when the analyst chooses to apply the result. Unconfigured targets use the reported baseline.</p>${(entry.goalSnapshots || []).map((goal) => `<h3>Hypothetical goal: ${h(goal.label)}</h3>${goal.reason ? `<p>Unavailable: ${h(goal.reason)}</p>` : ""}${goal.rows.map((selection) => `<h4>${h(selection.definition.label)}: ${h(raw(selection.point.value))} ${h(unit(selection.definition.format))}</h4><p>${h(selection.point.formula)}</p><p>${h(selection.point.note)}</p><ul>${(selection.point.sources || []).map((source) => sourceHtml(entry.context.cik, source)).join("")}</ul>`).join("")}`).join("")}${extra.bridge.length ? `<h3>Hypothetical operating income bridge</h3><p>${h(entry.snapshot.operating.bridgeMethod || "")}</p>${extra.bridge.map((row) => `<h4>${h(row.label)}: ${h(raw(row.selection.point.value))} ${h(unit(row.format))}</h4><p>${h(row.selection.point.formula)}</p><p>${h(row.selection.point.note)}</p><ul>${(row.selection.point.sources || []).map((source) => sourceHtml(entry.context.cik, source)).join("")}</ul>`).join("")}` : ""}${extra.calculations.length ? `<h3>Intermediate source calculations</h3><ul>${extra.calculations.map(({ label, point }) => `<li>${h(label)}: ${h(raw(point.value))} ${h(point.unit || "USD")} = ${h(point.formula || "Formula unavailable")}; ${h(point.start || "Instant")} → ${h(point.end || "End unavailable")}</li>`).join("")}</ul>` : ""}`;
}

export function scenarioBriefHtml(model) {
  const comparable = model.cases.filter(
    (entry) => entry.compatibility.compatible,
  );
  const keys = [
    ...new Set(
      comparable.flatMap((entry) => entry.rows.map((row) => row.comparisonKey)),
    ),
  ];
  const comparison =
    comparable.length > 1
      ? `<section><h2>Comparison on matching reported inputs</h2><p>Values below are hypothetical. Cases with a different period, cutoff, financial data version, or reported inputs are documented separately.</p><div class="scroll"><table><thead><tr><th>Measure</th><th>Reported baseline</th>${comparable.map((entry) => `<th>${h(entry.name)}</th>`).join("")}</tr></thead><tbody>${keys
          .map((key) => {
            const row = comparable
              .flatMap((entry) => entry.rows)
              .find((item) => item.comparisonKey === key);
            return `<tr><th>${h(row.label)} (${h(row.unit)})</th><td>${h(raw(row.baseline))}</td>${comparable.map((entry) => `<td>${h(raw(entry.rows.find((item) => item.comparisonKey === key)?.selection.point.value))}</td>`).join("")}</tr>`;
          })
          .join("")}</tbody></table></div></section>`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(model.title)}</title><style>body{font:14px/1.6 system-ui,sans-serif;max-width:1050px;margin:0 auto;padding:24px;color:#172736;background:white}h1,h2,h3{line-height:1.25}h1{font-size:25px}h2{font-size:20px;margin-top:28px}h3{font-size:16px}.notice{padding:12px;border:1px solid #bccbd5;background:#f1f6f8}section{border-top:1px solid #c5d0d8;margin-top:22px;padding-top:10px}.metadata{font-size:12px;color:#43576a}.notes{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}th,td{border-bottom:1px solid #ccd6dd;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}td{font-variant-numeric:tabular-nums}a{color:#065984}li{overflow-wrap:anywhere}.scroll{overflow-x:auto}@media print{body{padding:0;font-size:11px}tr,li{break-inside:avoid}section{break-inside:auto}.scroll{overflow:visible}}</style></head><body><h1>${h(model.title)}</h1><p class="metadata">Exported ${h(model.exportedAt)}. All currency values are full USD, without display scaling or rounding. Percentage-point changes are labeled pp.</p><p class="notice">${h(model.limits)}</p>${comparison}${model.cases.map((entry) => `<section><h2>${h(entry.name)} · Hypothetical case</h2><p class="metadata">${h(entry.context.name)} (${h(entry.context.ticker)}) · CIK ${h(entry.context.cik)} · ${h(entry.context.basis)} · ${h(entry.context.period.start || "Instant")} → ${h(entry.context.period.end)}<br>Filing cutoff: ${h(entry.context.asOf || "Latest available when captured")} · observed ${h(entry.context.observedAt || "Unavailable")} · financial data version ${h(entry.context.dataVersion || "Unavailable")}<br>Saved ${h(entry.createdAt)} · updated ${h(entry.updatedAt)}<br>Comparison status: ${h(entry.compatibility.status)}</p><h3>Analyst notes</h3><p class="notes">${h(entry.notes || "No analyst notes.")}</p><h3>Explicit assumptions</h3><table><thead><tr><th>Assumption</th><th>Value</th></tr></thead><tbody>${entry.assumptions.map((assumption) => `<tr><th>${h(assumption.label)}</th><td>${h(assumption.value)}</td></tr>`).join("")}</tbody></table>${entry.exercises.map((exercise) => `<h3>${h(exercise.label)}</h3>${exercise.reason ? `<p class="notice">Unavailable: ${h(exercise.reason)}</p>` : ""}${exercise.note ? `<p>${h(exercise.note)}</p>` : ""}${(exercise.diagnostics || []).map((diagnostic) => `<p>${h(diagnostic.status)}: ${h(diagnostic.message)}</p>`).join("")}`).join("")}<table><thead><tr><th>Hypothetical measure</th><th>Reported baseline</th><th>Result</th><th>Change</th><th>Unit</th></tr></thead><tbody>${entry.rows.map((row) => `<tr><th>${h(row.label)}</th><td>${h(raw(row.baseline))}</td><td>${h(raw(row.selection.point.value))}</td><td>${h(raw(row.delta))}${row.format === "percent" ? " pp" : ""}</td><td>${h(row.unit)}</td></tr>`).join("")}</tbody></table>${entry.rows.map((row) => `<h3>Hypothetical ${h(row.label)} · calculation and evidence</h3><p>${h(row.selection.point.formula || "Calculation unavailable")}</p><p>${h(row.selection.point.note || "")}</p>${row.selection.point.reason ? `<p>${h(row.selection.point.reason)}</p>` : ""}<ul>${(row.selection.point.sources || []).map((source) => sourceHtml(entry.context.cik, source)).join("")}</ul>`).join("")}${entry.exercises.map((exercise) => `<h3>${h(exercise.label)} · original reported inputs</h3>${exercise.inputs.map((input) => `<p><strong>${h(input.definition?.label || input.key)}</strong>: ${h(raw(input.point?.value))} USD · ${h(input.reason || input.point?.reason || input.basis || "")}</p><ul>${(input.point?.sources || []).map((source) => sourceHtml(entry.context.cik, source)).join("")}</ul>`).join("")}`).join("")}${additionalEvidenceHtml(entry)}</section>`).join("")}</body></html>`;
}

export function scenarioBriefCsv(model) {
  const header = [
    "Record",
    "Case",
    "Ticker",
    "CIK",
    "Basis",
    "Period start",
    "Period end",
    "Filing cutoff",
    "Observed at",
    "Financial data version",
    "Saved at",
    "Updated at",
    "Comparison status",
    "Exported at",
    "Measure",
    "Baseline",
    "Hypothetical result",
    "Change",
    "Unit",
    "Formula",
    "Notes or status",
    "Source tag",
    "Source value",
    "Source unit",
    "Source start",
    "Source end",
    "Source filed",
    "Source accession",
    "SEC URL",
  ];
  const rows = [header];
  for (const entry of model.cases) {
    const prefix = [
      entry.name,
      entry.context.ticker,
      entry.context.cik,
      entry.context.basis,
      entry.context.period.start || "",
      entry.context.period.end,
      entry.context.asOf || "Latest available when captured",
      entry.context.observedAt,
      entry.context.dataVersion,
      entry.createdAt,
      entry.updatedAt,
      entry.compatibility.status,
      model.exportedAt,
    ];
    const add = (type, fields = []) => rows.push([type, ...prefix, ...fields]);
    add("Hypothetical model limits", ["", "", "", "", "", "", model.limits]);
    add("Analyst notes", ["", "", "", "", "", "", entry.notes]);
    add("Goal target scope", [
      "",
      "",
      "",
      "",
      "",
      "",
      "Goal targets are separate planning inputs. Solving does not apply a target to the sensitivity case; assumptions change only when the analyst chooses to apply the result. Unconfigured targets use the reported baseline.",
    ]);
    for (const assumption of entry.assumptions)
      add("User assumption", [
        assumption.label,
        "",
        assumption.value,
        "",
        "",
        "",
        "Explicit user assumption",
      ]);
    for (const exercise of entry.exercises) {
      add("Exercise status", [
        exercise.label,
        "",
        "",
        "",
        "",
        "",
        [exercise.reason || "Available", exercise.note || ""]
          .filter(Boolean)
          .join(" · "),
      ]);
      for (const diagnostic of exercise.diagnostics || [])
        add("Model diagnostic", [
          diagnostic.key,
          "",
          "",
          "",
          "",
          "",
          `${diagnostic.status}: ${diagnostic.message}`,
        ]);
      for (const input of exercise.inputs) {
        for (const source of input.point?.sources?.length
          ? input.point.sources
          : [null])
          add("Reported baseline input", [
            input.definition?.label || input.key,
            input.point?.value ?? "",
            "",
            "",
            "USD",
            input.point?.formula || "",
            input.reason || input.point?.reason || input.basis || "",
            source?.tag || "",
            source?.value ?? "",
            source?.unit || "",
            source?.start || "",
            source?.end || "",
            source?.filed || "",
            source?.accession || "",
            source ? scenarioSourceUrl(entry.context.cik, source) : "",
          ]);
      }
    }
    for (const row of entry.rows) {
      for (const source of row.selection.point.sources?.length
        ? row.selection.point.sources
        : [null])
        add("Hypothetical result", [
          row.label,
          row.baseline ?? "",
          row.selection.point.value ?? "",
          row.delta ?? "",
          row.format === "percent" ? "% result; pp change" : row.unit,
          row.selection.point.formula || "",
          row.selection.point.note || row.selection.point.reason || "",
          source?.tag || "",
          source?.value ?? "",
          source?.unit || "",
          source?.start || "",
          source?.end || "",
          source?.filed || "",
          source?.accession || "",
          source ? scenarioSourceUrl(entry.context.cik, source) : "",
        ]);
    }
    const extra = additionalEvidence(entry);
    for (const row of extra.bridge)
      for (const source of row.selection.point.sources?.length
        ? row.selection.point.sources
        : [null])
        add("Hypothetical bridge contribution", [
          row.label,
          row.baseline ?? "",
          row.selection.point.value ?? "",
          "",
          unit(row.format),
          row.selection.point.formula || "",
          row.selection.point.note || "",
          source?.tag || "",
          source?.value ?? "",
          source?.unit || "",
          source?.start || "",
          source?.end || "",
          source?.filed || "",
          source?.accession || "",
          source ? scenarioSourceUrl(entry.context.cik, source) : "",
        ]);
    for (const { label, point } of extra.calculations)
      add("Intermediate source calculation", [
        label,
        "",
        point.value ?? "",
        "",
        point.unit || "USD",
        point.formula || "",
        "Source calculation preserved with the hypothetical result",
        "",
        "",
        "",
        point.start || "",
        point.end || "",
      ]);
    for (const goal of entry.goalSnapshots || []) {
      if (goal.reason)
        add("Goal result status", [
          goal.label,
          "",
          "",
          "",
          "",
          "",
          goal.reason,
        ]);
      for (const selection of goal.rows)
        for (const source of selection.point.sources?.length
          ? selection.point.sources
          : [null])
          add("Hypothetical goal-seek result", [
            selection.definition.label,
            "",
            selection.point.value ?? "",
            "",
            unit(selection.definition.format),
            selection.point.formula || "",
            selection.point.note || "",
            source?.tag || "",
            source?.value ?? "",
            source?.unit || "",
            source?.start || "",
            source?.end || "",
            source?.filed || "",
            source?.accession || "",
            source ? scenarioSourceUrl(entry.context.cik, source) : "",
          ]);
    }
  }
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        Array.from({ length: header.length }, (_, index) =>
          csvCell(row[index] ?? ""),
        ).join(","),
      )
      .join("\r\n")
  );
}
