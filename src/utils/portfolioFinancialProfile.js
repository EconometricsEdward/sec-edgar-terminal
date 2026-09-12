import { canonicalPortfolioCik } from "./portfolioModel.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const VALID_LENSES = ["corporate", "banking", "insurance", "common"];
const RATIO_FORMATS = new Set(["percent", "decimal"]);
export const FINANCIAL_PROFILE_ALL_SECTORS = "all";
export const FINANCIAL_PROFILE_UNCOVERED_SECTOR = "Sector not covered";

export const FINANCIAL_PROFILE_LENSES = Object.freeze([
  Object.freeze({
    id: "corporate",
    label: "Operating companies",
    shortLabel: "Corporate",
    description:
      "Growth, margins, cash generation, reinvestment, liquidity and balance-sheet resilience for operating businesses.",
  }),
  Object.freeze({
    id: "banking",
    label: "Banks",
    shortLabel: "Banking",
    description:
      "Profitability, operating efficiency, deposit funding, credit reserves and capital measures designed for banking companies.",
  }),
  Object.freeze({
    id: "insurance",
    label: "Insurers",
    shortLabel: "Insurance",
    description:
      "Returns, capital structure and liquidity measures that remain comparable for insurance accounting models.",
  }),
  Object.freeze({
    id: "common",
    label: "Common / other financials",
    shortLabel: "Common",
    description:
      "A conservative set of broadly applicable returns, growth and balance-sheet measures for companies without a narrower lens.",
  }),
]);

const category = (id, label, description, metricIds) =>
  Object.freeze({ id, label, description, metricIds: Object.freeze(metricIds) });

export const FINANCIAL_PROFILE_CATEGORY_DEFINITIONS = Object.freeze({
  corporate: Object.freeze([
    category(
      "growth",
      "Growth",
      "Comparable change in the operating top line.",
      ["revenueGrowth"],
    ),
    category(
      "profitability",
      "Profitability & returns",
      "How effectively revenue and the asset base translate into company earnings.",
      [
        "grossMargin",
        "operatingMargin",
        "pretaxMargin",
        "netMargin",
        "roe",
        "roa",
        "effectiveTaxRate",
      ],
    ),
    category(
      "cash-generation",
      "Cash generation & reinvestment",
      "Operating cash conversion, free cash generation and investment intensity.",
      [
        "operatingCashFlowMargin",
        "freeCashFlowMargin",
        "cashConversion",
        "capexRevenue",
        "researchRevenue",
      ],
    ),
    category(
      "resilience",
      "Liquidity & resilience",
      "Near-term liquidity, capital, leverage and interest-servicing capacity.",
      [
        "currentRatio",
        "cashRatio",
        "cashAssets",
        "equityAssets",
        "debtAssets",
        "reportedDebtEquity",
        "liabilitiesAssets",
        "operatingInterestCoverage",
      ],
    ),
    category(
      "drivers",
      "Operating drivers",
      "Asset use and the components that connect margins, turnover and leverage to returns.",
      ["assetTurnover", "equityMultiplier", "dupontRoe"],
    ),
  ]),
  banking: Object.freeze([
    category(
      "profitability",
      "Profitability & returns",
      "Bank earnings, operating efficiency and returns on assets and equity.",
      ["bankNetMargin", "efficiency", "roe", "roa", "effectiveTaxRate"],
    ),
    category(
      "funding-credit",
      "Funding & credit",
      "Deposit funding, loan intensity, loss reserves and provision coverage.",
      ["loanDeposits", "allowanceLoans", "provisionLoans"],
    ),
    category(
      "capital-liquidity",
      "Capital & liquidity",
      "Reported equity, liabilities and cash relative to the bank asset base.",
      ["equityAssets", "liabilitiesAssets", "cashAssets"],
    ),
    category(
      "cash-conversion",
      "Cash conversion",
      "Operating cash flow relative to positive net income. This statement relationship is not a measure of bank liquidity or earnings quality.",
      ["cashConversion"],
    ),
    category(
      "drivers",
      "Return drivers",
      "Asset utilization and leverage components underlying reported returns.",
      ["assetTurnover", "equityMultiplier", "dupontRoe"],
    ),
  ]),
  insurance: Object.freeze([
    category(
      "returns",
      "Returns",
      "Reported profitability relative to the insurer asset and equity base.",
      ["roe", "roa", "effectiveTaxRate"],
    ),
    category(
      "capital",
      "Capital structure",
      "Equity, liabilities and selected reported debt relative to assets and equity.",
      [
        "equityAssets",
        "liabilitiesAssets",
        "debtAssets",
        "reportedDebtEquity",
      ],
    ),
    category(
      "liquidity",
      "Liquidity & cash conversion",
      "Reported cash relative to assets and operating cash relative to positive earnings.",
      ["cashAssets", "cashConversion"],
    ),
  ]),
  common: Object.freeze([
    category(
      "growth",
      "Growth",
      "Comparable revenue change where the common accounting lens supports it.",
      ["revenueGrowth"],
    ),
    category(
      "returns",
      "Returns",
      "Broadly comparable returns on reported assets and equity.",
      ["roe", "roa"],
    ),
    category(
      "capital-liquidity",
      "Capital & liquidity",
      "A conservative view of reported equity and cash relative to assets.",
      ["equityAssets", "cashAssets"],
    ),
  ]),
});

