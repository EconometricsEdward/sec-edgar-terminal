import type { PortfolioResearchChange, PortfolioResearchComparison } from "./portfolioChanges.js";

export type PortfolioRecentSecEvent = PortfolioResearchChange & {
  source: "sec";
  eventDate: string;
  dateBasis: "filed" | "observed";
  observedAt: string | null;
  filing: any | null;
  knownWeightPct: number | null;
};

export function isPortfolioRecentDate(value: unknown, windowDays?: number, now?: number | string | Date): boolean;
export function buildPortfolioRecentSecEvents(options?: {
  comparison?: PortfolioResearchComparison | null;
  snapshot?: any;
  rows?: any[];
  windowDays?: number;
  now?: number | string | Date;
  weights?: Record<string, number>;
}): {
  events: PortfolioRecentSecEvent[];
  coverageEvents: PortfolioRecentSecEvent[];
  warnings: string[];
  excludedUndatedFilings: number;
  excludedFutureFilings: number;
  excludedUnverifiedFilings: number;
  checkedIssuers: number;
  uncheckedIssuers: number;
  truncatedIssuers: number;
  windowLimitedIssuers: number;
  snapshotAgeDays: number | null;
  cutoffDate: string | null;
  currentDate: string | null;
};
