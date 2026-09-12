"use client";

import { useId, useMemo, useState } from "react";
import { buildConcentrationHeatMap } from "../../../utils/portfolioConcentration.js";
import s from "./PortfolioConcentrationHeatMap.module.css";

type HeatMapMode = "issuer" | "sector" | "industry";

type Props = {
  report: any;
  onInspectCompany: (rowId: string) => void;
  onReviewRows: () => void;
  onSelectGroup: (mode: "sector" | "industry", label: string) => void;
};

const MODES: { id: HeatMapMode; label: string }[] = [
  { id: "issuer", label: "Holdings" },
  { id: "sector", label: "Sectors" },
  { id: "industry", label: "SEC industries" },
];

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const number = (value: unknown, digits = 2) =>
  finite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "Unavailable";

function countLabel(value: number, mode: HeatMapMode, unresolved = false) {
  const unit =
    mode === "issuer" || unresolved
      ? value === 1
        ? unresolved
          ? "unresolved position"
          : "holding"
        : unresolved
          ? "unresolved positions"
          : "holdings"
      : value === 1
        ? "company"
        : "companies";
  return `${number(value, 0)} ${unit}`;
}

function countSummary(model: any, mode: HeatMapMode) {
  const unit = mode === "issuer" ? "holding" : "company";
  const resolved = `${number(model.resolvedValue, 0)} ${model.resolvedValue === 1 ? unit : `${unit}s`}`;
  if (model.unresolvedValue)
    return `${resolved} + ${number(model.unresolvedValue, 0)} unresolved`;
  return `${resolved} mapped`;
}