const PILLAR_DEFINITIONS = {
  corporate: [
    {
      id: "growth",
      label: "Growth",
      description: "Comparable revenue growth across operating holdings.",
      metricIds: ["revenueGrowth"],
    },
    {
      id: "profitability",
      label: "Profitability",
      description: "The earnings retained from each dollar of revenue.",
      metricIds: ["operatingMargin", "netMargin", "roe"],
    },
    {
      id: "cash-generation",
      label: "Cash generation",
      description: "Cash remaining after core operations and PP&E investment.",
      metricIds: [
        "freeCashFlowMargin",
        "operatingCashFlowMargin",
        "cashConversion",
      ],
    },
    {
      id: "resilience",
      label: "Balance-sheet resilience",
      description: "Near-term liquidity and capital support for the businesses.",
      metricIds: ["currentRatio", "equityAssets", "cashAssets"],
    },
  ],
  banking: [
    {
      id: "profitability",
      label: "Profitability",
      description: "Bank earnings retained from reported bank revenue.",
      metricIds: ["bankNetMargin", "roe", "roa"],
    },
    {
      id: "efficiency",
      label: "Operating efficiency",
      description: "Noninterest expense relative to bank revenue.",
      metricIds: ["efficiency"],
    },
    {
      id: "funding",
      label: "Deposit funding",
      description: "Reported net loans relative to the deposit base.",
      metricIds: ["loanDeposits"],
    },
    {
      id: "capital",
      label: "Capital",
      description: "Reported equity supporting the bank asset base.",
      metricIds: ["equityAssets"],
    },
  ],
  insurance: [
    {
      id: "equity-return",
      label: "Equity return",
      description: "Reported earnings relative to average equity.",
      metricIds: ["roe", "roa"],
    },
    {
      id: "capital",
      label: "Capital",
      description: "Reported equity supporting the insurer asset base.",
      metricIds: ["equityAssets", "liabilitiesAssets"],
    },
    {
      id: "liquidity",
      label: "Liquidity",
      description: "Reported cash relative to total assets.",
      metricIds: ["cashAssets"],
    },
    {
      id: "cash-conversion",
      label: "Cash conversion",
      description: "Operating cash flow relative to positive net income.",
      metricIds: ["cashConversion"],
    },
  ],
  common: [
    {
      id: "growth",
      label: "Growth",
      description: "Comparable revenue growth where available.",
      metricIds: ["revenueGrowth"],
    },
    {
      id: "equity-return",
      label: "Equity return",
      description: "Reported earnings relative to average equity.",
      metricIds: ["roe"],
    },
    {
      id: "asset-return",
      label: "Asset return",
      description: "Reported earnings relative to average assets.",
      metricIds: ["roa"],
    },
    {
      id: "capital",
      label: "Capital & liquidity",
      description: "Reported equity and cash relative to assets.",
      metricIds: ["equityAssets", "cashAssets"],
    },
  ],
};

const BREADTH_DEFINITIONS = [
  {
    id: "positive-revenue-growth",
    label: "Positive revenue growth",
    description: "Companies with comparable revenue growth above 0%.",
    metricId: "revenueGrowth",
    operator: "gt",
    threshold: 0,
    lenses: ["corporate", "common"],
  },
  {
    id: "positive-net-income",
    label: "Positive net income",
    description: "Companies reporting net income above zero.",
    metricId: "netIncome",
    operator: "gt",
    threshold: 0,
    lenses: VALID_LENSES,
  },
  {
    id: "positive-operating-cash-flow",
    label: "Positive operating cash flow",
    description: "Companies reporting cash generated by operations.",
    metricId: "operatingCashFlow",
    operator: "gt",
    threshold: 0,
    lenses: ["corporate", "common"],
  },
  {
    id: "positive-free-cash-flow",
    label: "Positive free cash flow",
    description: "Operating cash flow exceeds reported PP&E purchases.",
    metricId: "freeCashFlow",
    operator: "gt",
    threshold: 0,
    lenses: ["corporate", "common"],
  },
  {
    id: "positive-equity",
    label: "Positive reported equity",
    description: "Companies reporting stockholders’ equity above zero.",
    metricId: "stockholdersEquity",
    operator: "gt",
    threshold: 0,
    lenses: VALID_LENSES,
  },
  {
    id: "positive-return-on-assets",
    label: "Positive return on assets",
    description: "Companies with reported return on average assets above 0%.",
    metricId: "roa",
    operator: "gt",
    threshold: 0,
    lenses: VALID_LENSES,
  },
  {
    id: "positive-return-on-equity",
    label: "Positive return on equity",
    description: "Companies with reported return on average equity above 0%.",
    metricId: "roe",
    operator: "gt",
    threshold: 0,
    lenses: VALID_LENSES,
  },
  {
    id: "loans-within-deposits",
    label: "Net loans at or below deposits",
    description: "Banks with reported net loans no greater than deposits.",
    metricId: "loanDeposits",
    operator: "lte",
    threshold: 100,
    lenses: ["banking"],
  },
];

