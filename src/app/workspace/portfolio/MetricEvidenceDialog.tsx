"use client";

import { useEffect, useId, useRef } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { analysisMetricGuide } from "../../../utils/analysisMetricGuide.js";
import { portfolioMetricSourceUrl } from "../../../utils/portfolioAnalytics.js";
import { metricDisplay } from "../../../utils/portfolioDeepResearch.js";
import { portfolioMetricDefinitionFor } from "../../../utils/portfolioMetricCatalog.js";
import s from "./MetricEvidenceDialog.module.css";
import { portfolioReportingLabel } from "../../../utils/portfolioReporting.js";

type Props = {
  inspector: { issuer: any; key: string; point: any };
  onClose: () => void;
  onDisclosure?: (query: string, ciks: string[]) => void;
};

const companyLanguage = (text: string) =>
  text
    .replace(/\bissuer's\b/gi, "company’s")
    .replace(/\bissuers\b/gi, "companies")
    .replace(/\bissuer\b/gi, "company");

export default function MetricEvidenceDialog({
  inspector,
  onClose,
  onDisclosure,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    headingRef.current?.focus();
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const { issuer, key } = inspector;
  const point = inspector.point || {};
  const definition = portfolioMetricDefinitionFor(key);
  const guide = analysisMetricGuide(definition || {}, point, issuer.lens);
  const period = point.period || {};
  const inputs = [
    ...new Map<string, any>(
      (point.calculations || [])
        .filter(
          (entry: any) =>
            definition?.inputs?.includes(entry.key) &&
            Number.isFinite(entry.value),
        )
        .map((entry: any) => [entry.key, entry] as [string, any]),
    ).values(),
  ];
  const sources = (Array.isArray(point.sources) ? point.sources : [])
    .map((source: any) => ({
      source,
      url: portfolioMetricSourceUrl({ sources: [source] }),
    }))
    .filter((entry: any) => entry.url);
  const cik = /^\d{1,10}$/.test(String(issuer.cik || ""))
    ? String(issuer.cik).padStart(10, "0")
    : "";

  return (
    <dialog
      ref={dialogRef}
      className={s.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <header className={s.header}>
        <div>
          <p className={s.eyebrow}>Financial measure & SEC evidence</p>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            {definition?.label || key}
          </h2>
          <p id={descriptionId} className={s.company}>
            {issuer.ticker || issuer.name}
            {issuer.ticker && issuer.name ? ` · ${issuer.name}` : ""}
          </p>
        </div>
        <button
          type="button"
          className={s.close}
          onClick={onClose}
          aria-label="Close metric explanation"
        >
          <X size={18} aria-hidden="true" />
          <span>Close</span>
        </button>
      </header>

      <div className={s.body}>
        <div className={s.observation}>
          <strong className={s.value}>{metricDisplay(point, false)}</strong>
          <span>
            {point.classification === "calculated"
              ? "Calculated from reported inputs"
              : point.classification === "reported"
                ? "Reported in SEC evidence"
                : "Captured financial measure"}
          </span>
        </div>

        <section className={s.section} aria-label="Understanding this measure">
          <h3>What this measures</h3>
          <p>{companyLanguage(guide.meaning)}</p>
          <p>{companyLanguage(guide.movement)}</p>
          <p>{companyLanguage(guide.caution)}</p>
          {guide.scopeNotes.map((note: string) => (
            <p key={note}>{companyLanguage(note)}</p>
          ))}
        </section>

        <section
          className={s.section}
          aria-label="Calculation and reporting period"
        >
          <h3>Calculation & reporting period</h3>
          <p className={s.formula}>
            {companyLanguage(
              point.formula ||
                point.definitionFormula ||
                point.reason ||
                "Reported value; review the source concept below.",
            )}
          </p>
          <dl className={s.metadata}>
            <div>
              <dt>Reporting period</dt>
              <dd>
                {period.kind === "instant" && period.end
                  ? `As of ${period.end}`
                  : period.start || period.end
                    ? `${period.start || "Unknown start"} to ${period.end || "unknown end"}`
                    : "Period not included in this capture"}
              </dd>
            </div>
            <div>
              <dt>Period basis</dt>
              <dd>
                {period.kind
                  ? portfolioReportingLabel(period.kind)
                  : "Not included in this capture"}
              </dd>
            </div>
            <div>
              <dt>Evidence captured</dt>
              <dd>
                {issuer.company?.retrievedAt || "Capture date not recorded"}
              </dd>
            </div>
          </dl>
          {inputs.length > 0 && (
            <div
              className={s.inputTable}
              tabIndex={0}
              role="region"
              aria-label="Calculation inputs"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Input</th>
                    <th scope="col">Value</th>
                    <th scope="col">Reporting dates</th>
                  </tr>
                </thead>
                <tbody>
                  {inputs.map((input: any) => (
                    <tr key={input.key}>
                      <th scope="row">
                        {portfolioMetricDefinitionFor(input.key)?.label ||
                          input.label ||
                          input.key}
                      </th>
                      <td>
                        {metricDisplay(
                          {
                            value: input.value,
                            unit: input.unit || "USD",
                            classification: "reported",
                          },
                          false,
                        )}
                      </td>
                      <td>
                        {input.start
                          ? `${input.start} to ${input.end}`
                          : `As of ${input.end}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={s.section} aria-label="SEC source documents">
          <h3>SEC sources</h3>
          {sources.length ? (
            <ul className={s.sources}>
              {sources.map(({ source, url }: any, index: number) => (
                <li
                  key={`${url}-${source.tag || source.label || "source"}-${index}`}
                >
                  <a href={url} target="_blank" rel="noreferrer">
                    {source.tag || source.label || "SEC evidence"}
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </a>
                  {(source.form || source.filed) && (
                    <span>
                      {[source.form, source.filed && `Filed ${source.filed}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>No direct SEC source link is included in this capture.</p>
          )}
        </section>

        {onDisclosure && cik && (
          <footer className={s.footer}>
            <button
              type="button"
              onClick={() => {
                onClose();
                onDisclosure(guide.query || "liquidity", [cik]);
              }}
            >
              Search this company’s related disclosures
              <ArrowUpRight size={16} aria-hidden="true" />
            </button>
          </footer>
        )}
      </div>
    </dialog>
  );
}
