export interface PreloadedCompany {
  ticker: string;
  cik: string;
  name: string;
}
export interface CompareCompany {
  color?: string;
  ticker: string;
  loading: boolean;
  error: string | null;
  data: any | null;
  duplicate?: boolean;
  index?: number;
  period?: any;
}
export type CompareSettings = {
  basis: string;
  alignment: string;
  period: string;
  asOf: string;
  lens: string;
  benchmark: string;
  metrics: string[];
  excluded: string[];
  view: string;
  metric: string;
  x: string;
  y: string;
  years: number;
  mode: string;
  sort: string;
  descending: boolean;
};
export type CompareEvidence = { cell: any; metric: any };
export const COLORS = ["#e8b548", "#45b9cc", "#a598ef", "#ec9a8d", "#73c1a2"];
export function displayValue(
  value: number | null | undefined,
  format = "currency",
) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (format === "percent") return `${value.toFixed(2)}%`;
  if (format === "decimal") return `${value.toFixed(2)}×`;
  const n = Math.abs(value),
    sign = value < 0 ? "−" : "";
  for (const [base, unit] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as [number, string][])
    if (n >= base) return `${sign}$${(n / base).toFixed(2)}${unit}`;
  return `${sign}$${n.toFixed(2)}`;
}
export function displayDelta(value: number | null, format: string) {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return format === "percent"
    ? `${sign}${Math.abs(value).toFixed(2)} pp`
    : format === "decimal"
      ? `${sign}${Math.abs(value).toFixed(2)}×`
      : `${sign}${displayValue(Math.abs(value), format)}`;
}
export function downloadFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