const ATTENTION_DEFINITIONS = [
  {
    id: "declining-revenue",
    label: "Declining revenue",
    description: "Comparable revenue growth is below 0%.",
    metricId: "revenueGrowth",
    operator: "lt",
    threshold: 0,
    lenses: ["corporate", "common"],
  },
  {
    id: "net-loss",
    label: "Net loss",
    description: "Reported net income is below zero.",
    metricId: "netIncome",
    operator: "lt",
    threshold: 0,
    lenses: VALID_LENSES,
  },
  {
    id: "negative-operating-cash-flow",
    label: "Negative operating cash flow",
    description: "Reported operating cash flow is below zero.",
    metricId: "operatingCashFlow",
    operator: "lt",
    threshold: 0,
    lenses: ["corporate", "common"],
  },
  {
    id: "negative-free-cash-flow",
    label: "Negative free cash flow",
    description: "Operating cash flow less reported PP&E purchases is negative.",
    metricId: "freeCashFlow",
    operator: "lt",
    threshold: 0,
    lenses: ["corporate", "common"],
  },
  {
    id: "negative-equity",
    label: "Negative reported equity",
    description: "Reported stockholders’ equity is below zero.",
    metricId: "stockholdersEquity",
    operator: "lt",
    threshold: 0,
    lenses: VALID_LENSES,
  },
  {
    id: "current-ratio-below-one",
    label: "Current ratio below 1x",
    description: "Reported current assets are below current liabilities.",
    metricId: "currentRatio",
    operator: "lt",
    threshold: 1,
    lenses: ["corporate"],
  },
  {
    id: "interest-coverage-below-two",
    label: "Operating interest coverage below 2x",
    description:
      "Reported operating income is less than two times positive reported interest expense.",
    metricId: "operatingInterestCoverage",
    operator: "lt",
    threshold: 2,
    lenses: ["corporate"],
  },
  {
    id: "negative-cash-after-returns",
    label: "Negative cash after PP&E and shareholder returns",
    description:
      "Operating cash flow less PP&E purchases, dividends and common share repurchases is negative.",
    metricId: "cashAfterReturns",
    operator: "lt",
    threshold: 0,
    lenses: ["corporate", "common"],
  },
  {
    id: "loans-above-deposits",
    label: "Net loans above deposits",
    description: "Reported net loans exceed reported deposits.",
    metricId: "loanDeposits",
    operator: "gt",
    threshold: 100,
    lenses: ["banking"],
  },
];

const lensDefinitionFor = (id) =>
  FINANCIAL_PROFILE_LENSES.find((definition) => definition.id === id);

/**
 * Resolve an externally requested measure to a business-model lens that can
 * actually display it. Prefer the current lens only when it has observations;
 * otherwise use the largest observed cohort, then the metric's declared lens.
 */
export function resolveFinancialProfileMetricLens(
  report,
  metricId,
  currentLens,
) {
  const current = lensDefinitionFor(currentLens) ? currentLens : null;
  const metric = (report?.metrics || []).find(
    (entry) => (entry?.id || entry?.key) === metricId,
  );
  if (!metric) return current;

  const observed = new Map();
  for (const row of metric.observations || []) {
    if (!finite(row?.value) || !lensDefinitionFor(row?.lens)) continue;
    const cohort = observed.get(row.lens) || { count: 0, weightPct: 0 };
    cohort.count += 1;
    if (finite(row.weightPct) && row.weightPct > 0)
      cohort.weightPct += row.weightPct;
    observed.set(row.lens, cohort);
  }
  if (current && observed.has(current)) return current;

  const bestObserved = [...observed.entries()].sort(
    ([lensA, a], [lensB, b]) =>
      b.count - a.count ||
      b.weightPct - a.weightPct ||
      VALID_LENSES.indexOf(lensA) - VALID_LENSES.indexOf(lensB),
  )[0]?.[0];
  if (bestObserved) return bestObserved;

  const applicable = (metric.lenses || []).filter((candidate) =>
    lensDefinitionFor(candidate),
  );
  if (current && applicable.includes(current)) return current;
  return applicable[0] || current;
}

const weightValue = (value) => finite(value) && value >= 0;
const stringValue = (value) => (typeof value === "string" ? value : "");
const unique = (values) => [...new Set(values)];
export const normalizeFinancialProfileSector = (value) =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : FINANCIAL_PROFILE_UNCOVERED_SECTOR;

function buildCompanyUniverse(report) {
  const rows = [...(report?.concentration?.issuers || [])]
    .filter(
      (row) =>
        row?.kind === "company" &&
        canonicalPortfolioCik(row.cik),
    )
    .sort((a, b) => {
      const cik = canonicalPortfolioCik(a.cik).localeCompare(
        canonicalPortfolioCik(b.cik),
      );
      if (cik) return cik;
      const lens =
        (VALID_LENSES.includes(a.lens)
          ? VALID_LENSES.indexOf(a.lens)
          : VALID_LENSES.length) -
        (VALID_LENSES.includes(b.lens)
          ? VALID_LENSES.indexOf(b.lens)
          : VALID_LENSES.length);
      if (lens) return lens;
      return `${a.lens}|${a.name || ""}|${(a.tickers || []).join("/")}`.localeCompare(
        `${b.lens}|${b.name || ""}|${(b.tickers || []).join("/")}`,
      );
    });
  const companies = new Map();
  for (const row of rows) {
    const cik = canonicalPortfolioCik(row.cik);
    const current = companies.get(cik);
    const hasWeight = report?.weighted && weightValue(row.weightPct);
    if (!current) {
      companies.set(cik, {
        cik,
        kind: "company",
        name: row.name || "",
        ticker: (row.tickers || []).join(" / "),
        tickers: unique(row.tickers || []).sort(),
        rowIds: unique(row.rowIds || []).sort(),
        lens: VALID_LENSES.includes(row.lens) ? row.lens : "unknown",
        industry: row.industry || "",
        sector: normalizeFinancialProfileSector(row.sector),
        sectorSource:
          row.sectorSource && typeof row.sectorSource === "object"
            ? { ...row.sectorSource }
            : null,
        weightPct: hasWeight ? row.weightPct : null,
        weightComplete:
          Boolean(report?.weighted) &&
          hasWeight &&
          row.weightComplete !== false,
      });
      continue;
    }
    const tickers = unique([...(current.tickers || []), ...(row.tickers || [])])
      .filter(Boolean)
      .sort();
    current.tickers = tickers;
    current.ticker = tickers.join(" / ");
    current.rowIds = unique([
      ...(current.rowIds || []),
      ...(row.rowIds || []),
    ]).sort();
    if (
      current.lens === "unknown" &&
      VALID_LENSES.includes(row.lens)
    )
      current.lens = row.lens;
    if (
      current.sector === FINANCIAL_PROFILE_UNCOVERED_SECTOR &&
      row.sector
    )
      current.sector = normalizeFinancialProfileSector(row.sector);
    if (!current.sectorSource && row.sectorSource)
      current.sectorSource = { ...row.sectorSource };
    if (hasWeight)
      current.weightPct = (weightValue(current.weightPct)
        ? current.weightPct
        : 0) + row.weightPct;
    current.weightComplete =
      current.weightComplete && hasWeight && row.weightComplete !== false;
  }
  return companies;
}

