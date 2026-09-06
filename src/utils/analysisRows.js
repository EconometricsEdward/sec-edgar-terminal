import {
  analysisBaseline,
  analysisChange,
  commonSizePoint,
} from "./analysisResearch.js";
import { exportAnalysisCsv } from "./analysisNotebook.js";

export function statementPoint(data, settings, key, index) {
  return settings.display === "common"
    ? commonSizePoint(data, key, index)
    : data.metrics[key]?.[index];
}

export function statementFormat(definition, settings) {
  return settings.display === "common" &&
    definition.format === "currency" &&
    ["income", "balance", "cashflow"].includes(definition.category)
    ? "percent"
    : definition.format;
}

export function analysisRows(data, settings, index) {
  if (!data || index < 0) return [];
  const query = (settings.search || "").trim().toLowerCase();
  const pins = settings.pins || [];
  const prior = analysisBaseline(data.periods, index, settings.baseline);
  return data.definitions
    .filter((definition) => {
      const point = statementPoint(data, settings, definition.key, index);
      const matches = `${definition.label} ${definition.key}`
        .toLowerCase()
        .includes(query);
      if (query && !matches) return false;
      if (settings.rowScope === "pins") return pins.includes(definition.key);
      if (
        !query &&
        definition.category !== settings.statement &&
        !pins.includes(definition.key)
      )
        return false;
      if (settings.rowScope === "available")
        return Number.isFinite(point?.value);
      if (settings.rowScope === "missing")
        return !Number.isFinite(point?.value);
      if (settings.rowScope === "changed") {
        const change = analysisChange(
          point,
          prior >= 0
            ? statementPoint(data, settings, definition.key, prior)
            : null,
          statementFormat(definition, settings),
        );
        return change.delta != null && change.delta !== 0;
      }
      return true;
    })
    .sort(
      (a, b) => Number(pins.includes(b.key)) - Number(pins.includes(a.key)),
    );
}

/** Exports precisely the metric/period cells on screen, retaining their source inputs. */
export function exportVisibleAnalysisCsv(
  data,
  settings,
  index,
  rows = analysisRows(data, settings, index),
) {
  const periods = data.periods.slice(index, index + settings.years);
  return exportAnalysisCsv(
    {
      ...data,
      periods,
      definitions: rows.map((definition) => ({
        ...definition,
        format: statementFormat(definition, settings),
      })),
      metrics: Object.fromEntries(
        rows.map((definition) => [
          definition.key,
          periods.map((_, offset) =>
            statementPoint(data, settings, definition.key, index + offset),
          ),
        ]),
      ),
    },
    settings,
  );
}
