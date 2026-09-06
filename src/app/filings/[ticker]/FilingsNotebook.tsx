"use client";

import { useState } from "react";
import { Bookmark, Check, Download, FileText, ListChecks, Trash2 } from "lucide-react";
import { downloadText } from "../../../utils/download.js";
import { exportFilingsBrief, exportFilingsCsv, filingsPassageLabel, filingsSourceUrl, updateFilingsCompany } from "../../../utils/filingsNotebook.js";
import styles from "../notebook.module.css";

type Props = {
  ticker: string;
  company: any;
  notebook: any;
  onUpdate: (update: (current: any) => any) => boolean;
  onOpen: (filing: any) => void;
  onApplyView: (settings: any) => void;
  settings: any;
  coverage: any;
};
const recordOrder = (a: any, b: any) => (b.filing.filingDate || "").localeCompare(a.filing.filingDate || "");

export default function FilingsNotebook({ ticker, company, notebook, onUpdate, onOpen, onApplyView, settings, coverage }: Props) {
  const [status, setStatus] = useState("");
  const [recordLimit, setRecordLimit] = useState(12);
  const [evidenceLimit, setEvidenceLimit] = useState(8);
  const saved = notebook?.companies?.[ticker] || { records: {}, evidence: [], views: [] };
  const records: any[] = Object.values(saved.records);
  const queued = records.filter((record) => record.queued).sort(recordOrder);
  const reviewed = records.filter((record) => !record.queued).sort(recordOrder);
  const ordered = [...queued, ...reviewed];
  const mutate = (update: (current: any) => any, message: string) => {
    try {
      const success = onUpdate((current) => updateFilingsCompany(current, ticker, update));
      setStatus(success ? message : "Could not save this change. Existing saved data has been preserved; check the workspace storage message.");
      return success;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save this change. Existing saved data has been preserved.");
      return false;
    }
  };
  const changeRecord = (accession: string, patch: any, message: string) => mutate((current) => {
    const record = current.records[accession];
    if (!record) throw new Error("This saved filing was removed in another tab. Reopen it from the filing list to save a new review.");
    return { ...current, records: { ...current.records, [accession]: { ...record, ...patch } } };
  }, message);
  const changeEvidence = (id: string, notes: string, tags: string[]) => mutate((current) => {
    if (!current.evidence.some((entry: any) => entry.id === id)) throw new Error("This evidence was removed in another tab. Collect its passage again to save new notes.");
    return { ...current, evidence: current.evidence.map((entry: any) => entry.id === id ? { ...entry, notes, tags } : entry) };
  }, "Evidence notes and tags saved in this browser.");
  const exportSaved = (kind: "brief" | "csv") => {
    const options = { ticker, company, filings: records.map((record) => record.filing), records: saved.records, evidence: saved.evidence, settings, coverage };
    try {
      downloadText(`${ticker}-filing-research.${kind === "brief" ? "html" : "csv"}`, kind === "brief" ? exportFilingsBrief(options) : exportFilingsCsv(options), kind === "brief" ? "text/html" : "text/csv");
      setStatus(`${kind === "brief" ? "Research brief" : "Structured CSV"} download requested with saved sources, dates, settings and coverage.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "The export could not be created. Your saved research remains available."); }
  };
  return <section className={styles.notebook} aria-label={`${ticker} filing research notebook`}>
    <div className={styles.heading}>
      <div><p className={styles.eyebrow}>YOUR RESEARCH</p><h2>Review queue & evidence</h2><p>Keep filing decisions and their source passages together. Saved in this browser; export to share or back up your work.</p></div>
      <div className={styles.actions}>
        <button type="button" onClick={() => exportSaved("brief")}><FileText size={15} aria-hidden="true" /> Export brief</button>
        <button type="button" onClick={() => exportSaved("csv")}><Download size={15} aria-hidden="true" /> Export notebook CSV</button>
      </div>
    </div>
    <p className={styles.status} role="status" aria-live="polite">{status || `${queued.length} queued · ${records.filter((record) => record.reviewedAt).length} reviewed · ${saved.evidence.length} saved passages`}</p>
    <div className={styles.stats}>
      <div><ListChecks size={18} aria-hidden="true" /><strong>{queued.length}</strong><span>In your review queue</span></div>
      <div><Check size={18} aria-hidden="true" /><strong>{records.filter((record) => record.reviewedAt).length}</strong><span>Marked reviewed</span></div>
      <div><Bookmark size={18} aria-hidden="true" /><strong>{saved.evidence.length}</strong><span>Source passages collected</span></div>
    </div>
    <section className={styles.section} aria-labelledby="filings-saved-views-title">
      <h3 id="filings-saved-views-title">Saved research views <span>{saved.views.length}</span></h3>
      {saved.views.length ? <ul className={styles.views}>{saved.views.map((view: any) => <li key={view.id}>
        <div><strong>{view.name || "Untitled view"}</strong><small>Saved {view.createdAt?.slice(0, 10) || "date unavailable"}</small></div>
        <button type="button" onClick={() => { onApplyView(view.settings); setStatus(`Loaded “${view.name}”.`); }}>Load view</button>
        <button className={styles.iconButton} type="button" aria-label={`Remove saved view ${view.name}`} onClick={() => mutate((current) => ({ ...current, views: current.views.filter((item: any) => item.id !== view.id) }), "Saved view removed.")}><Trash2 size={15} aria-hidden="true" /></button>
      </li>)}</ul> : <p className={styles.empty}>Set your filing filters, then use Save view in the research controls to return to the same search.</p>}
    </section>
    <section className={styles.section} aria-labelledby="filings-saved-reviews-title">
      <h3 id="filings-saved-reviews-title">Filing reviews <span>{records.length}</span></h3>
      <p className={styles.hint}>Queued filings appear first. Review dates record your own actions; they do not imply that a document was fetched or automatically assessed.</p>
      {ordered.length ? <div className={styles.cards}>{ordered.slice(0, recordLimit).map((record: any) => {
        const filing = record.filing;
        const accession = filing.accession || filing.accessionNumber;
        const url = filingsSourceUrl(filing.documentUrl || filing.url);
        return <article className={styles.card} key={accession}>
          <div className={styles.cardHeader}><div><strong>{filing.form} <span>Filed {filing.filingDate || "date unavailable"}</span></strong><small>Reporting period {filing.reportDate || "unavailable"} · {accession}</small></div>
            <span className={record.queued ? styles.queued : styles.reviewed}>{record.queued ? "Queued" : record.reviewedAt ? "Reviewed" : "Saved notes"}</span></div>
          {record.reviewedAt && <p className={styles.hint}>Marked reviewed {new Date(record.reviewedAt).toLocaleString()}</p>}
          <div className={styles.actions}>
            <button type="button" onClick={() => onOpen(filing)}>Open filing</button>
            {url && <a href={url} target="_blank" rel="noreferrer">Original SEC document ↗</a>}
            <button type="button" onClick={() => changeRecord(accession, { queued: !record.queued }, record.queued ? "Filing removed from the queue. Notes and review history preserved." : "Filing added to the review queue.")}>{record.queued ? "Remove from queue" : "Add to queue"}</button>
            <button type="button" onClick={() => changeRecord(accession, { reviewedAt: record.reviewedAt ? "" : new Date().toISOString(), ...(record.reviewedAt ? {} : { queued: false }) }, record.reviewedAt ? "Review mark cleared. Notes preserved." : "Filing marked reviewed and removed from the queue.")}>{record.reviewedAt ? "Clear review mark" : "Mark reviewed"}</button>
          </div>
          <form key={`${accession}:${record.notes}`} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); changeRecord(accession, { notes: String(form.get("notes") || "") }, "Filing notes saved in this browser."); }}>
            <label>Notes for {filing.form} filed {filing.filingDate}<textarea name="notes" defaultValue={record.notes} maxLength={8000} rows={3} placeholder="What needs follow-up? Record your interpretation and questions." /></label>
            <button type="submit">Save filing notes</button>
          </form>
        </article>;
      })}</div> : <p className={styles.empty}>Your filing review queue is empty. Add a filing to the queue or mark it reviewed from the filing list.</p>}
      {ordered.length > recordLimit && <button className={styles.more} type="button" onClick={() => setRecordLimit((count) => count + 12)}>Show more saved filings ({ordered.length - recordLimit} remaining)</button>}
    </section>
    <section className={styles.section} aria-labelledby="filings-saved-evidence-title">
      <h3 id="filings-saved-evidence-title">Evidence collection <span>{saved.evidence.length}</span></h3>
      {saved.evidence.length ? <div className={styles.cards}>{saved.evidence.slice(0, evidenceLimit).map((entry: any) => {
        const filing = entry.filing;
        const url = filingsSourceUrl(filing.documentUrl || filing.url);
        const passageLabel = filingsPassageLabel(entry.paragraph);
        return <article className={styles.card} key={entry.id}>
          <div className={styles.cardHeader}><div><strong>{entry.paragraph.section || "Filing passage"}</strong><small>{filing.form} · filed {filing.filingDate || "unavailable"} · period {filing.reportDate || "unavailable"}</small><small>Accession {filing.accession || filing.accessionNumber} · {passageLabel}</small></div>
            <button className={styles.iconButton} type="button" aria-label={`Remove evidence from ${filing.form} filed ${filing.filingDate}, ${passageLabel}`} onClick={() => mutate((current) => ({ ...current, evidence: current.evidence.filter((item: any) => item.id !== entry.id) }), "Passage removed from the evidence collection.")}><Trash2 size={15} aria-hidden="true" /></button></div>
          <blockquote>{entry.paragraph.text}</blockquote>
          <div className={styles.actions}><button type="button" onClick={() => onOpen(filing)}>Read filing in context</button>{url && <a href={url} target="_blank" rel="noreferrer">Original SEC document ↗</a>}</div>
          <form key={`${entry.id}:${entry.notes}:${entry.tags.join(",")}`} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const tags = [...new Set(String(form.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean))]; changeEvidence(entry.id, String(form.get("notes") || ""), tags); }}>
            <label>Notes for {passageLabel.toLowerCase()}<textarea name="notes" defaultValue={entry.notes} maxLength={8000} rows={3} placeholder="Explain why this passage matters to your research." /></label>
            <label>Tags for {passageLabel.toLowerCase()}<input name="tags" defaultValue={entry.tags.join(", ")} maxLength={1054} placeholder="liquidity, follow-up, covenant" /></label>
            <small>Separate tags with commas. Up to 16 tags, 64 characters each.</small>
            <button type="submit">Save evidence notes</button>
          </form>
        </article>;
      })}</div> : <p className={styles.empty}>Open a filing in the evidence reader and collect a passage. Each saved quotation retains its section, accession, filing date and SEC source.</p>}
      {saved.evidence.length > evidenceLimit && <button className={styles.more} type="button" onClick={() => setEvidenceLimit((count) => count + 8)}>Show more passages ({saved.evidence.length - evidenceLimit} remaining)</button>}
    </section>
  </section>;
}
