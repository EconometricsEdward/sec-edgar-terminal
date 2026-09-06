import {
  buildCompareCompany,
  COMPARE_METRICS,
  defaultMetrics,
} from "./compareResearch.js";
import {
  buildIncomeStatement,
  buildBalanceSheet,
  buildCashFlow,
  buildMetricRow,
} from "./xbrlParser.js";
import {
  selectFinancialFact,
  daysBetween,
  sourceDocumentUrl,
  FINANCIAL_DATA_VERSION,
} from "./xbrlPeriods.js";
import { evidenceSources, evidenceCalculations } from "./researchEvidence.js";

export const ANALYSIS_VERSION = `analysis-v1:${FINANCIAL_DATA_VERSION}`;
const finite = (p) => Number.isFinite(p?.value);
const missing = (
  period,
  reason = "A required reported input is unavailable. Missing values are never assumed to be zero.",
) => ({
  period,
  value: null,
  classification: "unavailable",
  reason,
  sources: [],
});
const previousDay = (date) =>
  new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);

export function calculateAnalysisPoint(period, inputs, formula, compute) {
  if (!inputs.every(finite)) return missing(period);
  const value = compute(...inputs.map((p) => p.value));
  if (!Number.isFinite(value))
    return missing(
      period,
      "The calculation requires a positive denominator and compatible reporting dates.",
    );
  return {
    period,
    value,
    formula,
    classification: "calculated",
    sources: inputs.flatMap(evidenceSources),
    calculations: inputs.flatMap((p) => [
      ...evidenceCalculations(p),
      ...(p.formula
        ? [
            {
              formula: p.formula,
              value: p.value,
              start: p.period?.start,
              end: p.period?.end,
            },
          ]
        : []),
    ]),
  };
}

