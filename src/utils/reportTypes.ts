export type ReportKind = 'company' | 'nport' | '13f';
export type ReportFormat = 'text' | 'usd' | 'number' | 'percent' | 'ratio' | 'date';
// Percent values are fractions: 0.125 means 12.5%. USD values are whole dollars.
export type ReportSource = { id: string; label: string; url: string; form?: string; periodEnd?: string; filed?: string; accession?: string; concept?: string; unit?: string; value?: number | null; start?: string; note?: string };
export type ReportColumn = { key: string; label: string; format: ReportFormat; formatKey?: string; width?: number };
export type ReportSection = { id: string; title: string; description?: string; columns: ReportColumn[]; rows: Record<string, unknown>[]; footnote?: string; pdfRowLimit?: number };
export type ReportDocument = {
  schema: 'edgar.report.v1'; kind: ReportKind; generatedAt: string;
  entity: { id: string; name: string; ticker?: string; cik: string; seriesId?: string };
  title: string; subtitle: string;
  period: { label: string; asOf: string | null; filingDate: string | null; basis?: string };
  summary: { label: string; value: number | null; unit: ReportFormat; detail?: string; sourceIds?: string[] }[];
  highlights: { title: string; text: string }[];
  sections: ReportSection[];
  charts?: { kind: 'bar' | 'line'; title: string; unit: ReportFormat; points: { label: string; value: number | null }[] }[];
  sources: ReportSource[]; notes: string[];
  coverage: { status: 'ready' | 'partial'; message: string; recordCount?: number; availableMetrics?: number; totalMetrics?: number };
};
export type ReportSearchResult = { kind: ReportKind; id: string; name: string; ticker?: string; cik: string; seriesId?: string; detail: string };
