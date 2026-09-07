import {
  disclosureBriefDefaults,
  disclosureTags,
  safeDisclosureSourceUrl,
} from "./disclosureCollections.js";

export function buildDisclosureBrief(collection, options = {}) {
  const settings = {
    ...disclosureBriefDefaults(collection),
    ...(options.settings || {}),
  };
  const selected =
    options.selectedIds === undefined ? null : new Set(options.selectedIds);
  const items = collection.items.filter(
    (item) => selected === null || selected.has(item.id),
  );
  const groups = [];
  for (const item of items) {
    const label =
      settings.groupBy === "company"
        ? `${item.ticker} · ${item.companyName || "Company"}`
        : settings.groupBy === "topic"
          ? disclosureTags(item.tags)[0] || item.section || "Untagged evidence"
          : "Collected evidence";
    let group = groups.find((g) => g.label === label);
    if (!group) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return {
    collectionId: collection.id || "",
    collectionName: collection.name,
    settings,
    items,
    groups,
    totalSaved: collection.items.length,
    companyCount: new Set(items.map((item) => item.cik || item.ticker)).size,
    filingCount: new Set(
      items.map((item) => `${item.cik || item.ticker}:${item.accession}`),
    ).size,
    exportedAt: options.exportedAt || new Date().toISOString(),
  };
}

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const safeCell = (value) => {
  const text = String(value ?? "");
  return `"${(/^[\s\u0000-\u001f]*[=+@-]/.test(text) ? "'" : "") + text.replace(/"/g, '""')}"`;
};

export function disclosureBriefCsv(brief) {
  const headers = [
    "collection",
    "evidence_id",
    "evidence_order",
    "selected_collection_order",
    "ticker",
    "company",
    "cik",
    "form",
    "filing_date",
    "reporting_period",
    "section",
    "accession",
    "source_url",
    "quotation",
    "prior_quotation",
    "comparison_accession",
    "change",
    "language_label",
    "label_reviewed",
    "notes",
    "tags",
    "observed_at",
    "search_settings",
    "brief_title",
    "research_question",
    "narrative",
    "conclusions",
    "group_by",
    "exported_at",
    "evidence_snapshot",
  ];
  return (
    "\uFEFF" +
    [
      headers,
      ...brief.groups
        .flatMap((group) => group.items)
        .map((item, i) => [
          brief.collectionName,
          item.id,
          i + 1,
          brief.items.findIndex((value) => value.id === item.id) + 1,
          item.ticker,
          item.companyName,
          item.cik,
          item.form,
          item.filingDate,
          item.reportDate,
          item.section,
          item.accession,
          item.documentUrl,
          item.quote,
          item.priorQuote,
          item.comparisonAccession,
          item.change,
          item.languageLabel,
          item.labelReviewed,
          item.notes,
          item.tags,
          item.observedAt,
          JSON.stringify(item.settings),
          brief.settings.title,
          brief.settings.researchQuestion,
          brief.settings.narrative,
          brief.settings.conclusions,
          brief.settings.groupBy,
          brief.exportedAt,
          JSON.stringify(item),
        ]),
    ]
      .map((row) => row.map(safeCell).join(","))
      .join("\r\n")
  );
}

export function disclosureBriefHtml(brief) {
  const e = escapeHtml;
  let ordinal = 0;
  const narrative = (label, text) =>
    text?.trim()
      ? `<section class="narrative"><h2>${label}</h2><p>${e(text)}</p></section>`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${e(brief.settings.title)}</title><style>body{font:15px/1.65 system-ui,sans-serif;color:#17212e;max-width:980px;margin:44px auto;padding:0 26px}h1{font-size:34px;line-height:1.2}h2{font-size:23px;margin-top:32px}h3{font-size:18px}blockquote{margin:18px 0;padding:16px 22px;border-left:4px solid #a67615;background:#faf8f0;white-space:pre-wrap}small,dt{color:#526074}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:12px;font-size:11px}a{color:#085d84;overflow-wrap:anywhere}article{border-top:1px solid #ccd4dc;margin-top:24px;padding-top:16px}p{white-space:pre-wrap}.meta{font-size:13px}.scope{background:#f0f4f8;padding:16px;border-radius:8px}details{margin:16px 0}summary{cursor:pointer}blockquote,p{orphans:3;widows:3}h2,h3{break-after:avoid}@media print{body{margin:0;max-width:none}details{display:block}details>*{display:block!important}a{color:#17212e}.scope{border:1px solid #ccd4dc}}</style></head><body><header><p>EDGAR Terminal · Disclosure research brief</p><h1>${e(brief.settings.title)}</h1><p class="meta">Collection: ${e(brief.collectionName)} · Prepared ${e(brief.exportedAt)}</p><div class="scope"><strong>${brief.items.length} selected passages · ${brief.filingCount} filings · ${brief.companyCount} companies</strong><p>${brief.totalSaved - brief.items.length} other saved passages omitted. This brief describes selected evidence, not complete company or document coverage. ${brief.settings.groupBy === "topic" ? "Topic groups use the first analyst tag, or the saved section when no tag exists. " : ""}Passages retain collection order within each group.</p><small>Quotations are saved filing text. Narrative, conclusions, notes and reviewed labels are analyst annotations. Automated language and change labels require source review; disclosure frequency is not a risk score.</small></div></header>${narrative("Research question", brief.settings.researchQuestion)}${narrative("Research narrative", brief.settings.narrative)}${narrative("Conclusions and open questions", brief.settings.conclusions)}${brief.groups
    .map(
      (group) =>
        `<section><h2>${e(group.label)}</h2>${group.items
          .map((item) => {
            ordinal += 1;
            const url = safeDisclosureSourceUrl(item.documentUrl);
            return `<article><h3>${ordinal}. ${e(item.ticker)} — ${e(item.section)}</h3><p class="meta">${e(item.companyName)} · ${e(item.form)} · Filed ${e(item.filingDate)} · Reporting period ${e(item.reportDate || "not provided")}<br>Accession ${e(item.accession)} · CIK ${e(item.cik)}<br>Saved observation ${e(item.observedAt || "not provided")}</p>${item.change === "removed" ? "<p><strong>Archived prior-report passage</strong> — this quotation belongs to the source filing identified below.</p>" : ""}<blockquote>${e(item.quote)}</blockquote>${item.priorQuote && item.priorQuote !== item.quote ? `<h4>Archived comparison wording</h4><blockquote>${e(item.priorQuote)}</blockquote>` : ""}<p class="meta">Change: ${e(item.change || "not supplied")} · Language: ${e(item.languageLabel || "not classified")} (${item.labelReviewed ? "analyst reviewed label" : "automated, unreviewed label"})<br>Comparison accession: ${e(item.comparisonAccession || "not supplied")}</p><p><strong>Analyst notes:</strong> ${e(item.notes || "None")}<br><strong>Tags:</strong> ${e(item.tags || "None")}</p>${url ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">Original SEC source: ${e(url)}</a>` : "<p>SEC source link unavailable. Use the accession above to locate the original filing.</p>"}<h4>Search settings at collection</h4><pre>${e(JSON.stringify(item.settings || {}, null, 2))}</pre><details><summary>Complete saved evidence snapshot</summary><pre>${e(JSON.stringify(item, null, 2))}</pre></details></article>`;
          })
          .join("")}</section>`,
    )
    .join(
      "",
    )}${!brief.items.length ? "<p>No passages selected for this brief.</p>" : ""}</body></html>`;
}