function weightSubtotal(ciks, universe, weighted) {
  if (!weighted) return null;
  if (!ciks.length) return 0;
  const weights = ciks
    .map((cik) => universe.get(cik)?.weightPct)
    .filter(weightValue);
  return weights.length ? weights.reduce((total, value) => total + value, 0) : null;
}

function observationPriority(a, b) {
  const periodEnd = stringValue(b.periodEnd || b.period?.end).localeCompare(
    stringValue(a.periodEnd || a.period?.end),
  );
  if (periodEnd) return periodEnd;
  const periodKey = stringValue(b.periodKey).localeCompare(
    stringValue(a.periodKey),
  );
  if (periodKey) return periodKey;
  const source = stringValue(a.sourceUrl).localeCompare(stringValue(b.sourceUrl));
  if (source) return source;
  const row = stringValue(a.rowId).localeCompare(stringValue(b.rowId));
  if (row) return row;
  const value = (finite(a.value) ? a.value : 0) - (finite(b.value) ? b.value : 0);
  if (value) return value;
  return `${a.ticker || ""}|${a.name || ""}`.localeCompare(
    `${b.ticker || ""}|${b.name || ""}`,
  );
}

function metricRows(metric, lens, universe, weighted) {
  const candidates = [];
  for (const source of metric?.observations || []) {
    const cik = canonicalPortfolioCik(source?.cik);
    const company = cik ? universe.get(cik) : null;
    if (!company || company.lens !== lens || !finite(source?.value)) continue;
    candidates.push({
      ...source,
      cik,
      name: source.name || company.name,
      ticker: source.ticker || company.ticker,
      tickers: company.tickers,
      rowIds: company.rowIds,
      lens: company.lens,
      industry: source.industry || company.industry,
      sector: source.sector || company.sector,
      weightPct: weighted ? company.weightPct : null,
      weightComplete: weighted ? company.weightComplete : false,
    });
  }
  candidates.sort(
    (a, b) =>
      a.cik.localeCompare(b.cik) || observationPriority(a, b),
  );
  const rows = [];
  let priorCik = null;
  for (const row of candidates) {
    if (row.cik === priorCik) continue;
    rows.push(row);
    priorCik = row.cik;
  }
  return rows.sort((a, b) => a.value - b.value || a.cik.localeCompare(b.cik));
}

function selectedSet(values, selectedCiks) {
  return new Set(
    (values || [])
      .map(canonicalPortfolioCik)
      .filter((cik) => cik && selectedCiks.has(cik)),
  );
}

function metricCoverage(metric, rows, selectedCiks) {
  const measured = new Set(rows.map((row) => row.cik));
  const eligible = selectedSet(metric?.eligibleCiks, selectedCiks);
  for (const cik of measured) eligible.add(cik);
  const notApplicable = selectedSet(metric?.notApplicableCiks, selectedCiks);
  for (const cik of eligible) notApplicable.delete(cik);
  const missing = new Set([...eligible].filter((cik) => !measured.has(cik)));
  const classified = new Set([...eligible, ...notApplicable]);
  return {
    measured,
    eligible,
    missing,
    notApplicable,
    unclassified: new Set(
      [...selectedCiks].filter((cik) => !classified.has(cik)),
    ),
  };
}

function quantile(sorted, percentile) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    sorted[lower] +
    (sorted[upper] - sorted[lower]) * (position - lower)
  );
}

function weightedStatistics(rows, weighted) {
  if (!weighted)
    return {
      weightedCompanyCount: 0,
      weightedMean: null,
      weightedMedian: null,
      weightedAllocationPct: null,
    };
  const weightedRows = rows
    .filter((row) => weightValue(row.weightPct) && row.weightPct > 0)
    .sort((a, b) => a.value - b.value || a.cik.localeCompare(b.cik));
  const allocation = weightedRows.reduce(
    (total, row) => total + row.weightPct,
    0,
  );
  if (!allocation)
    return {
      weightedCompanyCount: 0,
      weightedMean: null,
      weightedMedian: null,
      weightedAllocationPct: 0,
    };
  const weightedMean =
    weightedRows.reduce(
      (total, row) => total + row.value * row.weightPct,
      0,
    ) / allocation;
  let cumulative = 0;
  let weightedMedian = null;
  for (const row of weightedRows) {
    cumulative += row.weightPct;
    if (cumulative >= allocation / 2) {
      weightedMedian = row.value;
      break;
    }
  }
  return {
    weightedCompanyCount: weightedRows.length,
    weightedMean,
    weightedMedian,
    weightedAllocationPct: allocation,
  };
}

function periodSummaries(rows, universe, weighted) {
  const groups = new Map();
  for (const row of rows) {
    const periodKey = stringValue(row.periodKey);
    if (!periodKey) continue;
    const group = groups.get(periodKey) || {
      periodKey,
      kind: row.period?.kind || null,
      start: row.period?.start || null,
      end: row.periodEnd || row.period?.end || null,
      ciks: [],
    };
    group.ciks.push(row.cik);
    groups.set(periodKey, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      ciks: unique(group.ciks).sort(),
      companyCount: unique(group.ciks).length,
      knownWeightPct: weightSubtotal(
        unique(group.ciks),
        universe,
        weighted,
      ),
    }))
    .sort(
      (a, b) =>
        stringValue(a.end).localeCompare(stringValue(b.end)) ||
        a.periodKey.localeCompare(b.periodKey),
    );
}

