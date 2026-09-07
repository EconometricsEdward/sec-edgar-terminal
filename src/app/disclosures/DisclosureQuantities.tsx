"use client";
import { useMemo, useState } from "react";
import {
  disclosureQuantityComparison,
  disclosureQuantityParts,
} from "../../utils/disclosureQuantities.js";
import type { Filing, Passage } from "./disclosureTypes";
import s from "./disclosureReader.module.css";

export default function DisclosureQuantities({
  filing,
  passage,
}: {
  filing: Filing;
  passage: Passage;
}) {
  const [open, setOpen] = useState(false);
  const comparison = useMemo(
    () =>
      disclosureQuantityComparison(passage.priorText || "", passage.text || ""),
    [passage.priorText, passage.text],
  );
  const count = comparison.prior.length + comparison.current.length;
  if (!count) return null;
  return (
    <details
      className={s.quantities}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Inspect amounts, percentages & dates · {count} mentions</summary>
      {open && (
        <>
          <p className={s.note}>
            Literal figures in each quotation. Highlighting preserves signs,
            parentheses, currencies and decimal points. A figure appearing in
            both quotations does not establish that it measures the same item;
            no numerical change is inferred.
          </p>
          <div className={s.quantityLegend}>
            <span>
              <mark data-distinct="false">
                Also appears in the other quotation
              </mark>
            </span>
            <span>
              <mark data-distinct="true">Only in this quotation</mark>
            </span>
          </div>
          <div className={s.quantityGrid}>
            {[
              {
                title: "Prior quotation",
                text: passage.priorText || "",
                spans: comparison.prior,
                source: filing.pair?.prior,
              },
              {
                title: "Current quotation",
                text: passage.text || "",
                spans: comparison.current,
                source: filing,
              },
            ].map((side) => (
              <section key={side.title} aria-label={side.title}>
                <h4>{side.title}</h4>
                {side.source && (
                  <a
                    href={side.source.documentUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {side.source.form} · filed {side.source.filingDate} ↗
                  </a>
                )}
                {side.text ? (
                  <p className={s.quantityQuote}>
                    {disclosureQuantityParts(side.text, side.spans).map(
                      (part, i) =>
                        part.kind === "text" ? (
                          <span key={i}>{part.text}</span>
                        ) : (
                          <mark
                            key={i}
                            data-distinct={!part.alsoPresent}
                            title={`${part.kind}: ${part.alsoPresent ? "Also appears in the other quotation" : "Only in this quotation"}`}
                          >
                            {part.text}
                          </mark>
                        ),
                    )}
                  </p>
                ) : (
                  <p className={s.note}>
                    No matched{" "}
                    {side.title.startsWith("Prior") ? "prior" : "current"}{" "}
                    quotation. This does not establish a zero amount.
                  </p>
                )}
                {side.text && !side.spans.length && (
                  <p className={s.note}>
                    No numeric expressions detected in this quotation.
                  </p>
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </details>
  );
}
