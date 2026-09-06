export const ANALYSIS_SETTINGS = {
  basis: "annual",
  end: "latest",
  asOf: "",
  view: "statements",
  statement: "income",
  display: "reported",
  units: "millions",
  baseline: "year",
  search: "",
  pins: [],
  chart: [],
  indexed: false,
  years: 8,
};
const choices = {
  basis: ["annual", "quarter", "ytd", "ttm"],
  view: [
    "statements",
    "changes",
    "trends",
    "cash",
    "checks",
    "drivers",
    "notebook",
    "extended",
  ],
  statement: ["income", "balance", "cashflow", "ratios"],
  display: ["reported", "common"],
  units: ["millions", "billions", "raw", "auto"],
};
const validDate = (v) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v || "") &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
export function normalizeAnalysisSettings(input = {}) {
  const out = { ...ANALYSIS_SETTINGS, ...input };
  for (const [key, values] of Object.entries(choices))
    if (!values.includes(out[key])) out[key] = ANALYSIS_SETTINGS[key];
  out.asOf =
    validDate(out.asOf) && out.asOf <= new Date().toISOString().slice(0, 10)
      ? out.asOf
      : "";
  out.end = validDate(out.end) ? out.end : "latest";
  out.baseline =
    ["year", "previous"].includes(out.baseline) || validDate(out.baseline)
      ? out.baseline
      : "year";
  for (const key of ["pins", "chart"])
    out[key] = [
      ...new Set(
        (Array.isArray(out[key]) ? out[key] : []).filter((v) =>
          /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(v),
        ),
      ),
    ].slice(0, key === "chart" ? 3 : 12);
  out.search = String(out.search || "").slice(0, 80);
  out.indexed = out.indexed === true || out.indexed === "true";
  out.years = [4, 8, 12].includes(Number(out.years)) ? Number(out.years) : 8;
  return out;
}
export function readAnalysisSettings(search) {
  const params = new URLSearchParams(search);
  const input = Object.fromEntries(params);
  for (const key of ["pins", "chart"])
    input[key] = (params.get(key) || "").split(",").filter(Boolean);
  // Older deep links retain access to their original panels.
  if (
    [
      "snapshot",
      "quality",
      "market",
      "ownership",
      "filings-risk",
      "financials",
    ].includes(input.view)
  )
    input.view = input.view === "financials" ? "statements" : "extended";
  return normalizeAnalysisSettings(input);
}
export function analysisPath(ticker, settings) {
  const normalized = normalizeAnalysisSettings(settings);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(normalized)) {
    if (JSON.stringify(value) !== JSON.stringify(ANALYSIS_SETTINGS[key]))
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return `/analysis/${encodeURIComponent(ticker)}${params.size ? `?${params}` : ""}`;
}
export function analysisValue(value, format = "currency", units = "auto") {
  if (!Number.isFinite(value)) return "—";
  const decimals =
    format === "eps" || format === "percent" || format === "decimal"
      ? 2
      : units === "raw"
        ? 0
        : 2;
  if (format === "percent")
    return `${value.toLocaleString("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}%`;
  if (format === "decimal")
    return `${value.toFixed(Math.abs(value) < 0.1 && value !== 0 ? 4 : 2)}×`;
  if (format === "eps") return `$${value.toFixed(2)}`;
  const scale =
    units === "millions"
      ? 1e6
      : units === "billions"
        ? 1e9
        : units === "raw"
          ? 1
          : Math.abs(value) >= 1e9
            ? 1e9
            : Math.abs(value) >= 1e6
              ? 1e6
              : Math.abs(value) >= 1e3
                ? 1e3
                : 1;
  const suffix =
    scale === 1e9 ? "B" : scale === 1e6 ? "M" : scale === 1e3 ? "K" : "";
  return `${format === "shares" ? "" : "$"}${(value / scale).toLocaleString("en-US", { maximumFractionDigits: decimals })}${suffix}${format === "shares" ? " shares" : ""}`;
}
const csvCell = (v) => {
  const text =
    typeof v === "number"
      ? String(v)
      : String(v ?? "").replace(/^[=+@-]/, "'$&");
  return `"${text.replaceAll('"', '""')}"`;
};
export function exportAnalysisCsv(data, settings) {
  const header = [
    "Ticker",
    "CIK",
    "Metric",
    "Value",
    "Unit",
    "Basis",
    "Period start",
    "Period end",
    "Filing cutoff",
    "Classification",
    "Formula",
    "Missing reason",
    "Source tag",
    "Source value",
    "Source unit",
    "Source start",
    "Source end",
    "Filed",
    "Accession",
    "SEC URL",
  ];
  const rows = data.definitions.flatMap((d) =>
    data.metrics[d.key].flatMap((point) =>
      (point.sources?.length ? point.sources : [null]).map((s) => [
        data.ticker,
        data.cik,
        d.label,
        point.value,
        d.format === "currency" ? "USD" : d.format,
        data.basis,
        point.sources?.length && point.sources.every((s) => !s.start)
          ? null
          : point.period?.start,
        point.period?.end,
        settings.asOf || "Latest available",
        point.classification,
        point.formula,
        point.reason,
        s?.tag,
        s?.value,
        s?.unit,
        s?.start,
        s?.end,
        s?.filed,
        s?.accession,
        s?.documentUrl,
      ]),
    ),
  );
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}
const html = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export function exportAnalysisBrief(
  data,
  settings,
  index,
  notes,
  evidence = [],
) {
  const pointText = (point, format) =>
    `<strong>${html(analysisValue(point?.value, format))}</strong><p>${html(point?.sources?.length && point.sources.every((s) => !s.start) ? "Instant" : point?.period?.start || "Start unavailable")} → ${html(point?.period?.end)} · ${html(point?.classification)}. ${html(point?.formula || point?.reason || "")}</p><ul>${(point?.sources || []).map((s) => `<li>${html(s.tag)}: ${html(s.value)} ${html(s.unit)}; ${html(s.start || "Instant")} → ${html(s.end)}; filed ${html(s.filed)}; accession ${html(s.accession)}. <a href="${html(/^https:\/\/www.sec.gov\//.test(s.documentUrl || "") ? s.documentUrl : "")}">SEC source</a></li>`).join("")}</ul>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${html(data.ticker)} financial research brief</title><style>body{font:16px/1.6 system-ui;max-width:950px;margin:40px auto;padding:24px;color:#192a3b}h1,h2{line-height:1.2}section{border-top:1px solid #ccc;padding:18px 0}li{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit}a{color:#075cab}@media print{section{break-inside:avoid}}</style><h1>${html(data.name)} (${html(data.ticker)})</h1><p>SEC CIK ${html(data.cik)} · ${html(data.basis)} · period ending ${html(data.periods[index]?.end)}<br>Filing cutoff: ${html(settings.asOf || "Latest available")} · data observed ${html(data.observedAt)}</p><p>${html(data.note)}</p><h2>Research notes</h2><pre>${html(notes)}</pre><h2>Selected-period financials</h2>${data.definitions
    .filter((d) =>
      ["income", "balance", "cashflow", "ratios"].includes(d.category),
    )
    .map(
      (d) =>
        `<section><h3>${html(d.label)}</h3>${pointText(data.metrics[d.key]?.[index], d.format)}</section>`,
    )
    .join(
      "",
    )}<h2>Collected evidence</h2>${evidence.map((e) => `<section><h3>${html(e.label)}</h3><pre>${html(e.notes || e.text || "")}</pre>${pointText(e.point, e.format)}</section>`).join("")}<h2>Reproduce this view</h2><p><a href="https://secedgarterminal.com${html(analysisPath(data.ticker, settings))}">Open saved financial settings</a>. Notes and evidence remain private to this browser unless exported.</p></html>`;
}