/** Financial statements and diagnostics share one period and one filing cutoff. */
export function buildAnalysisCompany(company, settings = {}) {
  const comparison = buildCompareCompany(company, settings);
  const { periods, lens } = comparison;
  const industry = lens === "banking" ? "banking" : company.sic;
  const metrics = {};
  const definitions = {};
  function add(row, category, extra = {}) {
    definitions[row.key] = {
      key: row.key,
      label: row.label,
      format: row.format || "currency",
      category,
      ...extra,
    };
    metrics[row.key] = row.values;
  }
  for (const [category, build] of [
    ["income", buildIncomeStatement],
    ["balance", buildBalanceSheet],
    ["cashflow", buildCashFlow],
  ]) {
    for (const row of build(company.facts, periods, company.sic)) {
      if (
        lens === "banking" &&
        [
          "revenue",
          "costOfRevenue",
          "grossProfit",
          "rnd",
          "sga",
          "operatingIncome",
          "currentAssets",
          "currentLiabilities",
          "inventory",
          "receivables",
          "accountsPayable",
        ].includes(row.key)
      )
        continue;
      if (
        lens === "insurance" &&
        [
          "revenue",
          "costOfRevenue",
          "grossProfit",
          "rnd",
          "inventory",
        ].includes(row.key)
      )
        continue;
      add(row, category);
    }
  }
  for (const metric of COMPARE_METRICS.filter((m) => m.lenses.includes(lens))) {
    if (!definitions[metric.key])
      add(
        { ...metric, values: comparison.metrics[metric.key] },
        metric.inputs && metric.format !== "currency"
          ? "ratios"
          : ["deposits", "loans"].includes(metric.key)
            ? "balance"
            : metric.key === "freeCashFlow"
              ? "cashflow"
              : "income",
        { formula: metric.formula },
      );
  }
  if (lens === "banking") {
    for (const [key, label, category] of [
      ["noninterestExpense", "Noninterest expense", "income"],
      ["provisionForLoanLoss", "Provision for credit losses", "income"],
      ["allowanceForLoanLoss", "Allowance for credit losses", "balance"],
    ])
      add(
        buildMetricRow(
          company.facts,
          key,
          label,
          periods,
          "currency",
          industry,
        ),
        category,
      );
  }
  // Consolidated balance equation avoids mixing parent equity with noncontrolling interests.
  const tagged = (key, label, tags) =>
    add(
      {
        key,
        label,
        values: periods.map((p) => ({
          period: p,
          ...(selectFinancialFact(company.facts, tags, p) || missing(p)),
        })),
      },
      "checks",
    );
  tagged("liabilitiesAndEquity", "Reported liabilities and equity", [
    "LiabilitiesAndStockholdersEquity",
  ]);
  tagged("cashFlowChange", "Reported change in cash, including FX", [
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect",
    "CashAndCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect",
  ]);
  tagged("fxCash", "Effect of exchange rates on cash", [
    "EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    "EffectOfExchangeRateOnCashAndCashEquivalents",
  ]);
  const derive = (
    key,
    label,
    inputs,
    formula,
    compute,
    category = "ratios",
    format = "percent",
  ) =>
    add(
      {
        key,
        label,
        format,
        values: periods.map((p, i) =>
          calculateAnalysisPoint(
            p,
            inputs.map((k) => metrics[k]?.[i]),
            formula,
            compute,
          ),
        ),
      },
      category,
      { formula },
    );
  const revenueKey =
    lens === "banking"
      ? "bankRevenue"
      : lens === "insurance"
        ? null
        : "revenue";
  if (lens === "banking")
    derive(
      "bankNetMargin",
      "Net income / bank revenue",
      ["netIncome", "bankRevenue"],
      "Net income / (net interest income before provision + noninterest income) × 100",
      (a, b) => (b > 0 ? (a / b) * 100 : null),
    );
  if (lens === "corporate")
    derive(
      "grossMargin",
      "Gross margin",
      ["grossProfit", "revenue"],
      "Reported gross profit / revenue × 100",
      (a, b) => (b > 0 ? (a / b) * 100 : null),
    );
  derive(
    "cashConversion",
    "Operating cash flow / net income",
    ["operatingCashFlow", "netIncome"],
    "Operating cash flow / positive net income × 100",
    (a, b) => (b > 0 ? (a / b) * 100 : null),
  );
  derive(
    "cashAdjustments",
    "Noncash items and working capital, net",
    ["operatingCashFlow", "netIncome"],
    "Operating cash flow − net income; residual, not an attribution to individual causes",
    (a, b) => a - b,
    "cashflow",
    "currency",
  );
  if (!metrics.freeCashFlow)
    derive(
      "freeCashFlow",
      "Operating cash flow less PP&E purchases",
      ["operatingCashFlow", "capex"],
      "Operating cash flow − purchases of property, plant and equipment; limited usefulness for financial institutions",
      (a, b) => a - b,
      "cashflow",
      "currency",
    );
  derive(
    "cashReturned",
    "Dividends + common share repurchases",
    ["dividendsPaid", "stockRepurchased"],
    "Reported dividends + common share repurchases; both components required",
    (a, b) => a + b,
    "cashflow",
    "currency",
  );
  derive(
    "cashAfterReturns",
    "Cash after PP&E and shareholder returns",
    ["freeCashFlow", "dividendsPaid", "stockRepurchased"],
    "Operating cash flow − PP&E purchases − dividends − common share repurchases; excludes other investing and financing flows",
    (a, b, c) => a - b - c,
    "cashflow",
    "currency",
  );
  derive(
    "netLongTermDebt",
    "Net long-term debt issuance",
    ["debtIssued", "debtRepaid"],
    "Reported long-term debt proceeds − repayments; both components required",
    (a, b) => a - b,
    "cashflow",
    "currency",
  );
  derive(
    "balanceResidual",
    "Balance equation residual",
    ["totalAssets", "liabilitiesAndEquity"],
    "Assets − reported liabilities and stockholders’ equity",
    (a, b) => a - b,
    "checks",
    "currency",
  );
  derive(
    "cashFlowResidual",
    "Cash-flow reconciliation residual",
    [
      "operatingCashFlow",
      "investingCashFlow",
      "financingCashFlow",
      "fxCash",
      "cashFlowChange",
    ],
    "Operating + investing + financing cash flow + FX − reported cash change",
    (a, b, c, d, e) => a + b + c + d - e,
    "checks",
    "currency",
  );
  if (revenueKey) {
    const average = (key) =>
      periods.map((p, i) =>
        calculateAnalysisPoint(
          p,
          [
            metrics[key]?.[i],
            p.start
              ? buildMetricRow(
                  company.facts,
                  key,
                  key,
                  [{ ...p, end: previousDay(p.start) }],
                  "currency",
                  industry,
                ).values[0]
              : null,
          ],
          "(Beginning balance + ending balance) / 2",
          (a, b) => (a + b) / 2,
        ),
      );
    add(
      {
        key: "averageAssets",
        label: "Average assets",
        values: average("totalAssets"),
      },
      "drivers",
    );
    add(
      {
        key: "averageEquity",
        label: "Average equity",
        values: average("stockholdersEquity"),
      },
      "drivers",
    );
    add(
      {
        key: "assetTurnover",
        label: "Revenue / average assets, annualized",
        format: "decimal",
        values: periods.map((p, i) =>
          calculateAnalysisPoint(
            p,
            [metrics[revenueKey]?.[i], metrics.averageAssets[i]],
            "Revenue / average assets × annualization factor; 365 / duration days for quarter and YTD",
            (a, b) =>
              b > 0 && p.start
                ? (a / b) *
                  (["quarter", "ytd"].includes(p.kind)
                    ? 365 / (daysBetween(p.start, p.end) + 1)
                    : 1)
                : null,
          ),
        ),
      },
      "drivers",
    );
    derive(
      "equityMultiplier",
      "Average assets / average equity",
      ["averageAssets", "averageEquity"],
      "Average assets / positive average equity",
      (a, b) => (b > 0 ? a / b : null),
      "drivers",
      "decimal",
    );
    derive(
      "dupontRoe",
      "ROE explained by three drivers",
      [
        lens === "banking" ? "bankNetMargin" : "netMargin",
        "assetTurnover",
        "equityMultiplier",
      ],
      "Net margin (%) × annualized revenue / average assets × average assets / average equity",
      (a, b, c) => a * b * c,
      "drivers",
    );
  }
  const history = new Map();
  const enrich = (source) => {
    const id = [
      source.taxonomy,
      source.tag,
      source.unit,
      source.start,
      source.end,
    ].join(":");
    if (!history.has(id)) {
      const rows = (
        company.facts?.[source.taxonomy]?.[source.tag]?.units?.[source.unit] ||
        []
      )
        .filter(
          (e) =>
            (e.start || null) === source.start &&
            e.end === source.end &&
            /^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(e.form || "") &&
            (!settings.asOf || e.filed <= settings.asOf),
        )
        .sort((a, b) => (a.filed || "").localeCompare(b.filed || ""));
      const changes = rows.filter(
        (e, i) => i === 0 || e.val !== rows[i - 1].val,
      );
      history.set(
        id,
        changes.slice(-12).map((e) => ({
          value: e.val,
          filed: e.filed,
          accession: e.accn,
          form: e.form,
          documentUrl:
            company.filings?.find((f) => f.accession === e.accn)?.documentUrl ||
            sourceDocumentUrl(company.cik, { accession: e.accn }),
        })),
      );
    }
    return {
      ...source,
      documentUrl:
        company.filings?.find((f) => f.accession === source.accession)
          ?.documentUrl ||
        source.documentUrl ||
        sourceDocumentUrl(company.cik, source),
      revisions: source.revised ? history.get(id) : [],
    };
  };
  for (const key of Object.keys(metrics))
    metrics[key] = metrics[key].map((point, i) => {
      if (settings.basis === "ttm" && !periods[i].start)
        return missing(
          periods[i],
          "A full trailing year requires four consecutive standalone quarters.",
        );
      return {
        ...point,
        source: undefined,
        sources: evidenceSources(point).map(enrich),
        reason: !finite(point)
          ? point.reason || point.note || missing(periods[i]).reason
          : null,
      };
    });
  return {
    ...comparison,
    version: ANALYSIS_VERSION,
    metrics,
    definitions: Object.values(definitions),
    revenueKey,
    highlights: defaultMetrics(lens).slice(0, 6),
    filings: (company.filings || [])
      .filter((f) => !settings.asOf || f.filingDate <= settings.asOf)
      .slice(0, 100),
    note: "Standard SEC XBRL concepts, USD and reported per-share units. This is a normalized financial extract, not a complete reproduction of the filed statements. Custom tags and unavailable contexts remain missing. Latest filed values within the cutoff are used; revisions are not automatically errors.",
  };
}