function histogramFor(rows) {
  if (!rows.length) return { min: null, max: null, bins: [] };
  const min = rows[0].value;
  const max = rows[rows.length - 1].value;
  if (min === max)
    return {
      min,
      max,
      bins: [
        {
          index: 0,
          min,
          max,
          upperInclusive: true,
          count: rows.length,
          ciks: rows.map((row) => row.cik),
          rows: [...rows],
        },
      ],
    };
  const binCount = Math.min(8, Math.ceil(Math.sqrt(rows.length)));
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    index,
    min: min + width * index,
    max: index === binCount - 1 ? max : min + width * (index + 1),
    upperInclusive: index === binCount - 1,
    count: 0,
    ciks: [],
    rows: [],
  }));
  for (const row of rows) {
    const index =
      row.value === max
        ? binCount - 1
        : Math.min(binCount - 1, Math.floor((row.value - min) / width));
    bins[index].count++;
    bins[index].ciks.push(row.cik);
    bins[index].rows.push(row);
  }
  return { min, max, bins };
}

function formulaFor(metric, rows) {
  if (metric?.formula) return metric.formula;
  for (const row of rows) {
    if (row.definition && typeof row.definition === "object") {
      if (row.definition.formula) return row.definition.formula;
      continue;
    }
    try {
      const parsed = JSON.parse(row.definition || "null");
      if (parsed?.formula) return parsed.formula;
    } catch {
      // A malformed optional definition must not hide an otherwise valid ratio.
    }
  }
  return null;
}

function profileCategoryFor(lens, metricId) {
  return (
    FINANCIAL_PROFILE_CATEGORY_DEFINITIONS[lens].find((entry) =>
      entry.metricIds.includes(metricId),
    )?.id || "other"
  );
}

function summarizeMetric(metric, lens, universe, weighted) {
  const selectedCiks = new Set(
    [...universe.values()]
      .filter((company) => company.lens === lens)
      .map((company) => company.cik),
  );
  const observations = metricRows(metric, lens, universe, weighted);
  const coverage = metricCoverage(metric, observations, selectedCiks);
  const values = observations.map((row) => row.value);
  const weights = weightedStatistics(observations, weighted);
  const periods = periodSummaries(observations, universe, weighted);
  return {
    id: metric.id || metric.key,
    key: metric.key || metric.id,
    label: metric.label,
    category: profileCategoryFor(lens, metric.id || metric.key),
    sourceCategory: metric.category || null,
    unit: metric.unit,
    format: metric.format,
    formula: formulaFor(metric, observations),
    observations,
    availableCount: observations.length,
    measuredCompanyCount: observations.length,
    eligibleCompanyCount: coverage.eligible.size,
    companyCoveragePct: coverage.eligible.size
      ? (observations.length / coverage.eligible.size) * 100
      : null,
    missingCompanyCount: coverage.missing.size,
    notApplicableCompanyCount: coverage.notApplicable.size,
    unclassifiedCompanyCount: coverage.unclassified.size,
    coveredWeightPct: weightSubtotal(
      [...coverage.measured],
      universe,
      weighted,
    ),
    eligibleWeightPct: weightSubtotal(
      [...coverage.eligible],
      universe,
      weighted,
    ),
    missingWeightPct: weightSubtotal(
      [...coverage.missing],
      universe,
      weighted,
    ),
    weightCoverageComplete:
      !weighted ||
      observations.every(
        (row) => weightValue(row.weightPct) && row.weightComplete,
      ),
    ...weights,
    unweightedMean: values.length
      ? values.reduce((total, value) => total + value, 0) / values.length
      : null,
    median: quantile(values, 0.5),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    p10: quantile(values, 0.1),
    p90: quantile(values, 0.9),
    min: values.length ? values[0] : null,
    max: values.length ? values[values.length - 1] : null,
    periods,
    histogram: histogramFor(observations),
  };
}

function screenMatches(value, operator, threshold) {
  if (operator === "gt") return value > threshold;
  if (operator === "gte") return value >= threshold;
  if (operator === "lt") return value < threshold;
  if (operator === "lte") return value <= threshold;
  return false;
}

function buildScreen(definition, lens, metricById, universe, weighted) {
  const metric = metricById.get(definition.metricId);
  const selectedCiks = new Set(
    [...universe.values()]
      .filter((company) => company.lens === lens)
      .map((company) => company.cik),
  );
  const observations = metricRows(metric, lens, universe, weighted);
  const coverage = metricCoverage(metric, observations, selectedCiks);
  const rows = observations
    .filter((row) =>
      screenMatches(row.value, definition.operator, definition.threshold),
    )
    .sort(
      (a, b) => {
        if (weighted)
          return (
            (b.weightPct ?? -1) - (a.weightPct ?? -1) ||
            a.cik.localeCompare(b.cik)
          );
        const severity = ["lt", "lte"].includes(definition.operator)
          ? a.value - b.value
          : b.value - a.value;
        return severity || a.cik.localeCompare(b.cik);
      },
    );
  const measuredWeightPct = weightSubtotal(
    [...coverage.measured],
    universe,
    weighted,
  );
  const matchedWeightPct = weightSubtotal(
    rows.map((row) => row.cik),
    universe,
    weighted,
  );
  const measuredCompanyCount = observations.length;
  const eligibleCompanyCount = coverage.eligible.size;
  const evidenceStatus = !measuredCompanyCount
    ? "unavailable"
    : measuredCompanyCount < eligibleCompanyCount
      ? "partial"
      : "complete";
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    metricId: definition.metricId,
    operator: definition.operator,
    threshold: definition.threshold,
    unit: metric?.unit || null,
    applicable: definition.lenses.includes(lens),
    measuredCompanyCount,
    eligibleCompanyCount,
    missingCompanyCount: coverage.missing.size,
    notApplicableCompanyCount: coverage.notApplicable.size,
    matchedCompanyCount: rows.length,
    measuredWeightPct,
    eligibleWeightPct: weightSubtotal(
      [...coverage.eligible],
      universe,
      weighted,
    ),
    matchedWeightPct,
    shareOfMeasuredCompaniesPct: measuredCompanyCount
      ? (rows.length / measuredCompanyCount) * 100
      : null,
    shareOfMeasuredWeightPct:
      finite(measuredWeightPct) &&
      measuredWeightPct > 0 &&
      finite(matchedWeightPct)
        ? (matchedWeightPct / measuredWeightPct) * 100
        : null,
    evidenceStatus,
    limitedEvidence: evidenceStatus !== "complete",
    rows,
  };
}

