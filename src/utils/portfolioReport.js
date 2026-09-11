import { resolveCompanyClassification } from "./companyClassification.js";
import { buildPortfolioAnalytics } from "./portfolioAnalytics.js";
import { canonicalPortfolioCik } from "./portfolioModel.js";
import {
  portfolioConnections,
  portfolioMetricScopeValid,
  rankPortfolioMetric,
  metricDisplay,
  metricUnit,
} from "./portfolioDeepResearch.js";
import {
  PORTFOLIO_METRIC_CATALOG,
  portfolioMetricDefinitionFor,
} from "./portfolioMetricCatalog.js";
import { analysisMetricGuide } from "./analysisMetricGuide.js";
import { mergePortfolioFilingRows } from "./portfolioSourceResearch.js";

const e = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
function sourceLink(url, label = "SEC source") {
  try {
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      !["www.sec.gov", "sec.gov", "data.sec.gov"].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.port
    )
      return e(label);
    return `<a href="${e(u.href)}" rel="noreferrer">${e(label)}</a>`;
  } catch {
    return e(label);
  }
}
const table = (headers, rows) =>
  `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${e(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const date = (point) =>
  point?.period
    ? `${point.period.kind || "Unknown basis"}: ${point.period.start || "instant / unknown start"} to ${point.period.end || "unknown end"}`
    : "Reporting period unavailable";

/** Exclude stale session research for removed issuers and unselected export rows. */
export function portfolioScopedSources(companies, extras = {}) {
  const ciks = new Set(companies.map((c) => canonicalPortfolioCik(c.cik)));
  const tickers = new Set(
    companies
      .flatMap((c) => [c.ticker, ...(c.tickers || [])])
      .filter(Boolean)
      .map((t) => t.toUpperCase().replaceAll(".", "-")),
  );
  const inScope = (c) => ciks.has(canonicalPortfolioCik(c));
  return {
    filingHistory: Object.fromEntries(
      Object.entries(extras.filingHistory || {}).filter(([cik]) =>
        inScope(cik),
      ),
    ),
    filingErrors: Object.fromEntries(
      Object.entries(extras.filingErrors || {}).filter(([cik]) => inScope(cik)),
    ),
    disclosures: {
      settings: extras.disclosures?.settings
        ? {
            ...extras.disclosures.settings,
            ciks: (extras.disclosures.settings.ciks || []).filter(inScope),
          }
        : null,
      companies: (extras.disclosures?.companies || []).filter((c) =>
        inScope(c.cik),
      ),
      quotes: (extras.disclosures?.quotes || []).filter((q) => inScope(q.cik)),
    },
    fundOwnership: (extras.fundOwnership || []).filter((result) =>
      tickers.has(
        String(
          result.target?.ticker || result.target?.query || result.ticker || "",
        )
          .toUpperCase()
          .replaceAll(".", "-"),
      ),
    ),
  };
}

export function enrichPortfolioReport(bundle, extras = {}) {
  const rows = bundle.positions.map((p) => ({
    ...p,
    duplicateChoice: p.duplicate_choice,
  }));
  const analytics = bundle.analytics?.concentration
    ? bundle.analytics
    : buildPortfolioAnalytics(
        rows,
        { basis: "none", normalize: false },
        bundle.companies,
        { capturedAt: bundle.research_captured_at },
      );
  return {
    ...bundle,
    deep_research: {
      version: "1.0.0",
      scope: bundle.export_options.selected_subset
        ? "selected_issuer_counts_only"
        : "saved_portfolio",
      connections: portfolioConnections(analytics, bundle.companies),
      metricSummaries: PORTFOLIO_METRIC_CATALOG.map((d) => {
        const r = rankPortfolioMetric(analytics, bundle.companies, {
          metricId: d.key,
        });
        return {
          metric: d.key,
          label: d.label,
          unit: metricUnit(d.format),
          available: r.available,
          population: r.population,
          median: r.median,
          p25: r.p25,
          p75: r.p75,
          reportingPeriods: r.periodCount,
          interpretation: r.interpretation,
        };
      }),
      ...portfolioScopedSources(bundle.companies, extras),
    },
  };
}

/** Standalone, printable report; every user string is escaped and links are SEC-only. */
export function portfolioReportHtml(input, extras = {}) {
  const b = input.deep_research ? input : enrichPortfolioReport(input, extras),
    d = b.deep_research;
  const histories = Object.values(d.filingHistory);
  const filings = mergePortfolioFilingRows(
    b.companies.flatMap((c) =>
      (c.filings || []).map((f) => ({ ...f, cik: c.cik, ticker: c.ticker })),
    ),
    histories.flatMap((h) => h.filings || []),
  );
  const scans = d.disclosures.companies;
  const settings = d.disclosures.settings;
  const pct = (n) =>
    typeof n === "number" ? `${n.toFixed(2)}%` : "Unavailable";
  const display = (n, unit) =>
    metricDisplay({ value: n, unit, classification: "calculated" }, false);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${e(b.name)} — Portfolio research</title><style>
  body{font:16px/1.6 system-ui,sans-serif;color:#172537;max-width:1200px;margin:48px auto;padding:0 28px}h1{font-size:38px;line-height:1.15}h2{margin-top:44px;font-size:25px;border-bottom:2px solid #c6a044;padding-bottom:10px}h3{font-size:20px}small,.muted{color:#566779}a{color:#185b84;overflow-wrap:anywhere}.brief{background:#f0f4f8;padding:22px;border-left:4px solid #c6a044;margin:20px 0}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{border-bottom:1px solid #d7dfe7;text-align:left;vertical-align:top;padding:10px}th{background:#eef2f6}details{margin:20px 0}summary{cursor:pointer;font-weight:650;padding:10px;background:#eef2f6}blockquote{margin:16px 0;padding:16px;border-left:3px solid #c6a044;white-space:pre-wrap}p,td{overflow-wrap:anywhere}.metric{border-bottom:1px solid #d7dfe7;padding:14px 0}.metric h4{margin:0}button{padding:10px 16px;font:inherit;cursor:pointer}nav a{display:inline-block;margin-right:16px}li{margin:6px 0}@media print{body{max-width:none;margin:0;padding:0;font-size:11pt}button,nav{display:none}.scroll{overflow:visible}table{font-size:9pt}h2,h3,h4{break-after:avoid}tr{break-inside:avoid}a{color:inherit}details>*{display:block!important}}
  </style></head><body><header><p>EDGAR Terminal · Portfolio research report</p><h1>${e(b.name)}</h1><p>Financial capture: ${e(b.research_captured_at || "Not captured")} · Exported: ${e(b.generated_at)} · ${e(b.reporting_basis)} basis</p><button onclick="document.querySelectorAll('details').forEach(d=>d.open=true);window.print()">Print / save as PDF</button><nav><a href="#briefing">Briefing</a><a href="#metrics">Metric comparisons</a><a href="#companies">Company evidence</a><a href="#filings">Filings</a><a href="#disclosures">Disclosures</a><a href="#funds">Fund ownership</a></nav></header>
  <section id="briefing"><h2>Research scope and findings</h2><div class="brief"><strong>${e(b.coverage.selected_companies_with_financial_evidence)} of ${e(b.coverage.selected_resolved_companies)} selected resolved holdings have financial evidence.</strong><p>${e(b.coverage.selected_positions)} input rows · ${e(b.coverage.selected_unresolved_positions)} unresolved · ${e(b.coverage.selected_excluded_positions)} excluded. Counts describe the selected company universe. Missing values are excluded, never replaced by zero.</p><p>${e(b.allocation.label || b.allocation.mode)}. ${b.export_options.selected_subset ? "This is a selected subset: original supplied weights are retained; count statistics are recalculated for these companies." : "Holding concentration combines share classes. Financial ratios are descriptive company distributions, not portfolio returns."}</p></div>
  ${d.connections.groups.map((g) => `<article><h3>${e(g.title)}</h3><p>${e(g.reading)}</p><p class="muted">Companies: ${e(g.ciks.map((cik) => b.companies.find((c) => canonicalPortfolioCik(c.cik) === cik)?.ticker || cik).join(", ") || "None in the measured group")}${g.paired !== undefined ? ` · paired observations ${e(g.paired)}; median explained ROE ${e(display(g.medianRoe, "%"))}; median equity multiplier ${e(display(g.medianLeverage, "x"))}` : ""}</p></article>`).join("")}
  ${
    b.analytics?.concentration
      ? `<h3>Holding concentration</h3>${table(
          ["Holding", "SEC industry", "Supplied weight"],
          b.analytics.concentration.issuers.map((i) => [
            e(i.tickers.join(" / ")),
            e(i.industry),
            e(pct(i.weightPct)),
          ]),
        )}`
      : ""
  }
  <details><summary>Input rows and allocation context</summary>${table(
    [
      "Company",
      "CIK",
      "Resolution",
      "Supplied analysis weight",
      "Notes included by choice",
    ],
    b.positions.map((p) => [
      e(p.resolution.ticker || p.input.ticker || p.input.company_name),
      e(p.resolution.cik),
      e(p.excluded ? "Excluded" : p.resolution.status),
      e(
        b.export_options.include_allocations
          ? pct(p.analysis_weight_pct)
          : "Excluded from export",
      ),
      e(
        b.export_options.include_notes
          ? p.input.notes || ""
          : "Excluded from export",
      ),
    ]),
  )}</details></section>
  <section id="metrics"><h2>How the companies compare</h2><p>Each row has its own measured denominator. The median and middle 50% describe company values without allocation weights. Higher values do not necessarily mean better outcomes. Business models and reporting periods can differ; use the site’s business-model and period filters for narrower comparisons.</p>${table(
    [
      "Measure",
      "Measured companies",
      "Median",
      "Middle 50%",
      "Full periods represented",
    ],
    d.metricSummaries
      .filter((m) => m.available)
      .map((m) => [
        e(m.label),
        `${e(m.available)} / ${e(m.population)}`,
        e(display(m.median, m.unit)),
        e(`${display(m.p25, m.unit)} to ${display(m.p75, m.unit)}`),
        e(m.reportingPeriods),
      ]),
  )}</section>
  <section id="companies"><h2>Company metrics and SEC evidence</h2><p>Available captured financial measures are included below. Each value retains its formula or reported concept, unit, full period, and source. Open a company to inspect the detailed evidence. Print / save PDF expands every company.</p>${b.companies
    .map(
      (c) =>
        `<details><summary>${e(c.ticker || c.cik)} · ${e(c.name)} · ${e(c.lens)} · ${e(c.status)}</summary><p>CIK ${e(c.cik)} · ${e(resolveCompanyClassification(c).industry)}${resolveCompanyClassification(c).sectorSource ? ` · ${e(resolveCompanyClassification(c).sector)} (iShares ${e(resolveCompanyClassification(c).sectorSource.fund)}, sector reference ${e(resolveCompanyClassification(c).sectorSource.asOf)})` : ""} · Retrieved ${e(c.retrievedAt || c.retrieved_at || "unknown")}</p>${Object.entries(
          c.metrics || {},
        )
          .filter(
            ([key, p]) =>
              portfolioMetricScopeValid(key, p) &&
              Number.isFinite(p.value) &&
              ["reported", "calculated"].includes(p.classification),
          )
          .map(([key, p]) => {
            const def = portfolioMetricDefinitionFor(key) || {
              key,
              label: p.label || key,
              format: p.format,
            };
            const guide = analysisMetricGuide(def, p, c.lens);
            return `<article class="metric"><h4>${e(def.label)}: ${e(metricDisplay(p, false))}</h4><small>${e(date(p))} · ${e(p.classification)}</small><p>${e(guide.meaning)} ${e(guide.caution)}</p><p>${e(p.formula || p.definitionFormula || p.reason || "Reported value; inspect the SEC concept below.")}</p>${(p.calculations || []).length ? `<p>Calculation steps: ${e(p.calculations.map((x) => `${x.label || ""}: ${x.formula || ""}`).join("; "))}</p>` : ""}<ul>${(p.sources || []).map((source) => `<li>${sourceLink(source.documentUrl || source.sourceUrl, `${source.tag || source.label || "SEC evidence"} · ${source.accession || ""}`)} · ${e(source.start || "Instant")} to ${e(source.end)} · filed ${e(source.filed)} · ${e(source.value)} ${e(source.unit)}</li>`).join("")}</ul></article>`;
          })
          .join("")}</details>`,
    )
    .join("")}</section>
  <section id="filings"><h2>Portfolio filing library</h2><p>${filings.length} captured references. Full recent submissions were loaded for ${histories.length} companies; ${histories.reduce((n, h) => n + (h.loadedArchives?.length || 0), 0)} historical archives loaded. The initial financial capture includes at most 30 relevant filings per company. Unloaded histories and archives are not represented.</p>${Object.entries(
    d.filingErrors,
  )
    .filter(([, v]) => v)
    .map(([cik, error]) => `<p>${e(cik)}: ${e(error)}</p>`)
    .join("")}<details><summary>Filing references and sources</summary>${table(
    ["Company", "Form", "Filed", "Report end", "Source"],
    filings.map((f) => [
      e(f.ticker || f.cik),
      e(f.form),
      e(f.filingDate || f.filed),
      e(f.reportDate),
      sourceLink(f.documentUrl || f.indexUrl, f.accession),
    ]),
  )}</details></section>
  <section id="disclosures"><h2>Portfolio disclosure research</h2>${
    settings
      ? `<div class="brief"><strong>Query: ${e(settings.query)}</strong><p>Filed ${e(settings.start)} through ${e(settings.end)} · Forms ${e(settings.forms)} · Section ${e(settings.section)} · ${e(settings.depth)} filings per company batch.</p><p>${scans.length} company scans recorded. No match in reviewed filings does not establish that a topic is absent.</p></div>${table(
          [
            "Company",
            "Reviewed",
            "Matched",
            "Failed",
            "Unavailable section",
            "Remaining",
            "Checked",
          ],
          scans.map((c) => [
            e(c.ticker || c.cik),
            e(c.reviewed || 0),
            e(c.matched || 0),
            e(c.error || c.fetchFailed || 0),
            e(c.sectionUnavailable || 0),
            e(c.remaining ?? "unknown"),
            e(c.checkedAt || c.observedAt),
          ]),
        )}${scans.flatMap((c) => (c.filings || []).filter((f) => f.matched).map((f) => `<article><h3>${e(c.ticker)} · ${e(f.form)} · ${e(f.filingDate)}</h3>${(f.previews || []).map((p) => `<blockquote>${e(p.text)}</blockquote>`).join("")}<p>${sourceLink(f.documentUrl, f.accession)} · ${e(f.matchCount)} matches. These are previews; review the original document.</p></article>`)).join("")}${d.disclosures.quotes.length ? `<h3>Collected passages</h3>${d.disclosures.quotes.map((q) => `<article><h4>${e(q.ticker)} · ${e(q.form)} · ${e(q.filingDate)}</h4><blockquote>${e(q.quote)}</blockquote><p>${sourceLink(q.documentUrl, q.accession)} · ${e(q.section)}</p></article>`).join("")}` : ""}`
      : "<p>No portfolio disclosure search was captured in this session. Use the Disclosure search tab, then download the report again.</p>"
  }</section>
  <section id="funds"><h2>Funds reporting holdings in portfolio companies</h2><p>These are public fund holdings discovered for selected companies, not your portfolio’s fund allocation or a complete ownership census. Percentages use each reporting fund’s net assets. Share classes of the same fund portfolio are consolidated; reports can have different dates.</p>${
    d.fundOwnership.length
      ? d.fundOwnership
          .map(
            (r) =>
              `<article><h3>${e(r.target?.label || r.ticker)}</h3><p>${e(r.coverage?.scannedDocuments)} candidate filings scanned · ${e(r.coverage?.unavailableCount)} unavailable · as captured ${e(r.coverage?.snapshotAt)}. ${r.nextCursor ? "More candidates remain; this search is incomplete." : "Coverage is limited to the stated discovery window."}</p>${table(
                [
                  "Fund",
                  "Holding count",
                  "Known fund NAV weight",
                  "Missing weights",
                  "Holdings date",
                  "Filed",
                  "SEC source",
                ],
                (r.funds || []).map((f) => [
                  e(f.name),
                  e(f.positionCount),
                  e(pct(f.knownWeight)),
                  e(f.missingWeightCount),
                  e(f.asOf),
                  e(f.filingDate),
                  sourceLink(f.sourceUrl || f.filingUrl, f.accession),
                ]),
              )}</article>`,
          )
          .join("")
      : "<p>No fund ownership searches were captured. Select a company in Fund ownership, then export again.</p>"
  }</section>
  <section><h2>Coverage and methodology</h2><ul>${[...b.warnings, ...b.methodology].map((line) => `<li>${e(line)}</li>`).join("")}</ul><p>Additional source searches are session research. This standalone report does not refresh itself. Values and passages are evidence for analysis, not recommendations.</p></section></body></html>`;
}