export function analysisBaseline(periods, index, mode) {
  const current = periods[index];
  if (!current) return -1;
  if (mode === "previous") {
    const before = periods[index + 1];
    const gap = before ? daysBetween(before.end, current.end) : 0;
    if (
      !before ||
      (current.kind === "annual"
        ? gap < 300 || gap > 400
        : gap < 60 || gap > 120)
    )
      return -1;
    // YTD durations grow within a year; a sequential comparison is misleading.
    if (current.kind === "ytd") return -1;
    return index + 1;
  }
  if (mode && !["year", "previous"].includes(mode))
    return periods.findIndex((p) => p.end === mode && p.end < current.end);
  return periods.findIndex(
    (p, i) =>
      i > index &&
      p.fp === current.fp &&
      daysBetween(p.end, current.end) >= 350 &&
      daysBetween(p.end, current.end) <= 380,
  );
}

export function analysisChange(current, before, format) {
  if (!finite(current) || !finite(before))
    return {
      delta: null,
      percent: null,
      reason: "Both periods require compatible reported inputs.",
    };
  const a = current.period,
    b = before.period;
  const flow = [...evidenceSources(current), ...evidenceSources(before)].some(
    (s) => s.start,
  );
  if (
    a?.kind !== b?.kind ||
    (flow &&
      (!a?.start ||
        !b?.start ||
        Math.abs(daysBetween(a.start, a.end) - daysBetween(b.start, b.end)) >
          14))
  )
    return {
      delta: null,
      percent: null,
      reason: "The reporting durations are not comparable.",
    };
  const delta = current.value - before.value;
  return {
    delta,
    percent:
      !["percent", "decimal"].includes(format) && before.value > 0
        ? (delta / before.value) * 100
        : null,
    reason:
      before.value <= 0 && !["percent", "decimal"].includes(format)
        ? "Percentage growth is not meaningful from a zero or negative base."
        : null,
  };
}

