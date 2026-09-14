export const PORTFOLIO_BASELINE_VERSION: string;
export const PORTFOLIO_BASELINE_LIMIT: number;

export function portfolioMetricDefinition(point: any): string;
export function validatePortfolioBaseline(value: any): any;
export function createPortfolioBaseline(snapshot: any): any;
export function advancePortfolioBaseline(
  document: any,
  nextSnapshot: any,
  completeCheck: boolean,
): any;

export type PortfolioResearchChange = {
  cik: string;
  rowId: string;
  ticker: string;
  companyName: string;
  kind: "filing" | "period" | "revision" | "coverage";
  id: string;
  title: string;
  description: string;
  before: string;
  after: string;
  beforeSources: string[];
  afterSources: string[];
  fresh: boolean;
  metric?: string;
  beforeValue?: number;
  afterValue?: number;
  unit?: string;
  period?: string;
};

export type PortfolioResearchComparison = {
  state: "ready" | "needs_baseline" | "incompatible";
  baselineAt: string | null;
  capturedAt: string | null;
  changes: PortfolioResearchChange[];
  warnings: string[];
  counts: {
    filing: number;
    period: number;
    revision: number;
    coverage: number;
  };
  checkedIssuers: number;
  uncheckedIssuers: number;
};

export function comparePortfolioResearch(
  baseline: any,
  snapshot: any,
  rows?: any[],
): PortfolioResearchComparison;
