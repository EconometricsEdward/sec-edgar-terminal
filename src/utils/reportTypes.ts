export type ReportKind = 'company' | 'nport' | '13f' | 'market';
export type ReportFormat = 'text' | 'usd' | 'number' | 'percent' | 'ratio' | 'date';
// Percent values are fractions: 0.125 means 12.5%. USD values are whole dollars.
export type ReportSource = { id: string; label: string; url: string; form?: string; periodEnd?: string; filed?: string; accession?: string; concept?: string; unit?: string; value?: number | null; start?: string; note?: string };
export type ReportColumn = { key: string; label: string; format: ReportFormat; formatKey?: string; width?: number };
export type ReportSection = { id: string; title: string; description?: string; columns: ReportColumn[]; rows: Record<string, unknown>[]; footnote?: string; pdfRowLimit?: number };
// Rich Market presentation keeps the shared Market page's percentage-point
// scale (12.5 means 12.5%). Flat sections and breadth.share still use fractions.
export type ReportMarketStats = { count: number; total: number; median: number | null; mean: number | null; positive: number; negative: number; positivePct: number | null };
export type ReportMarketIndustry = { code: string; label: string; known: boolean; count: number; metrics?: Record<string, ReportMarketStats> };
export type ReportMarketSector = { id: string; label: string; count: number; targetCount: number | null; industries: ReportMarketIndustry[]; missingIndustryCount: number; metrics: Record<string, ReportMarketStats> };
export type ReportMarketPositioningCard = {
  id: string; category: string; family: string; code: string; group: string; label: string; lens: string; context: string;
  familyLabel: string; groupLabel: string; available: boolean; hasObservation: boolean; reportDate: string | null;
  aged: boolean; stale: boolean; exchange: string | null; units: string | null;
  net: number | null; netPctOi: number | null; weeklyChange: number | null; openInterest: number | null;
  long: number | null; short: number | null; weeklyNetChange: number | null; sourceUrl: string | null;
  description: string; view: Record<string, string>;
};
export type ReportMarketGrowthLeader = { sector: string; sectorId: string; value: number; count: number; companies: number };
export type ReportMarketBriefing = {
  coverage: { companyCount: number; sectorCount: number; industryCount: number; requestedCount: number | null;
    missingCompanies: number | null; unsupportedCount: number; awaitingCount: number | null;
    missingSectorCount: number; missingIndustryCount: number; unknownIndustryCount: number; unknownIndustryCompanyCount: number;
    olderReports: number; snapshotAt: string; reportRange: { earliest: string; latest: string; count: number } | null;
    sourceSecurities: number | null; duplicateShareClasses: number | null; grouping: string; membershipWarning: string };
  breadth: { id: string; label: string; positive: number; count: number; share: number | null; context: string }[];
  growthLeaders: { highest: ReportMarketGrowthLeader | null; lowest: ReportMarketGrowthLeader | null; spreadPp: number | null };
  positioning: { cards: ReportMarketPositioningCard[]; families: { family: string; label: string; valid: boolean;
    reportDate: string | null; retrievedAt: string | null; sourceAgeDays: number | null; aged: boolean; stale: boolean;
    partial: boolean; warning: string; documentationUrl: string }[];
    availableCount: number; comparableCount: number; differentReportDates: boolean; largestMove: ReportMarketPositioningCard | null };
  sectorMetrics: { key: string; label: string; shortLabel: string; context: string }[];
  sectors: ReportMarketSector[]; industries: ReportMarketIndustry[];
};
export type ReportDocument = {
  schema: 'edgar.report.v1'; kind: ReportKind; generatedAt: string;
  entity: { id: string; name: string; ticker?: string; cik: string; seriesId?: string };
  title: string; subtitle: string;
  period: { label: string; asOf: string | null; filingDate: string | null; basis?: string };
  summary: { label: string; value: number | null; unit: ReportFormat; detail?: string; sourceIds?: string[] }[];
  highlights: { title: string; text: string }[];
  sections: ReportSection[];
  charts?: { kind: 'bar' | 'line'; title: string; unit: ReportFormat; points: { label: string; value: number | null }[] }[];
  marketBriefing?: ReportMarketBriefing;
  sources: ReportSource[]; notes: string[];
  coverage: { status: 'ready' | 'partial'; message: string; recordCount?: number; availableMetrics?: number; totalMetrics?: number };
};
export type ReportSearchResult = { kind: ReportKind; id: string; name: string; ticker?: string; cik: string; seriesId?: string; annualReportForm?: 'X-17A-5'; detail: string };
