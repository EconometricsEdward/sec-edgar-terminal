export type Basis = 'annual' | 'ttm';
export type MarketTab = 'overview' | 'positioning' | 'sectors' | 'companies' | 'fundamentals' | 'saved';
export type MarketView = { tab: MarketTab; basis: Basis; cohort: string; query: string; screen: string; sort: string; direction: string; metric: string; statistic: string; selected: string[]; quantThreshold: number; cftcFamily: 'tff' | 'disaggregated'; cftcContract: string; cftcGroup: string; cftcDate: string; cftcHistory: '1y' | '3y' | '5y'; cftcDisplay: 'net-oi' | 'percentile' };
export type Period = { end: string; start?: string | null; filed: string; form: string; accession: string; fy: number; fp: string };
export type FilingMetricSource = { accession: string; filed: string; acceptedAt: string | null; form: string | null; start: string | null; end: string; taxonomy: string | null; tag: string | null; unit: string | null; value: number; source: string };
type FilingComparisonPointBase = { end: string; filed: string; acceptedAt: string | null; form: string; accession: string; source?: string | null; metrics: Record<string, number | null> };
export type FilingComparisonPoint = FilingComparisonPointBase & (
  | { factorSourceAccessions: string[]; factorSourceMasks: string[]; metricSources?: never }
  | { metricSources: Record<string, FilingMetricSource[]>; factorSourceAccessions?: never; factorSourceMasks?: never }
);
export type FilingComparison = { pointInTime: true; cutoff: { filed: string; acceptedAt: string | null; accession: string }; current: FilingComparisonPoint; prior: FilingComparisonPoint | null; gapDays: number | null; changes: Record<string, number | null> };
export type Company = { version: string; ticker: string; name: string; cik: string; sic: string; revenueBasis?: string; cohorts: string[]; observedAt: string; metrics: Record<Basis, Record<string, number | null>>; reports: Record<Basis, Period | null>; filingComparisons?: Record<Basis, FilingComparison | null>; sector?: string; coverageFund?: string; secCheckedAt?: string; factsRetrievedAt?: string; cache?: { status: 'stale'; warning: string } };
export type Cohort = { id: string; label: string; title: string; description: string; tickers: string[]; disclosureTerms: string; targetKnown?: boolean };
export type Saved = { version: number; watchlist: string[]; views: { name: string; query: string }[]; baselines: Record<string, Company>; migrationNotice?: string };
export type Stats = { count: number; total: number; median: number | null; mean: number | null; positive: number; negative: number; positivePct: number | null };
export type MarketData = { viewVersion: string; themes: Cohort[]; historyNote?: string; coverage?: { membership_id: string; target_issuers: number; loaded_issuers: number; missing_issuers: number; source_securities: number; duplicate_share_classes: number; sources: { fund: string; as_of: string; url: string; securities: number }[] }; version: string; generatedAt: string; requested: number; companies: Company[]; cohorts: Cohort[]; failures: { ticker: string; reason: string }[]; historyPersistence: boolean; observations: { observedAt: string; companies: number; tickers: string[]; revenueGrowth: Stats; netMargin: Stats }[]; cache?: { status: 'stale'; warning: string } };
export type Source = { tag: string; taxonomy: string; unit: string; start: string | null; end: string; filed: string; accession: string; value: number; revised?: boolean };
export type Input = { value: number | null; classification: string; formula: string | null; sources: Source[]; calculations: { value: number; formula: string; start: string; end: string; unit: string }[] };
export type Evidence = { period: Period; inputs: Record<string, Input>; metrics: Record<string, number | null>; priorRevenue: (Input & { period: Period }) | null };
export type CompanyDetail = Company & { evidence: Record<Basis, Evidence[]> };
