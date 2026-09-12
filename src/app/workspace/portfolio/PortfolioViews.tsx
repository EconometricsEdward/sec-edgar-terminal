"use client";

import s from "./PortfolioViews.module.css";

type ViewValue = {
  query: string;
  filter: string;
  industryFilter: string;
  sort: string;
  direction: string;
  columns: string[];
  preset: string;
};
type Preset = {
  id: string;
  name: string;
  description: string;
  columns: string[];
  sort: string;
  direction: string;
  rowCount: number;
};

export default function PortfolioViews({
  value,
  onChange,
  presets,
}: {
  value: ViewValue;
  onChange: (value: ViewValue) => void;
  presets: Preset[];
}) {
  const preset = presets.find((entry) => entry.id === value.preset);
  return (
    <section className={s.root} aria-label="Research lenses">
      <label className={s.selector}>
        Research lens
        <select
          value={value.preset}
          aria-describedby="portfolio-lens-description"
          onChange={(event) => {
            const next = presets.find(
              (entry) => entry.id === event.target.value,
            );
            if (!next) return;
            onChange({
              ...value,
              preset: next.id,
              columns: [...next.columns],
              sort: next.sort,
              direction: next.direction,
            });
          }}
        >
          {presets.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} · {entry.rowCount}{" "}
              {entry.rowCount === 1 ? "row" : "rows"}
            </option>
          ))}
        </select>
      </label>
      <div className={s.explanation}>
        <p id="portfolio-lens-description">{preset?.description}</p>
        <p className={s.hint}>
          Search and filters stay applied when you change lenses. Only measures
          with usable evidence are shown.
        </p>
      </div>
    </section>
  );
}