const FINGERPRINT_QUADRANTS = [
  {
    id: "profitable-growth",
    label: "Profitable growth",
    description: "Nonnegative revenue growth and net margin.",
  },
  {
    id: "profitable-contraction",
    label: "Profitable contraction",
    description: "Negative revenue growth with a nonnegative net margin.",
  },
  {
    id: "loss-making-growth",
    label: "Loss-making growth",
    description: "Nonnegative revenue growth with a negative net margin.",
  },
  {
    id: "loss-making-contraction",
    label: "Loss-making contraction",
    description: "Negative revenue growth and net margin.",
  },
];

function fingerprintQuadrant(growth, margin) {
  if (growth >= 0 && margin >= 0) return "profitable-growth";
  if (growth < 0 && margin >= 0) return "profitable-contraction";
  if (growth >= 0 && margin < 0) return "loss-making-growth";
  return "loss-making-contraction";
}

function buildCorporateFingerprint(lens, metricById, universe, weighted) {
  const applicable = lens === "corporate";
  const companies = [...universe.values()].filter(
    (company) => applicable && company.lens === "corporate",
  );
  const maps = Object.fromEntries(
    ["revenueGrowth", "netMargin", "freeCashFlow"].map((metricId) => [
      metricId,
      new Map(
        metricRows(metricById.get(metricId), "corporate", universe, weighted).map(
          (row) => [row.cik, row],
        ),
      ),
    ]),
  );
  const points = [];
  let missingMetricCompanyCount = 0;
  let periodMismatchCompanyCount = 0;
  for (const company of companies) {
    const growth = maps.revenueGrowth.get(company.cik);
    const margin = maps.netMargin.get(company.cik);
    const freeCashFlow = maps.freeCashFlow.get(company.cik);
    if (!growth || !margin) {
      missingMetricCompanyCount++;
      continue;
    }
    if (
      !growth.periodKey ||
      growth.periodKey !== margin.periodKey
    ) {
      periodMismatchCompanyCount++;
      continue;
    }
    const alignedFreeCashFlow =
      freeCashFlow?.periodKey === growth.periodKey ? freeCashFlow : null;
    points.push({
      cik: company.cik,
      rowId: growth.rowId || company.rowIds[0],
      ticker: growth.ticker || company.ticker,
      name: growth.name || company.name,
      sector: growth.sector || company.sector,
      industry: growth.industry || company.industry,
      weightPct: weighted ? company.weightPct : null,
      x: growth.value,
      y: margin.value,
      freeCashFlow: alignedFreeCashFlow?.value ?? null,
      tone:
        alignedFreeCashFlow?.value > 0
          ? "positive"
          : alignedFreeCashFlow?.value < 0
            ? "negative"
            : "neutral",
      quadrant: fingerprintQuadrant(growth.value, margin.value),
      periodKey: growth.periodKey,
      period: growth.period,
      sourceUrls: unique(
        [growth.sourceUrl, margin.sourceUrl, alignedFreeCashFlow?.sourceUrl].filter(Boolean),
      ).sort(),
    });
  }
  points.sort((a, b) => a.cik.localeCompare(b.cik));
  const quadrants = FINGERPRINT_QUADRANTS.map((definition) => {
    const quadrantPoints = points.filter(
      (point) => point.quadrant === definition.id,
    );
    return {
      ...definition,
      companyCount: quadrantPoints.length,
      knownWeightPct: weightSubtotal(
        quadrantPoints.map((point) => point.cik),
        universe,
        weighted,
      ),
      ciks: quadrantPoints.map((point) => point.cik),
    };
  });
  const fcfRows = (tone) => points.filter((point) => point.tone === tone);
  return {
    applicable,
    axes: {
      x: { metricId: "revenueGrowth", label: "Revenue growth", unit: "%" },
      y: { metricId: "netMargin", label: "Net margin", unit: "%" },
      tone: {
        metricId: "freeCashFlow",
        label: "Free cash flow sign",
        unit: "USD",
      },
    },
    eligibleCompanyCount: companies.length,
    pairedCompanyCount: points.length,
    companyCoveragePct: companies.length
      ? (points.length / companies.length) * 100
      : null,
    knownWeightPct: weightSubtotal(
      points.map((point) => point.cik),
      universe,
      weighted,
    ),
    missingMetricCompanyCount,
    periodMismatchCompanyCount,
    points,
    quadrants,
    fcfCounts: {
      positive: fcfRows("positive").length,
      negative: fcfRows("negative").length,
      neutral: fcfRows("neutral").length,
    },
  };
}

