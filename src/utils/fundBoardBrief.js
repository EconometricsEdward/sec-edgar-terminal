import { validateFundBoard, validFundSourceUrl } from "./fundBoards.js";
import { fundWorkspacePath } from "./fundWorkspaceSettings.js";

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const valueText = (value) => (value === null ? "Unavailable" : String(value));
export function buildFundBoardBrief(
  board,
  exportedAt = new Date().toISOString(),
) {
  validateFundBoard(board);
  return JSON.parse(JSON.stringify({ version: 1, exportedAt, board }));
}
const sourceLink = (source) =>
  validFundSourceUrl(source.sourceUrl)
    ? `<a href="${escape(source.sourceUrl)}" target="_blank" rel="noreferrer">${escape(source.ticker)} · ${escape(source.accession)}</a>`
    : "Source unavailable";
export function fundBoardBriefHtml(brief) {
  const { board } = brief;
  validateFundBoard(board);
  const sources = board.evidence.flatMap((entry) => entry.sources);
  const settings = Object.entries(board.settings)
    .filter(([key]) => key !== "board")
    .map(
      ([key, value]) =>
        `<tr><th>${escape(key)}</th><td>${escape(typeof value === "object" ? JSON.stringify(value) : value)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(board.name)} — Fund research brief</title><style>body{margin:0;background:#f4f5f7;color:#172033;font:15px/1.6 system-ui,sans-serif}main{max-width:1050px;margin:32px auto;padding:40px;background:white}h1{font-size:32px;line-height:1.2}h2{margin-top:32px}h3{margin-bottom:8px}p{margin:8px 0}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#59677a}.meta,.method{color:#536176;font-size:13px}.notice{border-left:4px solid #c58b19;padding:12px;background:#fff9e9}.notes{white-space:pre-wrap;background:#f4f6f9;padding:16px}table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #dce2ea;padding:9px;overflow-wrap:anywhere}th{font-weight:650}a{color:#175ca0}.evidence{border:1px solid #dce2ea;padding:18px;margin:18px 0;break-inside:avoid}code{white-space:pre-wrap;overflow-wrap:anywhere}details{margin:20px 0}summary{cursor:pointer;font-weight:650}@media print{body,main{margin:0;background:white}main{padding:0}a{color:inherit}details>*{display:block}thead{display:table-header-group}.evidence{break-inside:auto}}</style></head><body><main><p class="eyebrow">EDGAR Terminal · SEC portfolio research</p><h1>${escape(board.name)}</h1><p class="meta">Captured ${escape(board.capturedAt)} · Exported ${escape(brief.exportedAt)} · Board revision ${board.revision}</p><p>Funds: ${escape(board.settings.tickers.join(", ") || "No funds selected")}</p><p class="notice">Historical N-PORT evidence, not live holdings or a return forecast. Reported weights use each fund’s net assets. Derivative fair values do not measure notional exposure, and underlying holdings of other funds are not looked through. Captured evidence retains its own source dates even when those differ from the board’s selected reports.</p><h2>Research notes</h2><div class="notes">${escape(board.notes || "No research notes recorded.")}</div><h2>Captured portfolio reports</h2><p>${board.snapshots.length} of ${board.settings.tickers.length} selected funds have a verified snapshot matching the saved report selection.</p>${board.missingSnapshots.length ? `<p class="notice">No matching snapshot captured: ${escape(board.missingSnapshots.join(", "))}. These funds are not treated as reviewed or as having zero exposure.</p>` : ""}<table><thead><tr><th>Fund / series</th><th>Portfolio date / filed</th><th>Net assets (USD)</th><th>Positions</th><th>SEC evidence</th></tr></thead><tbody>${board.snapshots.map((snapshot) => `<tr><th>${escape(snapshot.ticker)}<br>${escape(snapshot.name)}<br>${escape(snapshot.seriesId || "Series unavailable")}</th><td>${escape(snapshot.asOf)}<br>${escape(snapshot.filingDate)}</td><td>${escape(valueText(snapshot.fundInfo.netAssets))}</td><td>${escape(valueText(snapshot.summary.count))}</td><td>${sourceLink(snapshot)}</td></tr>`).join("")}</tbody></table><h2>Pinned evidence (${board.evidence.length})</h2>${board.evidence.length ? board.evidence.map((entry, i) => `<section class="evidence"><p class="eyebrow">${i + 1} · ${escape(entry.kind)}</p><h3>${escape(entry.title)}</h3><p>${escape(entry.summary)}</p><table><thead><tr><th>Recorded measure</th><th>Value</th><th>Unit</th></tr></thead><tbody>${entry.values.map((value) => `<tr><th>${escape(value.label)}</th><td>${escape(valueText(value.value))}</td><td>${escape(value.unit)}</td></tr>`).join("")}</tbody></table>${entry.methodology ? `<p class="method">Method: ${escape(entry.methodology)}</p>` : ""}<ul>${entry.sources.map((source) => `<li>${sourceLink(source)} · Portfolio ${escape(source.asOf)} · Filed ${escape(source.filingDate)}</li>`).join("")}</ul></section>`).join("") : "<p>No evidence was pinned. The research settings and portfolio snapshots are preserved below.</p>"}<details open><summary>Complete saved research settings</summary><p class="method">minAssets is USD billions; maxConcentration is percent of NAV; maxAge is days; allocations are user-entered percentages. Blank or incomplete allocation entries remain drafts, not modeled zero allocations.</p><table><tbody>${settings}</tbody></table></details><p><a href="https://secedgarterminal.com${escape(fundWorkspacePath({ ...board.settings, board: "" }))}" target="_blank" rel="noreferrer">Reopen public research settings</a></p><p class="meta">This export preserves ${board.evidence.length} evidence items and ${sources.length} evidence source references. Your private notes are included only in this exported brief and the saved browser board; they are never included in the research URL.</p></main></body></html>`;
}
export function fundBoardBriefCsv(brief) {
  const { board } = brief;
  validateFundBoard(board);
  const headers = [
    "Record type",
    "Board",
    "Captured at",
    "Exported at",
    "Evidence ID",
    "Title or setting",
    "Measure",
    "Value",
    "Unit",
    "Availability",
    "Fund",
    "Portfolio date",
    "Filed date",
    "Accession",
    "SEC source",
    "Context or methodology",
  ];
  const prefix = [board.name, board.capturedAt, brief.exportedAt];
  const rows = [
    [
      "notes",
      ...prefix,
      "",
      "Research notes",
      "",
      board.notes,
      "",
      "recorded",
      "",
      "",
      "",
      "",
      "",
      "Private analyst notes",
    ],
  ];
  for (const [key, value] of Object.entries(board.settings))
    rows.push([
      "setting",
      ...prefix,
      "",
      key,
      "",
      typeof value === "object" ? JSON.stringify(value) : value,
      "",
      "recorded",
      "",
      "",
      "",
      "",
      "",
      key === "minAssets"
        ? "USD billions"
        : key === "maxConcentration"
          ? "Percent of NAV"
          : key === "maxAge"
            ? "Days"
            : "",
    ]);
  for (const ticker of board.missingSnapshots)
    rows.push([
      "coverage",
      ...prefix,
      "",
      "No matching snapshot captured",
      "",
      "",
      "",
      "unavailable",
      ticker,
      "",
      "",
      "",
      "",
      "Not reviewed; not zero exposure",
    ]);
  for (const snapshot of board.snapshots) {
    for (const [measure, value] of Object.entries(snapshot.fundInfo))
      rows.push([
        "snapshot",
        ...prefix,
        "",
        snapshot.name,
        measure,
        value,
        "USD",
        value === null ? "unavailable" : "recorded",
        snapshot.ticker,
        snapshot.asOf,
        snapshot.filingDate,
        snapshot.accession,
        snapshot.sourceUrl,
        `Series ${snapshot.seriesId || "unavailable"}; portfolio totals may include multiple share classes`,
      ]);
    for (const [measure, value] of Object.entries(snapshot.summary))
      rows.push([
        "snapshot",
        ...prefix,
        "",
        snapshot.name,
        measure,
        value,
        ["weightTotal", "top10Weight"].includes(measure)
          ? "% NAV"
          : measure === "value"
            ? "USD"
            : "positions",
        value === null ? "unavailable" : "recorded",
        snapshot.ticker,
        snapshot.asOf,
        snapshot.filingDate,
        snapshot.accession,
        snapshot.sourceUrl,
        "Complete reported portfolio summary",
      ]);
  }
  for (const entry of board.evidence) {
    rows.push([
      "evidence",
      ...prefix,
      entry.id,
      entry.title,
      "Summary",
      entry.summary,
      "",
      "recorded",
      "",
      "",
      "",
      "",
      "",
      entry.methodology,
    ]);
    for (const value of entry.values)
      rows.push([
        "evidence value",
        ...prefix,
        entry.id,
        entry.title,
        value.label,
        value.value,
        value.unit,
        value.value === null ? "unavailable" : "recorded",
        "",
        "",
        "",
        "",
        "",
        entry.methodology,
      ]);
    for (const source of entry.sources)
      rows.push([
        "evidence source",
        ...prefix,
        entry.id,
        entry.title,
        "",
        "",
        "",
        "recorded",
        source.ticker,
        source.asOf,
        source.filingDate,
        source.accession,
        source.sourceUrl,
        source.name,
      ]);
  }
  const cell = (value) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (typeof value === "string" && /^\s*[=+\-@]/.test(text))
      text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")
  );
}
