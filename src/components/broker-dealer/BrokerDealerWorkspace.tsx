"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowDownRight, ArrowUpRight, BarChart3, Check, ChevronDown, FileText, Layers3, LoaderCircle, SlidersHorizontal, TrendingUp, X } from "lucide-react";
import { BalanceBars, displayAmount, TrendChart, type ChartSeries } from "./BrokerDealerCharts";
import { brokerComparisonFit, brokerReportIdentity, brokerReportPeriodKey } from "../../utils/brokerDealerContext.js";
import styles from "./BrokerDealerWorkspace.module.css";

const BrokerDealerContext = dynamic(() => import("./BrokerDealerContext"), { loading: () => <p role="status">Opening peer and CFTC research…</p> });

type Source = { url?: string; page?: number; text?: string };
type Measure = { id: string; label: string; value: number | null; unit?: string; format?: string; periodEnd?: string; periodStart?: string; periodType?: string; durationMonths?: number; source?: Source; sources?: Source[]; formula?: string; confidence?: string; basis?: string; statement?: string; section?: string };
type Filing = { accession?: string; accessionNumber?: string; reportDate?: string; filingDate?: string; form?: string; archive?: string; archiveFile?: string; researchHref?: string; analysisHref?: string; periodKey?: string; classification?: any };
type Research = { company?: { name?: string; cik?: string } | null; name?: string; filing?: Filing; classification?: any; analysis?: any; brokerDealerAnalysis?: any; selectedDocument?: { url?: string; name?: string }; documents?: Array<{ name: string; url: string; description?: string }>; extraction?: any; observedAt?: string };
type ReportState = Record<string, Research>;
type Section = "overview" | "statements" | "trends" | "ratios" | "context";
type Statement = "financial-condition" | "income" | "cash-flows" | "net-capital" | "notes";
const COLORS = ["#69d6ed", "#f3c755", "#a69df2", "#78d4ab", "#f2a77c"];
const STATEMENTS: Array<{ id: Statement; label: string }> = [{ id: "financial-condition", label: "Balance sheet" }, { id: "income", label: "Income" }, { id: "cash-flows", label: "Cash flow" }, { id: "net-capital", label: "Regulatory capital" }, { id: "notes", label: "Supporting notes" }];
const INCOME_IDS = new Set(["netRevenue", "totalRevenue", "netIncome", "totalExpenses", "interestIncome", "interestExpense", "pretaxIncome"]);
const CASH_IDS = new Set(["operatingCashFlow", "investingCashFlow", "financingCashFlow", "changeInCash"]);
const CAPITAL_IDS = new Set(["netCapital", "minimumNetCapital", "excessNetCapital", "haircuts"]);
const accessionOf = (filing?: Filing) => filing?.accession || filing?.accessionNumber || "";
const analysisOf = (research?: Research) => research?.analysis || research?.brokerDealerAnalysis || {};
const metricsOf = (research?: Research): Measure[] => analysisOf(research).metrics || [];
const ratiosOf = (research?: Research): Measure[] => analysisOf(research).ratios || [];
const periodOf = (filing?: Filing) => filing?.reportDate || "Period not supplied";
const measuresOf = (research?: Research) => [...metricsOf(research), ...ratiosOf(research)];
const valueFormat = (metric?: Measure) => metric?.format || metric?.unit || "USD";
const statementOf = (metric: Measure): string => metric.statement || (INCOME_IDS.has(metric.id) ? "income" : CASH_IDS.has(metric.id) ? "cash-flows" : CAPITAL_IDS.has(metric.id) ? "net-capital" : "financial-condition");
function sourceHref(source?: Source) {
  if (!source?.url) return undefined;
  try { const url = new URL(source.url); if (url.protocol !== "https:" || !["sec.gov", "www.sec.gov", "archives.sec.gov"].includes(url.hostname)) return undefined; if (Number.isInteger(source.page) && source.page! > 0) url.hash = `page=${source.page}`; return url.href; } catch { return undefined; }
}
function ordered(filings: Filing[]) {
  return [...new Map(filings.filter(row => accessionOf(row)).map(row => [accessionOf(row), row])).values()].sort((a, b) => (b.reportDate || b.filingDate || "").localeCompare(a.reportDate || a.filingDate || "") || (b.filingDate || "").localeCompare(a.filingDate || "") || accessionOf(b).localeCompare(accessionOf(a)));
}
function latestPeriods(filings: Filing[], limit = 5) {
  const seen = new Set<string>();
  return ordered(filings).filter(row => { const key = brokerReportPeriodKey(row); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, limit);
}
function reportHref(cik: string, filing: Filing) {
  const query = new URLSearchParams({ cik, accession: accessionOf(filing) });
  if (filing.archive || filing.archiveFile) query.set("archive", filing.archive || filing.archiveFile!);
  if (filing.filingDate) query.set("filed", filing.filingDate);
  return `/api/broker-dealer/report?${query}`;
}
function pageHref(cik: string, filing: Filing, document?: string) {
  const query = new URLSearchParams({ accession: accessionOf(filing) });
  if (filing.archive || filing.archiveFile) query.set("archive", filing.archive || filing.archiveFile!);
  if (filing.filingDate) query.set("filed", filing.filingDate);
  if (document) query.set("document", document);
  return `/analysis/${cik}?${query}`;
}

function Evidence({ measure }: { measure: Measure }) {
  const sources = measure.sources?.length ? measure.sources : measure.source ? [measure.source] : [];
  return <details className={styles.evidence}><summary>{measure.basis === "calculated" ? "Calculation" : "Source"}{sources[0]?.page ? ` · p. ${sources[0].page}` : ""}</summary>{measure.formula && <p>{measure.formula}</p>}{sources.map((source, index) => <div key={`${source.page}:${index}`}>{sourceHref(source) && <a href={sourceHref(source)} target="_blank" rel="noreferrer">SEC document{source.page ? ` · page ${source.page}` : ""} ↗</a>}{source.text && <blockquote>{source.text}</blockquote>}</div>)}{measure.confidence === "medium" && <p>Check the extracted amount against the original page.</p>}</details>;
}

function ReportIdentity({ research }: { research: Research }) {
  const identity = brokerReportIdentity(research), classification = identity.classification;
  return <section className={styles.reportIdentity} aria-label="Report classification">
    <div className={styles.identityHeading}><div><span className={styles.overline}>Document identity</span><h2>{identity.label}</h2></div><span className={styles.auditBadge} data-status={identity.auditStatus}>{identity.auditLabel}</span></div>
    <div className={styles.identityFacts}><span><b>Form part</b>{identity.parts.length ? identity.parts.join(" · ") : "Not established"}</span><span><b>Reporting scope</b>{identity.frequency === "unknown" ? "Frequency not established" : `${identity.frequency[0].toUpperCase()}${identity.frequency.slice(1)}`}{identity.periodStart && identity.periodEnd ? ` · ${identity.periodStart} – ${identity.periodEnd}` : identity.periodEnd ? ` · Ending ${identity.periodEnd}` : ""}</span>{identity.auditScope && <span><b>Auditor report scope</b>{identity.auditScope}</span>}</div>
    {!!identity.components.length && <div className={styles.componentPills} aria-label="Identified report components">{identity.components.map(component => <span key={component.id}><Check size={11} aria-hidden="true" />{component.label}</span>)}</div>}
    <details className={styles.identityEvidence}><summary>How this report was identified</summary><p>The X-17A-5 form code alone does not establish the report type, audit status or reporting frequency. Classification follows the selected attachment; an auditor report may cover only financial condition.</p>{classification.evidence?.map((item: any, index: number) => <div key={`${item.kind}:${item.page}:${index}`}>{sourceHref(item) && <a href={sourceHref(item)} target="_blank" rel="noreferrer">Source{item.page ? ` · page ${item.page}` : ""} ↗</a>}{item.excerpt && <blockquote>{item.excerpt}</blockquote>}</div>)}{!!classification.limitations?.length && <ul>{classification.limitations.map((limit: string) => <li key={limit}>{limit}</li>)}</ul>}<p>Only publicly accessible filing material is analyzed. Confidential FOCUS submissions are not available here.</p></details>
  </section>;
}

function StatementTable({ reports, filings, statement, ratios = false, active, errors }: { reports: ReportState; filings: Filing[]; statement?: Statement; ratios?: boolean; active: string; errors: Record<string, string> }) {
  const rows = new Map<string, Measure>();
  const current = filings.find(row => accessionOf(row) === active);
  const columns = ordered(filings.map(row => reports[accessionOf(row)]?.filing || row));
  const prioritized = current ? [current, ...columns.filter(row => accessionOf(row) !== active)] : columns;
  for (const filing of prioritized) for (const metric of ratios ? ratiosOf(reports[accessionOf(filing)]) : metricsOf(reports[accessionOf(filing)])) if ((!statement || statementOf(metric) === statement) && !rows.has(metric.id)) rows.set(metric.id, metric);
  if (!rows.size) return <div className={styles.emptyStatement}><FileText size={25} aria-hidden="true" /><div><h3>No supported {ratios ? "ratios" : STATEMENTS.find(item => item.id === statement)?.label.toLowerCase() || "statement"} figures</h3><p>These figures have not been mapped from the selected public attachments. Some public reports omit income or cash-flow statements. Missing figures are not zero.</p></div></div>;
  return <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${ratios ? "Ratio" : "Financial statement"} comparison table. Scroll horizontally for additional periods.`}><table className={styles.statementTable}><caption>{ratios ? "Source-linked ratios across compatible reports" : "Financial statement figures in US dollars · compatible report types"}</caption><thead><tr><th scope="col">{ratios ? "Ratio" : "Reported measure"}</th>{columns.map(filing => <th key={accessionOf(filing)} scope="col" className={accessionOf(filing) === active ? styles.selectedColumn : undefined}>{periodOf(filing)}<small>{filing.form || "X-17A-5"}{accessionOf(filing) === active ? " · Selected" : ""}</small><small>{brokerReportIdentity(reports[accessionOf(filing)] || filing).label}{brokerReportIdentity(reports[accessionOf(filing)] || filing).parts.length ? ` · ${brokerReportIdentity(reports[accessionOf(filing)] || filing).parts.join(" / ")}` : ""}</small><small>Filed {filing.filingDate}</small></th>)}</tr></thead><tbody>{[...rows.values()].map(label => <tr key={label.id}><th scope="row">{label.label}{label.basis === "calculated" && <small>Calculated reconciliation</small>}</th>{columns.map(filing => {
    const key = accessionOf(filing), report = reports[key];
    const metric = (ratios ? ratiosOf(report) : metricsOf(report)).find(item => item.id === label.id);
    const activeMetric = (ratios ? ratiosOf(reports[active]) : metricsOf(reports[active])).find(item => item.id === label.id);
    const incompatibleDuration = key !== active && metric && (["income", "cash-flows"].includes(statementOf(metric)) || metric.periodType === "duration" || metric.durationMonths) && (!metric.durationMonths || metric.durationMonths !== activeMetric?.durationMonths);
    return <td key={key} className={key === active ? styles.selectedColumn : undefined}>{report ? incompatibleDuration ? <span className={styles.unavailable}>—<small>Different or unconfirmed duration</small></span> : metric ? <><strong>{displayAmount(metric.value, valueFormat(metric))}</strong>{["income", "cash-flows"].includes(statementOf(metric)) && <small>{metric.durationMonths ? `${metric.durationMonths} months` : "Duration not established"}{metric.periodStart ? ` · From ${metric.periodStart}` : ""}</small>}<Evidence measure={metric} /></> : <span className={styles.unavailable} title="No supported figure in this report">—<small>Not available</small></span> : <span className={styles.unavailable}>{errors[key] ? "Unavailable" : "Loading…"}</span>}</td>;
  })}</tr>)}</tbody></table></div>;
}

export default function BrokerDealerWorkspace({ cik, initialResearch, discovery, explicitSelection = false }: { cik: string; initialResearch?: Research | null; discovery: any; explicitSelection?: boolean }) {
  const initialFiling = initialResearch?.filing || discovery?.filing;
  const initialAccession = accessionOf(initialFiling);
  const initialCatalog = ordered([...(discovery?.filings || []), ...(initialFiling ? [initialFiling] : [])]);
  const initialSelection = latestPeriods(initialCatalog).map(accessionOf);
  if (explicitSelection && initialAccession && !initialSelection.includes(initialAccession)) initialSelection.splice(Math.max(0, initialSelection.length - 1), 1, initialAccession);
  const [catalog, setCatalog] = useState<Filing[]>(initialCatalog);
  const [selected, setSelected] = useState<string[]>(initialSelection);
  const [active, setActive] = useState(explicitSelection ? initialAccession || initialSelection[0] || "" : initialSelection[0] || initialAccession || "");
  const [reports, setReports] = useState<ReportState>(() => initialResearch && initialAccession ? { [initialAccession]: initialResearch } : {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [historyError, setHistoryError] = useState("");
  const [historyCoverage, setHistoryCoverage] = useState<any>(discovery?.coverage || {});
  const [archives, setArchives] = useState<any[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [section, setSection] = useState<Section>("overview");
  const [familyFilter, setFamilyFilter] = useState("all");
  const [statement, setStatement] = useState<Statement>("financial-condition");
  const [chartGroup, setChartGroup] = useState("balance");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState(selected);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const cache = useRef<ReportState>(initialResearch && initialAccession && !initialResearch.extraction?.retryable ? { [initialAccession]: initialResearch } : {});
  const attempted = useRef(new Set(initialResearch && initialAccession ? [initialAccession] : []));
  const catalogRef = useRef(catalog);
  const customized = useRef(false);
  const archiveController = useRef<AbortController | null>(null);
  const selectedKey = selected.join(",");

  useEffect(() => { catalogRef.current = catalog; }, [catalog]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/broker-dealer/history?${new URLSearchParams({ cik, limit: "5" })}`, { signal: controller.signal }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Filing history is temporarily unavailable."); return data; }).then(data => {
      if (controller.signal.aborted) return;
      const combined = ordered([...(data.filings || []), ...(initialFiling ? [initialFiling] : [])]);
      catalogRef.current = combined; setCatalog(combined); setHistoryCoverage(data.coverage || {}); setArchives(data.archives || []);
      if (!customized.current) { const defaults = (data.selectedFilings?.length ? data.selectedFilings : latestPeriods(combined)).map(accessionOf); if (explicitSelection && initialAccession && !defaults.includes(initialAccession)) defaults.splice(Math.max(0, defaults.length - 1), 1, initialAccession); setSelected(defaults); if (!explicitSelection && defaults[0]) setActive(defaults[0]); }
    }).catch(error => { if (!controller.signal.aborted) setHistoryError(error.message); });
    return () => { controller.abort(); archiveController.current?.abort(); };
    // The server selection is immutable for this keyed registrant workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cik]);

  useEffect(() => {
    const controller = new AbortController();
    const queue = selectedKey.split(",").filter(Boolean).filter(key => !cache.current[key] && !attempted.current.has(key));
    const inFlight = new Set<string>();
    let cursor = 0;
    async function worker() {
      while (!controller.signal.aborted && cursor < queue.length) {
        const key = queue[cursor++], filing = catalogRef.current.find(row => accessionOf(row) === key);
        if (!filing) continue;
        inFlight.add(key);
        setBusy(previous => ({ ...previous, [key]: true }));
        try {
          const response = await fetch(filing.researchHref || reportHref(cik, filing), { signal: controller.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "This report could not be analyzed. Try again or open the SEC filing.");
          if (controller.signal.aborted) return;
          if (accessionOf(result.filing) !== key) throw new Error("The returned filing did not match this selected period.");
          const expectedCik = cik.padStart(10, "0");
          const resultAnalysis = result.analysis || result.brokerDealerAnalysis;
          if (String(result.company?.cik || "").padStart(10, "0") !== expectedCik || String(resultAnalysis?.cik || "").padStart(10, "0") !== expectedCik || (resultAnalysis?.accession && resultAnalysis.accession !== key)) throw new Error("The returned financial analysis did not match this SEC registrant and report.");
          const report = { ...result, analysis: result.analysis || result.brokerDealerAnalysis };
          attempted.current.add(key);
          if (!report.extraction?.retryable) cache.current[key] = report;
          setReports(previous => ({ ...previous, [key]: report }));
          setErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
        } catch (error: any) { if (!controller.signal.aborted) { attempted.current.add(key); setErrors(previous => ({ ...previous, [key]: error.message || "This report is temporarily unavailable." })); } }
        finally { inFlight.delete(key); if (!controller.signal.aborted) setBusy(previous => ({ ...previous, [key]: false })); }
      }
    }
    void Promise.all([worker(), worker()]);
    return () => { controller.abort(); const cancelled = [...inFlight]; if (cancelled.length) setBusy(previous => { const next = { ...previous }; for (const key of cancelled) next[key] = false; return next; }); };
  }, [cik, selectedKey, retry]);

  const selectedFilings = useMemo(() => ordered(catalog.filter(row => selected.includes(accessionOf(row))).map(row => reports[accessionOf(row)] ? { ...(reports[accessionOf(row)].filing || row), classification: brokerReportIdentity(reports[accessionOf(row)]).classification } : row)), [catalog, reports, selected]);
  const current = reports[active];
  const filing = current?.filing || catalog.find(row => accessionOf(row) === active) || initialFiling;
  const analysis = analysisOf(current);
  const metricMap = Object.fromEntries(measuresOf(current).map(metric => [metric.id, metric])) as Record<string, Measure>;
  const loading = selected.filter(key => !reports[key] && !errors[key]).length;
  const loaded = selected.filter(key => !!reports[key]).length;
  const identity = brokerReportIdentity(current || filing);
  // Reading an unclassified selection can establish its family. Keep that report
  // visible when the former "unclassified" filter would otherwise hide it.
  const visibleFamily = familyFilter === "all" || identity.family === familyFilter ? familyFilter : "all";
  const visibleFilings = selectedFilings.filter(row => visibleFamily === "all" || brokerReportIdentity(reports[accessionOf(row)] || row).family === visibleFamily);
  const comparisonFilings = visibleFilings.filter(row => accessionOf(row) === active || reports[accessionOf(row)] && brokerComparisonFit(current, reports[accessionOf(row)]).compatible);
  const excludedComparisons = selectedFilings.length - comparisonFilings.length;
  const familyChoices = [{ id: "all", label: "All selected reports" }, { id: "annual-report", label: "Annual reports" }, { id: "periodic-focus", label: "Periodic FOCUS" }, { id: "unknown", label: "Unclassified / unread" }];
  // A selected original and amendment remain separate statement columns, but
  // only the latest selected version of each period enters chronological lines.
  const chronological = identity.family === "unknown" ? [] : latestPeriods(comparisonFilings.filter(row => row.reportDate), 10).reverse();
  const flowDurations = new Map<string, Set<number>>();
  for (const row of chronological) for (const metric of metricsOf(reports[accessionOf(row)])) if (["income", "cash-flows"].includes(statementOf(metric))) { const durations = flowDurations.get(metric.id) || new Set<number>(); durations.add(metric.durationMonths || 0); flowDurations.set(metric.id, durations); }
  const chartPeriods = chronological.map(row => ({ key: accessionOf(row), label: row.reportDate || `Filed ${row.filingDate || "unknown"}`, values: Object.fromEntries(measuresOf(reports[accessionOf(row)]).map(metric => { const durations = flowDurations.get(metric.id); return [metric.id, !row.reportDate || (durations && (durations.has(0) || durations.size > 1)) ? null : metric.value]; })) }));
  const suppressedFlows = [...flowDurations.values()].some(durations => durations.has(0) || durations.size > 1);
  const groups: Record<string, { title: string; description: string; series: ChartSeries[] }> = {
    balance: { title: "Balance sheet & secured financing", description: "Reported period-end balances. Gaps indicate unavailable figures.", series: [{ id: "totalAssets", label: "Total assets", color: COLORS[0] }, { id: "repos", label: "Repos", color: COLORS[1] }, { id: "reverseRepos", label: "Reverse repos", color: COLORS[2] }] },
    capital: { title: "Equity & regulatory capital", description: "Accounting equity and regulatory net capital have different definitions.", series: [{ id: "totalEquity", label: "Equity", color: COLORS[0] }, { id: "netCapital", label: "Net capital", color: COLORS[1] }, { id: "minimumNetCapital", label: "Required minimum", color: COLORS[2] }] },
    earnings: { title: "Operating performance", description: "Only explicitly disclosed income-statement amounts appear.", series: [{ id: "totalRevenue", label: "Total revenue", color: COLORS[0] }, { id: "netRevenue", label: "Net revenue", color: COLORS[1] }, { id: "netIncome", label: "Net income", color: COLORS[2] }] },
    cash: { title: "Cash generation", description: "Statement cash flows; balance-sheet changes are not substitutes.", series: [{ id: "operatingCashFlow", label: "Operating", color: COLORS[0] }, { id: "investingCashFlow", label: "Investing", color: COLORS[1] }, { id: "financingCashFlow", label: "Financing", color: COLORS[2] }] },
    leverage: { title: "Accounting leverage", description: "Assets divided by equity, before collateral or legal netting adjustments.", series: [{ id: "assetsToEquity", label: "Assets / equity", color: COLORS[0], format: "multiple" }] },
  };
  const activeGroup = groups[chartGroup];
  const currentPeriod = filing?.reportDate;
  const prior = chronological.filter(row => row.reportDate && currentPeriod && row.reportDate < currentPeriod && reports[accessionOf(row)]).at(-1);
  const previousMetrics = Object.fromEntries(measuresOf(prior ? reports[accessionOf(prior)] : undefined).map(metric => [metric.id, metric]));
  const assetItems = [{ id: "reverseRepos", label: "Reverse repos" }, { id: "securitiesOwned", label: "Securities owned" }, { id: "brokerReceivables", label: "Broker / clearing receivables" }, { id: "cashAndEquivalents", label: "Cash & equivalents" }].map((item, index) => ({ ...item, value: metricMap[item.id]?.value ?? undefined, color: COLORS[index], sourceHref: sourceHref(metricMap[item.id]?.source) }));
  const fundingItems = [{ id: "repos", label: "Repo financing" }, { id: "securitiesSoldShort", label: "Securities sold short" }, { id: "subordinatedDebt", label: "Subordinated debt" }, { id: "totalEquity", label: "Equity / member capital" }].map((item, index) => ({ ...item, value: metricMap[item.id]?.value ?? undefined, color: COLORS[index], sourceHref: sourceHref(metricMap[item.id]?.source) }));
  const limits = [...new Set<string>([...(analysis.limitations || []), ...(analysis.coverage?.caveats || []), ...(identity.classification.limitations || [])])];

  function chooseActive(key: string) { customized.current = true; setActive(key); setFamilyFilter("all"); if (!selected.includes(key)) setSelected(previous => [...previous.slice(0, 9), key]); }
  function changeFamily(family: string) { setFamilyFilter(family); const matching = selectedFilings.filter(row => family === "all" || brokerReportIdentity(reports[accessionOf(row)] || row).family === family); if (matching.length && !matching.some(row => accessionOf(row) === active)) setActive(accessionOf(matching[0])); }
  function retryReport() { delete cache.current[active]; attempted.current.delete(active); setErrors(previous => { const next = { ...previous }; delete next[active]; return next; }); setRetry(value => value + 1); }
  function applyPeriods() { if (!draft.length) return; customized.current = true; setSelected(draft); setFamilyFilter("all"); if (!draft.includes(active)) setActive(ordered(catalog.filter(row => draft.includes(accessionOf(row))))[0] ? accessionOf(ordered(catalog.filter(row => draft.includes(accessionOf(row))))[0]) : draft[0]); setPickerOpen(false); }
  async function loadOlder() {
    const next = archives.find(item => !item.loaded && !item.checked);
    if (!next || archiveLoading) return;
    const controller = new AbortController(); archiveController.current = controller; setArchiveLoading(true); setHistoryError("");
    try {
      const response = await fetch(next.historyHref || `/api/broker-dealer/history?${new URLSearchParams({ cik, archive: next.name })}`, { signal: controller.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Older SEC history is temporarily unavailable.");
      const combined = ordered([...catalogRef.current, ...(result.filings || [])]); catalogRef.current = combined; setCatalog(combined); setHistoryCoverage(result.coverage || {});
      const fetched = result.archives?.find((item: any) => item.name === next.name);
      if (fetched?.loaded === true) setArchives(previous => previous.map(item => item.name === next.name ? { ...item, loaded: true } : item));
      else setHistoryError("Part of the older SEC history could not be read. You can retry that archive.");
    } catch (error: any) { if (!controller.signal.aborted) setHistoryError(error.message); } finally { if (!controller.signal.aborted) setArchiveLoading(false); }
  }

  return <section className={styles.workspace} aria-label="Broker-dealer financial research">
    <div className={styles.controlBar}><div className={styles.periodControl}><span className={styles.overline}>Report period</span><label><span className={styles.srOnly}>Select active report period</span><select value={active} onChange={event => chooseActive(event.target.value)}>{catalog.map(row => <option key={accessionOf(row)} value={accessionOf(row)}>{periodOf(reports[accessionOf(row)]?.filing || row)} · {row.form || "X-17A-5"} · {reports[accessionOf(row)] ? brokerReportIdentity(reports[accessionOf(row)]).label : "Not yet read"} · Filed {row.filingDate}</option>)}</select></label></div><div className={styles.controlActions}><span className={styles.loadStatus} role="status">{loading ? <LoaderCircle size={13} className={styles.spinner} /> : <Check size={13} />} {loaded} of {selected.length} reports read</span><button type="button" className={styles.periodButton} onClick={() => { setDraft(selected); setPickerOpen(!pickerOpen); }} aria-expanded={pickerOpen}><SlidersHorizontal size={15} /> Adjust periods <ChevronDown size={13} /></button></div></div>
    {pickerOpen && <div className={styles.periodPicker}><div className={styles.panelHeading}><div><h3>Choose reports to compare</h3><p>The latest five reports are selected by default. Choose up to ten reports. Different FOCUS parts and annual reports remain separate; report type is confirmed when each attachment is read.</p></div><button type="button" aria-label="Close period selection" onClick={() => setPickerOpen(false)}><X size={16} /></button></div><div className={styles.periodChoices}>{catalog.map(row => { const key = accessionOf(row); return <label key={key} className={draft.includes(key) ? styles.checkedPeriod : undefined}><input type="checkbox" checked={draft.includes(key)} disabled={!draft.includes(key) && draft.length >= 10} onChange={() => setDraft(previous => previous.includes(key) ? previous.filter(id => id !== key) : [...previous, key])} /><span><strong>{periodOf(reports[key]?.filing || row)}</strong><small>{row.form} · Filed {row.filingDate}</small><small>{reports[key] ? `${brokerReportIdentity(reports[key]).label}${brokerReportIdentity(reports[key]).parts.length ? ` · ${brokerReportIdentity(reports[key]).parts.join(" / ")}` : ""}` : "Not yet read · classification pending"}</small></span></label>; })}</div><div className={styles.pickerActions}><button type="button" onClick={() => setDraft(latestPeriods(catalog.map(row => reports[accessionOf(row)] ? { ...row, classification: brokerReportIdentity(reports[accessionOf(row)]).classification } : row)).map(accessionOf))}>Latest five reports</button>{archives.some(item => !item.loaded && !item.checked) && <button type="button" onClick={loadOlder} disabled={archiveLoading}>{archiveLoading ? "Checking history…" : "Check older SEC history"}</button>}<button type="button" className={styles.applyButton} disabled={!draft.length} onClick={applyPeriods}>Apply {draft.length} reports</button></div></div>}
    {historyError && <p className={styles.inlineNotice}>{historyError} The reports already available remain usable.</p>}
    <div className={styles.familyControl}><label>Report type<select value={visibleFamily} onChange={event => changeFamily(event.target.value)}>{familyChoices.map(choice => { const count = choice.id === "all" ? selectedFilings.length : selectedFilings.filter(row => brokerReportIdentity(reports[accessionOf(row)] || row).family === choice.id).length; return <option key={choice.id} value={choice.id} disabled={!count}>{choice.label} ({count})</option>; })}</select></label><p>Annual and periodic reports are compared separately. Select a report to set the comparison scope.</p></div>
    <div className={styles.periodRibbon} aria-label="Selected report periods">{visibleFilings.map(row => { const key = accessionOf(row); return <button key={key} type="button" aria-pressed={key === active} onClick={() => setActive(key)} className={key === active ? styles.activePeriod : undefined}><span className={`${styles.periodDot} ${reports[key] ? styles.readyDot : errors[key] ? styles.errorDot : ""}`} /><span>{periodOf(row)}{row.form?.endsWith("/A") ? " · amended" : ""}<small>{reports[key] ? `${brokerReportIdentity(reports[key]).label}${brokerReportIdentity(reports[key]).parts.length ? ` · ${brokerReportIdentity(reports[key]).parts.join(" / ")}` : ""}` : "Not yet read"}</small></span>{!reports[key] && !errors[key] && <span className={styles.srOnly}>Loading</span>}</button>; })}</div>
    <nav className={styles.tabs} aria-label="Financial research views">{([{ id: "overview", label: "Overview", icon: Layers3 }, { id: "statements", label: "Statements", icon: FileText }, { id: "trends", label: "Trends", icon: TrendingUp }, { id: "ratios", label: "Ratios", icon: BarChart3 }, { id: "context", label: "Peers & CFTC", icon: BarChart3 }] as const).map(item => <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)} className={section === item.id ? styles.activeTab : undefined}><item.icon size={15} aria-hidden="true" />{item.label}</button>)}</nav>
    <div className={styles.selectedReport}><div><span className={styles.overline}>{filing?.form || "X-17A-5"} · {periodOf(filing)}</span><p>Filed {filing?.filingDate || "date unavailable"}<span> · </span>{accessionOf(filing)}</p></div><div>{current?.selectedDocument?.url && <a href={sourceHref({ url: current.selectedDocument.url })} target="_blank" rel="noreferrer">Open source PDF <ArrowUpRight size={14} /></a>}{filing && <a href={pageHref(cik, filing)}>Link to this report <ArrowUpRight size={14} /></a>}</div></div>
    {!current && <div className={styles.loadingPanel} role="status">{errors[active] ? <><FileText size={25} /><h3>This report is temporarily unavailable</h3><p>{errors[active]}</p><button type="button" onClick={retryReport} disabled={busy[active]}>Try this report again</button></> : <><LoaderCircle size={25} className={styles.spinner} /><h3>Reading this X-17A-5 report</h3><p>The other selected reports load in the background. Scanned PDFs can take longer to read.</p></>}</div>}
    {current && <ReportIdentity research={current} />}
    {current && excludedComparisons > 0 && ["statements", "trends", "ratios"].includes(section) && <p className={styles.inlineNotice}>Showing {comparisonFilings.length} report{comparisonFilings.length === 1 ? "" : "s"} in the selected comparison scope. {excludedComparisons} selected report{excludedComparisons === 1 ? " is" : "s are"} still unread, unclassified, filtered out or a different type, FOCUS part or reporting scope. Select a report above to inspect it separately.</p>}
    {current?.extraction?.retryable && <div className={styles.retryNotice} role="status"><p>Some pages could not be read on this attempt. Available figures remain visible; retry to complete the extraction.</p><button type="button" onClick={retryReport} disabled={busy[active]}>{busy[active] ? "Reading report…" : "Retry incomplete extraction"}</button></div>}
    {section === "overview" && current && <>
      <div className={styles.kpiGrid}>{[{ id: "totalAssets", label: "Total assets", note: "Reported balance sheet" }, { id: "totalEquity", label: "Equity / member capital", note: "Accounting capital" }, { id: "netCapital", label: "Regulatory net capital", note: "Disclosed regulatory measure" }, { id: "assetsToEquity", label: "Assets / equity", note: "Accounting leverage" }].map((item, index) => {
        const metric = metricMap[item.id], priorMetric = previousMetrics[item.id];
        const change = metric && priorMetric && typeof metric.value === "number" && typeof priorMetric.value === "number" && priorMetric.value > 0 ? metric.value / priorMetric.value - 1 : null;
        return <article key={item.id} className={styles.kpi} style={{ "--card-accent": COLORS[index] } as React.CSSProperties}><span>{item.label}</span><strong title={displayAmount(metric?.value, valueFormat(metric))}>{displayAmount(metric?.value, valueFormat(metric), true)}</strong><p>{change !== null ? <>{change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{displayAmount(Math.abs(change), "percent")} {change >= 0 ? "higher" : "lower"} vs {prior?.reportDate}</> : item.note}</p>{metric && <Evidence measure={metric} />}</article>;
      })}</div>
      <div className={styles.twoColumn}><BalanceBars title="Asset composition" description="Selected balances as a share of reported assets" total={metricMap.totalAssets?.value ?? undefined} items={assetItems} /><BalanceBars title="Funding & capital" description="Selected financing balances relative to total assets" total={metricMap.totalAssets?.value ?? undefined} items={fundingItems} /></div>
      <p className={styles.visualNote}>Bars show selected reported balances. They do not establish collateral coverage or a legally nettable exposure.</p>
      <TrendChart periods={chartPeriods} {...groups.balance} />{identity.family === "unknown" && <p className={styles.inlineNotice}>Trend comparisons are unavailable until the selected document’s report type is established. Its individually supported figures remain available.</p>}
      <div className={styles.sectionHeading}><div><span className={styles.overline}>Financial statements</span><h2>Read the figures behind the picture</h2></div><button type="button" onClick={() => setSection("statements")}>Compare all statements <ArrowUpRight size={14} /></button></div>
      <StatementTable reports={reports} filings={filing ? [filing] : []} statement="financial-condition" active={active} errors={errors} />
      {!!analysis.findings?.length && <div className={styles.findingsGrid}>{analysis.findings.slice(0, 4).map((finding: any, index: number) => <article key={finding.id || index}><span className={styles.findingNumber}>{String(index + 1).padStart(2, "0")}</span><h3>{finding.title}</h3><p>{finding.text}</p>{sourceHref(finding.source) && <a href={sourceHref(finding.source)} target="_blank" rel="noreferrer">Source{finding.source?.page ? ` · p. ${finding.source.page}` : ""} ↗</a>}</article>)}</div>}
    </>}
    {section === "statements" && <><div className={styles.sectionHeading}><div><span className={styles.overline}>Statements</span><h2>Compare the disclosed financials</h2><p>Exact USD amounts from compatible report types, with evidence from each attachment.</p></div></div><div className={styles.statementTabs} aria-label="Select financial statement">{STATEMENTS.map(item => <button key={item.id} type="button" aria-pressed={statement === item.id} className={statement === item.id ? styles.activePill : undefined} onClick={() => setStatement(item.id)}>{item.label}</button>)}</div><StatementTable reports={reports} filings={comparisonFilings} statement={statement} active={active} errors={errors} /></>}
    {section === "trends" && <><div className={styles.sectionHeading}><div><span className={styles.overline}>Across reporting periods</span><h2>See how the business changes</h2><p>Hover or focus a date for exact values. Unavailable figures remain gaps; incompatible report types are excluded.</p></div></div><div className={styles.statementTabs} aria-label="Select trend measures">{[{ id: "balance", label: "Balance sheet" }, { id: "capital", label: "Capital" }, { id: "earnings", label: "Earnings" }, { id: "cash", label: "Cash flow" }, { id: "leverage", label: "Leverage" }].map(item => <button key={item.id} type="button" aria-pressed={chartGroup === item.id} className={chartGroup === item.id ? styles.activePill : undefined} onClick={() => setChartGroup(item.id)}>{item.label}</button>)}</div><TrendChart periods={chartPeriods} {...activeGroup} />{identity.family === "unknown" && <p className={styles.inlineNotice}>This document’s report type is not established. Review it individually in Statements; it is excluded from trend comparisons.</p>}{suppressedFlows && ["earnings", "cash"].includes(chartGroup) && <p className={styles.inlineNotice}>Some flow measures have different or unconfirmed reporting durations. Their comparisons are withheld. Select a report to inspect its individual values and duration.</p>}<p className={styles.visualNote}>Charts use the latest selected version within the same report type, FOCUS part and reporting scope. Annual and periodic FOCUS reports are never joined into one trend.</p><div className={styles.twoColumn}><TrendChart periods={chartPeriods} {...groups.capital} /><TrendChart periods={chartPeriods} {...groups.leverage} /></div></>}
    {section === "ratios" && <><div className={styles.sectionHeading}><div><span className={styles.overline}>Financial profile</span><h2>Leverage, liquidity & capital</h2><p>Calculated from compatible reported inputs. Expand any calculation to inspect its source.</p></div></div><div className={styles.ratioGrid}>{["assetsToEquity", "equityToAssets", "cashToAssets", "netCapitalToRequired", "reverseReposToAssets", "reposToLiabilities"].map(id => { const metric = metricMap[id]; return metric ? <article key={id}><span>{metric.label}</span><strong>{displayAmount(metric.value, valueFormat(metric))}</strong><p>{metric.formula}</p><Evidence measure={metric} /></article> : null; })}</div><StatementTable reports={reports} filings={comparisonFilings} ratios active={active} errors={errors} /><p className={styles.visualNote}>Ratios describe the disclosed financial structure. Accounting leverage is not collateral-adjusted; regulatory capital differs from equity.</p></>}
    {section === "context" && <BrokerDealerContext cik={cik} research={current || { company: discovery?.company, filing }} />}
    <details className={styles.coverage}><summary>Sources, statement coverage & mapping details <span>{metricsOf(current).length} mapped figures · {ratiosOf(current).length} ratios</span></summary><div className={styles.coverageBody}><p>Financial condition, income, cash flow and regulatory capital appear only when supported by the selected public attachment. Each reported value keeps its source page; calculated values expose their inputs.</p>{current?.extraction && <p>{analysis.coverage?.pagesWithText ?? current.extraction.pagesWithText ?? "Available"} readable pages{analysis.coverage?.totalPages ? ` of ${analysis.coverage.totalPages}` : ""}.{current.observedAt ? ` Extracted ${current.observedAt.slice(0, 10)}.` : ""}</p>}{limits.length > 0 && <ul>{limits.map(limit => <li key={limit}>{limit}</li>)}</ul>}{current?.documents?.length ? <div className={styles.documentList}><h3>Original filing attachments</h3>{current.documents.map(document => <div key={document.name}><FileText size={14} /><a href={sourceHref({ url: document.url })} target="_blank" rel="noreferrer">{document.description || document.name} ↗</a>{filing && <a href={pageHref(cik, filing, document.name)}>Analyze attachment</a>}</div>)}</div> : null}{historyCoverage.complete === false || historyCoverage.allHistoryLoaded === false ? <p>Older reports may exist beyond the SEC history checked. Use Adjust periods to inspect available history or <a href={`/filings/${cik}`}>open all filings</a>.</p> : null}</div></details>
  </section>;
}
