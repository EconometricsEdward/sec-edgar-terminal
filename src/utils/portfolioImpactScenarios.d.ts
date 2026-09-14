export type ImpactControl = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  description: string;
};
export type ImpactScenario = {
  id: string;
  label: string;
  description: string;
  category: string;
  metricLabel: string;
  ratioLabel: string;
  ratioUnit: string;
  impactLabel: string;
  metricDescription: string;
  controls: ImpactControl[];
  defaults: Record<string, number>;
};
export const IMPACT_SCENARIOS: readonly ImpactScenario[];
export type ImpactOptions = {
  scenarioId?: string;
  scope?: string;
  targetCik?: string;
  targetSector?: string;
  now?: number | string | Date;
  [key: string]: unknown;
};
export function buildPortfolioImpactScenarios(
  report: any,
  companies: any[],
  options?: ImpactOptions,
): {
  scenario: ImpactScenario;
  inputs: Record<string, number | null>;
  errors: string[];
  rows: any[];
  exclusions: any[];
  coverage: {
    includedCount: number;
    eligibleCount: number;
    modeledCount: number;
    excludedCount: number;
    unavailableCount: number;
    notApplicableCount: number;
    unresolvedCount: number;
    weighted: boolean;
    coveredWeightPct: number | null;
    excludedWeightPct: number | null;
    allocationLabel: string;
  };
  summary: {
    medianImpactPct: number | null;
    medianBeforeRatio: number | null;
    medianAfterRatio: number | null;
    enteredLossCount: number;
    alreadyNegativeCount: number;
    negativeAfterCount: number;
    recoveredCount: number;
    impactMeasuredCount: number;
    ratioMeasuredCount: number;
    enteredLossWeightPct: number | null;
    periodCount: number;
  };
  assumptions: string[];
};
