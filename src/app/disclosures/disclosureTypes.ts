export type SearchSettings = {
  query: string;
  tickers: string;
  mode: "companies" | "index";
  start: string;
  end: string;
  forms: string;
  section: string;
  scope: "paragraph" | "document";
  depth: number;
  amendments: boolean;
};
export type Passage = {
  index: number;
  text: string;
  priorText?: string;
  section: string;
  sectionId: string;
  beforeContext?: string;
  afterContext?: string;
  matchedTerms: string[];
  reasons: string[];
  relevance: number;
  proximity: number | null;
  concrete: boolean;
  label: string;
  change: string;
  previewTruncated?: boolean;
};
export type Filing = {
  ticker: string;
  cik: string;
  companyName: string;
  accession: string;
  form: string;
  filingDate: string;
  reportDate: string;
  primaryDoc: string;
  documentUrl: string;
  status?: string;
  matched?: boolean;
  reason?: string;
  matchCount?: number;
  removedCount?: number;
  queryRemovedCount?: number;
  signals?: {
    maxRelevance: number;
    closestTerms: number | null;
    concrete: number;
    recognized: number;
    languages: Record<string, number>;
  };
  topics?: Record<string, number>;
  previews?: Passage[];
  additions?: number;
  revisions?: number;
  unchanged?: number;
  pair?: {
    prior: Filing | null;
    kind: string;
    reason: string;
    coverage?: {
      currentSections: { id: string; label: string }[];
      priorSections: { id: string; label: string }[];
    };
  };
  comparisonError?: string;
  sections?: { id: string; label: string }[];
  extraction?: string;
  matches?: Passage[];
  totalPassages?: number;
  page?: number;
  pageSize?: number;
  observedAt?: string;
};
export type CompanyScan = {
  ticker: string;
  cik?: string;
  companyName?: string;
  filings: Filing[];
  eligible?: number;
  selected?: number;
  reviewed?: number;
  fetchFailed?: number;
  sectionUnavailable?: number;
  matched?: number;
  limited?: boolean;
  historyLimited?: boolean;
  historyIssues?: string[];
  firstObserved?: string;
  observedAt?: string;
  checkedAt?: string;
  error?: string;
};
export type Evidence = {
  id: string;
  ticker: string;
  companyName: string;
  cik: string;
  accession: string;
  form: string;
  filingDate: string;
  reportDate: string;
  documentUrl: string;
  section: string;
  quote: string;
  priorQuote: string;
  comparisonAccession: string;
  change: string;
  languageLabel: string;
  labelReviewed: boolean;
  settings: SearchSettings;
  observedAt: string;
  notes: string;
  tags: string;
};
export type Collection = { id: string; name: string; items: Evidence[] };
export type SavedSearch = {
  id: string;
  name: string;
  settings: SearchSettings;
  seen: string[];
  createdAt: string;
  lastChecked: string;
  autoCheck: boolean;
  followLatest: boolean;
  inbox: (Filing & {
    id: string;
    reviewed: boolean;
    reason: string;
    discoveredAt: string;
  })[];
  lastCoverage?: {
    ticker: string;
    reviewed: number;
    failed: number;
    sectionUnavailable: number;
    limited: boolean;
    error: string;
  }[];
};
export type DisclosureNotebook = {
  version: number;
  searches: SavedSearch[];
  collections: Collection[];
  labels: Record<string, { label: string; reviewed: boolean }>;
};
export const queryParams = (settings: SearchSettings) =>
  new URLSearchParams({
    query: settings.query,
    start: settings.start,
    end: settings.end,
    forms: settings.forms,
    section: settings.section,
    scope: settings.scope,
    depth: String(settings.depth),
    amendments: String(settings.amendments),
  });
export const companyInputs = (value: string) => [
  ...new Set(
    value
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ),
];
