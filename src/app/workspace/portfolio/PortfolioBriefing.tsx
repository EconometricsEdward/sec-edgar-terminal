"use client";

import { useMemo } from "react";
import { ArrowUpRight, ListChecks } from "lucide-react";
import { buildPortfolioBriefing } from "../../../utils/portfolioConcentration.js";
import s from "./PortfolioBriefing.module.css";

export default function PortfolioBriefing({
  report,
  onNavigate,
  onInspectCompany,
}: {
  report: any;
  onNavigate: (area: string) => void;
  onInspectCompany: (rowId: string) => void;
}) {
  const cards = useMemo(() => buildPortfolioBriefing(report), [report]);
  if (!report.holdingCount) return null;
  return (
    <section className={s.root} aria-label="Portfolio research briefing">
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>
            <ListChecks size={15} aria-hidden="true" /> A place to start
          </p>
          <h3>Your research briefing</h3>
        </div>
        <p>
          A reading order based on this snapshot. Open a finding to review the
          underlying evidence.
        </p>
      </div>
      <div className={s.cards}>
        {cards.map((card) => (
          <article
            className={s.card}
            key={card.id}
            data-attention={card.tone === "attention"}
          >
            <p className={s.label}>{card.label}</p>
            <strong>{card.value}</strong>
            <p className={s.description}>{card.text}</p>
            <button
              type="button"
              onClick={() =>
                card.rowId
                  ? onInspectCompany(card.rowId)
                  : onNavigate(card.area)
              }
            >
              {card.action}
              <ArrowUpRight size={16} aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