export default function PortfolioConcentrationHeatMap({
  report,
  onInspectCompany,
  onReviewRows,
  onSelectGroup,
}: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const [mode, setMode] = useState<HeatMapMode>("issuer");
  const [activeId, setActiveId] = useState<string | null>(null);
  const model = useMemo(
    () => buildConcentrationHeatMap(report, mode),
    [report, mode],
  );
  const active =
    model.tiles.find(
      (tile: any) => tile.id === activeId && !tile.placeholder,
    ) || model.tiles.find((tile: any) => !tile.placeholder);
  const modeLabel = MODES.find((entry) => entry.id === mode)?.label || "Groups";
  const mappedSummary = model.weighted
    ? model.mappedValue > 100 + 1e-8
      ? `${number(model.mappedValue)}% supplied`
      : model.complete
        ? `${number(model.mappedValue)}% mapped`
        : `${number(model.mappedValue)}% known weight mapped`
    : countSummary(model, mode);

  const valueLabel = (tile: any) =>
    model.weighted
      ? `${number(tile.value)}% ${model.complete ? "allocation" : "known allocation"}`
      : countLabel(
          tile.value,
          mode,
          tile.label === "Unresolved positions",
        );

  const actionLabel = (tile: any) => {
    const value = valueLabel(tile);
    if (tile.action === "inspect")
      return `Inspect ${tile.label}, ${value}`;
    if (tile.action === "filter")
      return `Filter companies to ${tile.label}, ${value}`;
    return `Review ${tile.label}, ${value}`;
  };

  const activate = (tile: any) => {
    setActiveId(tile.id);
    if (tile.action === "inspect" && tile.rowIds[0])
      onInspectCompany(tile.rowIds[0]);
    else if (tile.action === "filter" && mode !== "issuer")
      onSelectGroup(mode, tile.label);
    else if (tile.action === "review") onReviewRows();
  };

  return (
    <section className={s.card} aria-labelledby={titleId}>
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>Allocation map</p>
          <h4 id={titleId}>
            {model.weighted
              ? "Concentration heat map"
              : "Research-universe heat map"}
          </h4>
        </div>
        <span className={s.coverage}>{mappedSummary}</span>
      </div>
      <p id={descriptionId} className={s.help}>
        {model.weighted
          ? "Tile area reflects original known allocation; stronger gold marks a larger share within this view. Values are not reweighted."
          : "Tile area reflects included positions or companies, not portfolio exposure. Add weights to measure allocation concentration."}
      </p>
      <div className={s.toolbar}>
        <div className={s.modes} role="group" aria-label="Heat map grouping">
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={mode === entry.id}
              onClick={() => {
                setMode(entry.id);
                setActiveId(null);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className={s.legend} aria-label="Relative concentration scale">
          <span>Lower share</span>
          <span className={s.swatches} aria-hidden="true">
            {[1, 2, 3, 4, 5].map((band) => (
              <i key={band} data-band={band} />
            ))}
          </span>
          <span>Higher share</span>
        </div>
      </div>
      {!model.tiles.length ? (
        <p className={s.empty} role="status">
          {model.weighted
            ? "No positive known weights are available for this map. Complete the allocation to visualize concentration."
            : `No included ${modeLabel.toLowerCase()} are available for this map.`}
        </p>
      ) : (
        <figure className={s.figure} aria-describedby={descriptionId}>
          <div
            className={s.map}
            role="group"
            aria-label={`${modeLabel} concentration heat map`}
          >
            {model.tiles.map((tile: any) => {
              const style = {
                left: `${tile.x}%`,
                top: `${tile.y}%`,
                width: `${tile.width}%`,
                height: `${tile.height}%`,
              };
              if (tile.placeholder)
                return (
                  <div
                    key={tile.id}
                    className={`${s.tile} ${s.unmapped}`}
                    data-size={tile.labelSize}
                    style={style}
                    title={`${tile.label}: ${number(tile.value)}%`}
                  >
                    {tile.labelSize === "small" ? (
                      <span className={s.srOnly}>
                        {tile.label}: {number(tile.value)}%
                      </span>
                    ) : (
                      <>
                        <strong>{tile.label}</strong>
                        <span>{number(tile.value)}%</span>
                      </>
                    )}
                  </div>
                );
              return (
                <button
                  key={tile.id}
                  type="button"
                  className={s.tile}
                  data-band={tile.heatBand}
                  data-size={tile.labelSize}
                  data-active={active?.id === tile.id}
                  style={style}
                  aria-label={actionLabel(tile)}
                  title={`${tile.label}: ${valueLabel(tile)}`}
                  onMouseEnter={() => setActiveId(tile.id)}
                  onFocus={() => setActiveId(tile.id)}
                  onClick={() => activate(tile)}
                >
                  {tile.labelSize === "small" ? (
                    <span className={s.srOnly}>
                      {tile.label}: {valueLabel(tile)}
                    </span>
                  ) : (
                    <>
                      <strong>{tile.label}</strong>
                      <span>{valueLabel(tile)}</span>
                      {tile.labelSize === "large" &&
                        tile.description !== tile.label && (
                          <small>{tile.description}</small>
                        )}
                    </>
                  )}
                </button>
              );
            })}
          </div>
          <figcaption className={s.detail} aria-live="polite">
            {active ? (
              <>
                <span>
                  <strong>{active.label}</strong>
                  {active.description !== active.label && (
                    <small>{active.description}</small>
                  )}
                </span>
                <span>
                  <b>{valueLabel(active)}</b>
                  <small>
                    {active.action === "inspect"
                      ? "Select the tile to inspect company evidence."
                      : active.action === "filter"
                        ? "Select the tile to filter the companies below."
                        : "Select the tile to review these positions."}
                  </small>
                </span>
              </>
            ) : (
              <span>Move across the map to inspect a group.</span>
            )}
          </figcaption>
        </figure>
      )}
      {(model.unmappedValue > 0 ||
        model.overAllocated ||
        model.unavailableCount > 0 ||
        model.zeroCount > 0 ||
        (model.weighted && !model.complete)) && (
        <p className={s.note}>
          {model.unmappedValue > 0 && (
            <>
              The hatched area is the {number(model.unmappedValue)} percentage
              point difference between known supplied weights and 100%.{" "}
            </>
          )}
          {model.overAllocated && (
            <>
              Supplied weights total {number(model.mappedValue)}%, or{" "}
              {number(model.excessPct)} percentage points above 100%; tile areas
              are scaled to the supplied total and are not normalized. {" "}
            </>
          )}
          {model.unavailableCount > 0 && (
            <>
              {model.unavailableCount} {modeLabel.toLowerCase()} with unavailable
              weights {model.unavailableCount === 1 ? "is" : "are"} excluded
              from the geometry. {" "}
            </>
          )}
          {model.zeroCount > 0 && (
            <>
              {model.zeroCount} zero-weight {modeLabel.toLowerCase()}{" "}
              {model.zeroCount === 1 ? "has" : "have"} no visible area. {" "}
            </>
          )}
          {model.weighted && !model.complete && (
            <>Treat every displayed percentage as a known subtotal.</>
          )}
        </p>
      )}
    </section>
  );
}
