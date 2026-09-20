export type SharedChatPortfolio = { kind: 'portfolio'; holdings: { ticker: string; weight: number | null }[]; totalHoldings: number; coverageWeight: number | null };
export type SharedChatScenario = { kind: 'analysis-scenario'; ticker: string; basis: 'annual' | 'quarter' | 'ttm' | 'ytd'; end: string; asOf: string; assumptions: Record<string, number | string> };
export type SharedChatContext = SharedChatPortfolio | SharedChatScenario;
export function normalizeSharedChatContext(value: unknown): SharedChatContext | null;
export function buildSharedPortfolio(rows: unknown[], summary: unknown): SharedChatPortfolio | null;