export function commonSizePoint(data, key, index) {
  const def = data.definitions.find((d) => d.key === key);
  const denominator =
    def?.category === "balance" ? "totalAssets" : data.revenueKey;
  if (
    def?.format !== "currency" ||
    !["income", "balance", "cashflow"].includes(def.category)
  )
    return data.metrics[key]?.[index];
  if (!denominator)
    return missing(
      data.periods[index],
      "No comparable revenue denominator is defined for this industry.",
    );
  return calculateAnalysisPoint(
    data.periods[index],
    [data.metrics[key]?.[index], data.metrics[denominator]?.[index]],
    `${def.label} / ${data.definitions.find((d) => d.key === denominator)?.label} × 100`,
    (a, b) => (b > 0 ? (a / b) * 100 : null),
  );
}

export function analysisChecks(data, index) {
  const visible = data.definitions.filter((d) =>
    ["income", "balance", "cashflow", "ratios"].includes(d.category),
  );
  const points = visible.map((d) => data.metrics[d.key]?.[index]);
  const sources = points.flatMap(evidenceSources);
  const revised = new Set(
    sources.filter((s) => s.revised).map((s) => `${s.tag}:${s.start}:${s.end}`),
  ).size;
  const check = (key, scaleKey, title) => {
    const point = data.metrics[key]?.[index];
    const scale = data.metrics[scaleKey]?.[index]?.value;
    const tolerance = Math.max(1, Math.abs(scale || 0) * 0.00001);
    return {
      key,
      title,
      point,
      tolerance,
      status: !finite(point)
        ? "Incomplete"
        : Math.abs(point.value) <= tolerance
          ? "Reconciled"
          : "Review residual",
    };
  };
  return {
    available: points.filter(finite).length,
    total: points.length,
    calculated: points.filter(
      (p) => finite(p) && p.classification === "calculated",
    ).length,
    revised,
    missing: visible.filter((d) => !finite(data.metrics[d.key]?.[index])),
    checks: [
      check(
        "balanceResidual",
        "totalAssets",
        "Assets versus reported liabilities and equity",
      ),
      check(
        "cashFlowResidual",
        "operatingCashFlow",
        "Cash flows plus FX versus reported cash change",
      ),
    ],
  };
}

// Share repeated evidence across metrics without losing any input provenance.
export function packAnalysisCompany(data) {
  const sources = [],
    calculations = [],
    sourceMap = new Map(),
    calculationMap = new Map();
  const intern = (value, rows, map) => {
    const key = JSON.stringify(value);
    if (!map.has(key)) {
      map.set(key, rows.length);
      rows.push(value);
    }
    return map.get(key);
  };
  return {
    ...data,
    packed: true,
    metrics: Object.fromEntries(
      Object.entries(data.metrics).map(([key, points]) => [
        key,
        points.map(
          ({
            period: _period,
            sources: inputs,
            calculations: steps,
            ...p
          }) => ({
            ...p,
            sourceIds: (inputs || []).map((s) => intern(s, sources, sourceMap)),
            calculationIds: (steps || []).map((c) =>
              intern(c, calculations, calculationMap),
            ),
          }),
        ),
      ]),
    ),
    sourceCatalog: sources,
    calculationCatalog: calculations,
  };
}
export function unpackAnalysisCompany(data) {
  if (!data.packed) return data;
  const { sourceCatalog, calculationCatalog, packed: _packed, ...rest } = data;
  return {
    ...rest,
    metrics: Object.fromEntries(
      Object.entries(data.metrics).map(([key, points]) => [
        key,
        points.map(({ sourceIds, calculationIds, ...p }, i) => ({
          ...p,
          period: data.periods[i],
          sources: sourceIds.map((id) => sourceCatalog[id]),
          calculations: calculationIds.map((id) => calculationCatalog[id]),
        })),
      ]),
    ),
  };
}