function topLevelPeriodRange(metricSummaries) {
  const periods = new Map();
  for (const metric of metricSummaries)
    for (const period of metric.periods)
      if (!periods.has(period.periodKey)) periods.set(period.periodKey, period);
  const values = [...periods.values()].sort(
    (a, b) =>
      stringValue(a.end).localeCompare(stringValue(b.end)) ||
      a.periodKey.localeCompare(b.periodKey),
  );
  const starts = values.map((period) => period.start).filter(Boolean).sort();
  const ends = values.map((period) => period.end).filter(Boolean).sort();
  return {
    earliestStart: starts[0] || null,
    earliestEnd: ends[0] || null,
    latestEnd: ends.at(-1) || null,
    periodCount: values.length,
    periodKeys: values.map((period) => period.periodKey),
  };
}

function profileCoverage(universe, weighted) {
  const resolved = [...universe.values()];
  const profiled = resolved.filter((company) =>
    VALID_LENSES.includes(company.lens),
  );
  const unknownLens = resolved.filter((company) => company.lens === "unknown");
  return {
    profiledCompanyCount: profiled.length,
    profiledKnownWeightPct: weightSubtotal(
      profiled.map((company) => company.cik),
      universe,
      weighted,
    ),
    unknownLensCompanyCount: unknownLens.length,
    unknownLensKnownWeightPct: weightSubtotal(
      unknownLens.map((company) => company.cik),
      universe,
      weighted,
    ),
    totalResolvedCompanyCount: resolved.length,
    totalResolvedCompanyKnownWeightPct: weightSubtotal(
      resolved.map((company) => company.cik),
      universe,
      weighted,
    ),
  };
}

function excludedIssuerSummary(report, weighted, universe) {
  const issuers = report?.concentration?.issuers || [];
  const funds = issuers.filter((issuer) => issuer.kind === "fund");
  const unresolved = issuers.filter(
    (issuer) => issuer.kind !== "fund" && issuer.kind !== "company",
  );
  const unknownLens = [...universe.values()].filter(
    (company) => company.lens === "unknown",
  );
  const rawWeight = (rows) => {
    if (!weighted) return null;
    const weights = rows.map((row) => row.weightPct).filter(weightValue);
    return weights.length ? weights.reduce((total, value) => total + value, 0) : null;
  };
  return {
    fundCount: finite(report?.fundCount) ? report.fundCount : funds.length,
    unresolvedCount: finite(report?.unresolvedCount)
      ? report.unresolvedCount
      : unresolved.reduce(
          (total, issuer) => total + Math.max(1, issuer.rowIds?.length || 0),
          0,
        ),
    fundKnownWeightPct: rawWeight(funds),
    unresolvedKnownWeightPct: rawWeight(unresolved),
    unknownLensCompanyCount: unknownLens.length,
    unknownLensKnownWeightPct: weightSubtotal(
      unknownLens.map((company) => company.cik),
      universe,
      weighted,
    ),
    unknownLensCiks: unknownLens.map((company) => company.cik).sort(),
  };
}

/**
 * Build a portfolio financial profile from the output of buildCatalogReport.
 * Ratios remain company observations. Supplied allocation is used only for
 * coverage and weighted company statistics; it is never rewritten to 100%.
 */
export function buildPortfolioFinancialProfile(catalogReport, options = {}) {
  const report = catalogReport || {};
  const weighted = report.weighted === true;
  const universe = buildCompanyUniverse(report);
  const sectorRows = [...universe.values()];
  const sectorGroup = (id, label, companies) => {
    const sourceDates = unique(
      companies
        .map((company) => company.sectorSource?.asOf)
        .filter(Boolean),
    ).sort();
    const sourceProviders = unique(
      companies
        .map((company) => company.sectorSource?.provider)
        .filter(Boolean),
    ).sort();
    const sourceCompanyCount = companies.filter(
      (company) => company.sectorSource,
    ).length;
    return {
      id,
      label,
      companyCount: companies.length,
      companySharePct: sectorRows.length
        ? (companies.length / sectorRows.length) * 100
        : null,
      knownWeightPct: weightSubtotal(
        companies.map((company) => company.cik),
        universe,
        weighted,
      ),
      lensCount: new Set(
        companies
          .map((company) => company.lens)
          .filter((lens) => VALID_LENSES.includes(lens)),
      ).size,
      sectorSourceAsOf:
        sourceCompanyCount === companies.length && sourceDates.length === 1
          ? sourceDates[0]
          : null,
      sectorSourceEarliestAsOf: sourceDates[0] || null,
      sectorSourceLatestAsOf: sourceDates.at(-1) || null,
      sectorSourceCompanyCount: sourceCompanyCount,
      sectorSourceProviders: sourceProviders,
    };
  };
  const sectorGroups = [
    sectorGroup(FINANCIAL_PROFILE_ALL_SECTORS, "All sectors", sectorRows),
    ...[...new Set(sectorRows.map((company) => company.sector))]
      .map((sector) => {
        const companies = sectorRows.filter(
          (company) => company.sector === sector,
        );
        return sectorGroup(sector, sector, companies);
      })
      .sort((a, b) => {
        if (a.id === FINANCIAL_PROFILE_UNCOVERED_SECTOR) return 1;
        if (b.id === FINANCIAL_PROFILE_UNCOVERED_SECTOR) return -1;
        const primary = weighted
          ? Math.round((b.knownWeightPct ?? -1) * 1_000_000) -
            Math.round((a.knownWeightPct ?? -1) * 1_000_000)
          : b.companyCount - a.companyCount;
        return primary || b.companyCount - a.companyCount || a.label.localeCompare(b.label);
      }),
  ];
  const requestedSector = stringValue(options?.sector);
  const sector = sectorGroups.some((group) => group.id === requestedSector)
    ? requestedSector
    : FINANCIAL_PROFILE_ALL_SECTORS;
  const sectorUniverse = new Map(
    [...universe].filter(
      ([, company]) =>
        sector === FINANCIAL_PROFILE_ALL_SECTORS || company.sector === sector,
    ),
  );
  const lensGroups = FINANCIAL_PROFILE_LENSES.map((definition) => {
    const companies = [...sectorUniverse.values()].filter(
      (company) => company.lens === definition.id,
    );
    const selectedCiks = new Set(companies.map((company) => company.cik));
    const availableRatioMeasureCount = (report.metrics || []).filter(
      (metric) =>
        RATIO_FORMATS.has(metric.format) &&
        (metric.observations || []).some((observation) => {
          const cik = canonicalPortfolioCik(observation.cik);
          return cik && selectedCiks.has(cik) && finite(observation.value);
        }),
    ).length;
    return {
      ...definition,
      companyCount: companies.length,
      companySharePct: sectorUniverse.size
        ? (companies.length / sectorUniverse.size) * 100
        : null,
      knownWeightPct: weightSubtotal(
        companies.map((company) => company.cik),
        sectorUniverse,
        weighted,
      ),
      availableRatioMeasureCount,
    };
  });
  const requestedLens = options?.lens;
  const hasCompatibleCohort = lensGroups.some(
    (group) => group.companyCount > 0,
  );
  const lens = lensDefinitionFor(requestedLens) &&
    lensGroups.some(
      (group) => group.id === requestedLens && group.companyCount > 0,
    )
    ? requestedLens
    : [...lensGroups].sort(
        (a, b) =>
          b.companyCount - a.companyCount ||
          VALID_LENSES.indexOf(a.id) - VALID_LENSES.indexOf(b.id),
      )[0]?.id || "corporate";
  const lensDefinition = lensDefinitionFor(lens);
  const selectedCompanies = [...sectorUniverse.values()].filter(
    (company) => company.lens === lens,
  );
  const selectedUniverse = new Map(
    selectedCompanies.map((company) => [company.cik, company]),
  );
  const metricById = new Map(
    (report.metrics || []).map((metric) => [metric.id || metric.key, metric]),
  );
  const metricSummaries = (report.metrics || [])
    .filter((metric) => RATIO_FORMATS.has(metric.format))
    .map((metric) => summarizeMetric(metric, lens, selectedUniverse, weighted))
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    );
  const summaryById = new Map(
    metricSummaries.map((summary) => [summary.id, summary]),
  );
  const measuredCiks = unique(
    metricSummaries.flatMap((metric) =>
      metric.observations.map((observation) => observation.cik),
    ),
  ).sort();
  const categories = FINANCIAL_PROFILE_CATEGORY_DEFINITIONS[lens].map(
    (definition) => ({
      ...definition,
      metrics: definition.metricIds
        .map((metricId) => summaryById.get(metricId))
        .filter(Boolean),
    }),
  );
  const featuredPillars = PILLAR_DEFINITIONS[lens].map((definition) => {
    const metric =
      definition.metricIds
        .map((metricId) => summaryById.get(metricId))
        .find((summary) => summary?.measuredCompanyCount > 0) ||
      definition.metricIds
        .map((metricId) => summaryById.get(metricId))
        .find(Boolean) ||
      null;
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      metricId: metric?.id || definition.metricIds[0],
      metric,
    };
  });
  const breadthScreens = BREADTH_DEFINITIONS.filter((definition) =>
    definition.lenses.includes(lens),
  ).map((definition) =>
    buildScreen(definition, lens, metricById, selectedUniverse, weighted),
  );
  const attentionConditions = ATTENTION_DEFINITIONS.filter((definition) =>
    definition.lenses.includes(lens),
  ).map((definition) =>
    buildScreen(definition, lens, metricById, selectedUniverse, weighted),
  ).sort((a, b) => {
    const aRank = weighted
      ? a.matchedWeightPct ?? -1
      : a.shareOfMeasuredCompaniesPct ?? -1;
    const bRank = weighted
      ? b.matchedWeightPct ?? -1
      : b.shareOfMeasuredCompaniesPct ?? -1;
    return bRank - aRank || a.id.localeCompare(b.id);
  });
  return {
    sector,
    sectorDefinition: sectorGroups.find((group) => group.id === sector),
    sectorGroups,
    lens,
    lensDefinition,
    lensGroups,
    hasCompatibleCohort,
    weighted,
    coverage: profileCoverage(sectorUniverse, weighted),
    sectorCompanyCount: sectorUniverse.size,
    sectorKnownWeightPct: weightSubtotal(
      [...sectorUniverse.keys()],
      sectorUniverse,
      weighted,
    ),
    companyCount: selectedCompanies.length,
    companyCiks: [...selectedUniverse.keys()].sort(),
    measuredCompanyCount: measuredCiks.length,
    measuredCompanySharePct: selectedCompanies.length
      ? (measuredCiks.length / selectedCompanies.length) * 100
      : null,
    measuredWeightPct: weightSubtotal(measuredCiks, universe, weighted),
    metricCount: metricSummaries.filter(
      (summary) => summary.measuredCompanyCount > 0,
    ).length,
    periodRange: topLevelPeriodRange(metricSummaries),
    metricSummaries,
    categories,
    featuredPillars,
    breadthScreens,
    attentionConditions,
    corporateFingerprint: buildCorporateFingerprint(
      lens,
      metricById,
      selectedUniverse,
      weighted,
    ),
    exclusions: excludedIssuerSummary(report, weighted, sectorUniverse),
  };
}
