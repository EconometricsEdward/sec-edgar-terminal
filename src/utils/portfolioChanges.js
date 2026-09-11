/** Compact, public-evidence-only checkpoints for comparisons between research runs. */
export const PORTFOLIO_BASELINE_VERSION = "edgar.portfolio.baseline.v1";
export const PORTFOLIO_BASELINE_LIMIT = 500 * 1024;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const short = (value, max = 2000) =>
  typeof value === "string" && value.length <= max;
const timestamp = (value) =>
  short(value, 40) &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
};
const cleanText = (value, max = 2000) =>
  typeof value === "string" ? value.slice(0, max) : "";
const available = (point) =>
  finite(point?.value) &&
  !["unavailable", "unsupported"].includes(point?.classification);
const checked = (company) =>
  company &&
  company.status !== "failed" &&
  !["stale", "unavailable"].includes(company.cache?.status) &&
  !["pending", "not_checked", "failed", "stale"].includes(
    company.refreshStatus,
  );

function periodFor(point, company) {
  const source = point?.period || company?.period;
  if (
    !source ||
    typeof source.end !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(source.end)
  )
    return "";
  return JSON.stringify(
    Object.fromEntries(
      ["start", "end", "kind", "fy", "year", "quarter", "months", "fp"]
        .filter(
          (key) =>
            source[key] !== undefined &&
            source[key] !== null &&
            source[key] !== "",
        )
        .map((key) => [key, cleanText(String(source[key]))]),
    ),
  );
}
export function portfolioMetricDefinition(point) {
  const tags = (point.sources || [])
    .map((source) => `${cleanText(source.taxonomy)}:${cleanText(source.tag)}`)
    .filter((tag) => tag !== ":");
  const calculations = (point.calculations || [])
    .map((entry) => [
      cleanText(entry.label),
      cleanText(entry.formula),
      cleanText(entry.unit),
      cleanText(entry.classification),
      cleanText(entry.taxonomy),
      cleanText(entry.tag),
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({
    unit: cleanText(point.unit),
    classification: cleanText(point.classification),
    formula: cleanText(point.formula),
    tags: [...new Set(tags)].sort(),
    calculations,
  });
}
function sourcesFor(point) {
  return [
    ...new Set(
      (point?.sources || [])
        .map((source) => source.documentUrl)
        .filter(safeUrl),
    ),
  ].slice(0, 8);
}
const sourceLinks = (company) =>
  [
    ...new Set(
      Object.values(company?.metrics || {})
        .flatMap(sourcesFor)
        .concat(
          (company?.filings || [])
            .map((filing) => filing.documentUrl)
            .filter(safeUrl),
        ),
    ),
  ].slice(0, 3);

/** Validate a small, explicit schema; no uploaded notes or allocation fields are accepted. */
export function validatePortfolioBaseline(value) {
  if (value === null || value === undefined) return value;
  let nodes = 0;
  function inspect(entry, depth = 0) {
    requireValue(
      ++nodes <= 65000 && depth <= 8,
      "The comparison checkpoint is too large or deeply nested.",
    );
    if (Array.isArray(entry)) {
      requireValue(
        entry.length <= 5000,
        "The comparison checkpoint contains too many entries.",
      );
      entry.forEach((item) => inspect(item, depth + 1));
    } else if (plain(entry)) {
      for (const [key, item] of Object.entries(entry)) {
        requireValue(
          !["__proto__", "constructor", "prototype"].includes(key),
          "Unsafe comparison checkpoint field.",
        );
        inspect(item, depth + 1);
      }
    } else
      requireValue(
        entry === null ||
          typeof entry === "boolean" ||
          finite(entry) ||
          short(entry, 16000),
        "Invalid comparison checkpoint value.",
      );
  }
  inspect(value);
  const fields = (record, allowed) =>
    requireValue(
      plain(record) &&
        Object.keys(record).every((key) => allowed.includes(key)),
      "The comparison checkpoint contains an unsupported field.",
    );
  fields(value, [
    "schema_version",
    "capturedAt",
    "basis",
    "sources",
    "periods",
    "definitions",
    "companies",
  ]);
  requireValue(
    value.schema_version === PORTFOLIO_BASELINE_VERSION &&
      timestamp(value.capturedAt) &&
      ["annual", "ttm"].includes(value.basis),
    "The comparison checkpoint version, date, or reporting basis is invalid.",
  );
  requireValue(
    Array.isArray(value.sources) &&
      value.sources.length <= 5000 &&
      value.sources.every((url) => short(url, 2000) && safeUrl(url)),
    "Comparison source links must use HTTPS on SEC.gov.",
  );
  for (const key of ["periods", "definitions"])
    requireValue(
      Array.isArray(value[key]) &&
        value[key].length <= 5000 &&
        value[key].every((entry) =>
          short(entry, key === "periods" ? 1000 : 16000),
        ),
      "Comparison reporting definitions are invalid.",
    );
  const index = (number, pool) =>
    Number.isInteger(number) && number >= 0 && number < pool.length;
  const links = (list) =>
    Array.isArray(list) &&
    list.length <= 8 &&
    list.every((item) => index(item, value.sources));
  requireValue(
    Array.isArray(value.companies) && value.companies.length <= 100,
    "A comparison checkpoint supports at most 100 issuers.",
  );
  const ciks = new Set();
  for (const company of value.companies) {
    fields(company, [
      "cik",
      "ticker",
      "name",
      "status",
      "checked",
      "period",
      "metrics",
      "filings",
    ]);
    requireValue(
      /^\d{10}$/.test(company.cik) &&
        !ciks.has(company.cik) &&
        short(company.ticker, 40) &&
        short(company.name, 300) &&
        ["ready", "partial", "failed", "unsupported"].includes(
          company.status,
        ) &&
        typeof company.checked === "boolean" &&
        index(company.period, value.periods),
      "A comparison issuer identity or status is invalid.",
    );
    ciks.add(company.cik);
    requireValue(
      plain(company.metrics) && Object.keys(company.metrics).length <= 80,
      "A comparison issuer contains too many metrics.",
    );
    for (const [key, point] of Object.entries(company.metrics)) {
      requireValue(
        /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key),
        "A comparison metric key is invalid.",
      );
      fields(point, [
        "value",
        "unit",
        "label",
        "period",
        "definition",
        "sources",
      ]);
      requireValue(
        (point.value === null || finite(point.value)) &&
          short(point.unit, 100) &&
          short(point.label, 200) &&
          index(point.period, value.periods) &&
          index(point.definition, value.definitions) &&
          links(point.sources),
        "A comparison metric is invalid.",
      );
    }
    requireValue(
      Array.isArray(company.filings) && company.filings.length <= 40,
      "A comparison issuer contains too many filings.",
    );
    const accessions = new Set();
    for (const filing of company.filings) {
      requireValue(
        typeof filing === "string" &&
          /^\d{10}-\d{2}-\d{6}$/.test(filing) &&
          !accessions.has(filing),
        "A comparison filing is invalid.",
      );
      accessions.add(filing);
    }
  }
  requireValue(
    size(value) <= PORTFOLIO_BASELINE_LIMIT,
    "The comparison checkpoint exceeds its 500 KiB limit. Current research has been preserved.",
  );
  return value;
}

/** Store shared provenance and definitions once instead of retaining another full snapshot. */
export function createPortfolioBaseline(snapshot) {
  if (!snapshot) return null;
  const baseline = {
    schema_version: PORTFOLIO_BASELINE_VERSION,
    capturedAt: snapshot.generated_at,
    basis: snapshot.basis,
    sources: [],
    periods: [],
    definitions: [],
    companies: [],
  };
  const pools = {
    sources: new Map(),
    periods: new Map(),
    definitions: new Map(),
  };
  const intern = (pool, value) => {
    if (!pools[pool].has(value)) {
      pools[pool].set(value, baseline[pool].length);
      baseline[pool].push(value);
    }
    return pools[pool].get(value);
  };
  const seen = new Set();
  for (const company of snapshot.companies || []) {
    if (seen.has(company.cik)) continue;
    seen.add(company.cik);
    const metrics = Object.fromEntries(
      Object.entries(company.metrics || {}).map(([key, point]) => [
        key,
        {
          value: available(point) ? point.value : null,
          unit: cleanText(point.unit, 100),
          label: cleanText(point.label || key, 200),
          period: intern("periods", periodFor(point, company)),
          definition: intern("definitions", portfolioMetricDefinition(point)),
          sources: sourcesFor(point).map((url) => intern("sources", url)),
        },
      ]),
    );
    const filings = [
      ...new Map(
        [
          ...(company.filings || []),
          company.latestAnnualFiling,
          company.latestInterimFiling,
        ]
          .filter(
            (filing) => filing && /^\d{10}-\d{2}-\d{6}$/.test(filing.accession),
          )
          .map((filing) => [filing.accession, filing]),
      ).values(),
    ]
      .slice(0, 40)
      .map((filing) => filing.accession);
    baseline.companies.push({
      cik: company.cik,
      ticker: cleanText(company.ticker, 40),
      name: cleanText(company.name, 300),
      status: company.status,
      checked: !!checked(company),
      period: intern("periods", periodFor(null, company)),
      metrics,
      filings,
    });
  }
  return validatePortfolioBaseline(baseline);
}

/** Preserve the last complete capture before any later run replaces its full snapshot. */
export function advancePortfolioBaseline(
  document,
  nextSnapshot,
  completeCheck,
) {
  const previous = document?.snapshot;
  if (
    previous &&
    previous.generated_at === document.lastCheckedAt &&
    previous.basis === nextSnapshot?.basis &&
    !previous.cancelled &&
    Array.isArray(previous.companies) &&
    previous.companies.length > 0 &&
    previous.companies.every(checked)
  )
    return createPortfolioBaseline(previous);
  if (document?.comparisonBaseline) return document.comparisonBaseline;
  if (completeCheck) return createPortfolioBaseline(nextSnapshot);
  return null;
}

/** A changed reporting period is a new observation, never a same-period revision or growth rate. */
export function comparePortfolioResearch(baseline, snapshot, rows = []) {
  const result = {
    state: "ready",
    baselineAt: baseline?.capturedAt || null,
    capturedAt: snapshot?.generated_at || null,
    changes: [],
    warnings: [],
    counts: { filing: 0, period: 0, revision: 0, coverage: 0 },
    checkedIssuers: 0,
    uncheckedIssuers: 0,
  };
  if (!baseline || !snapshot) {
    result.state = "needs_baseline";
    return result;
  }
  try {
    validatePortfolioBaseline(baseline);
  } catch (error) {
    result.state = "incompatible";
    result.warnings.push(error.message);
    return result;
  }
  if (baseline.basis !== snapshot.basis) {
    result.state = "incompatible";
    result.warnings.push(
      "The captures use different reporting bases. Complete a full refresh on the current basis to establish a compatible comparison.",
    );
    return result;
  }
  const current = new Map(
    (snapshot.companies || []).map((company) => [company.cik, company]),
  );
  const previous = new Map(
    baseline.companies.map((company) => [company.cik, company]),
  );
  const included = new Map();
  for (const row of rows)
    if (
      !row.excluded &&
      !row.mergedInto &&
      row.duplicateChoice !== "remove" &&
      /^\d{10}$/.test(row.resolution?.cik || "") &&
      !included.has(row.resolution.cik)
    )
      included.set(row.resolution.cik, row);
  const urls = (point) =>
    (point?.sources || []).map((index) => baseline.sources[index]);
  for (const [cik, row] of included) {
    const before = previous.get(cik),
      after = current.get(cik);
    const identity = {
      cik,
      rowId: row.id,
      ticker: row.resolution?.ticker || after?.ticker || before?.ticker || "",
      companyName: after?.name || before?.name || row.resolution?.name || cik,
    };
    const add = (kind, key, detail) => {
      result.changes.push({
        ...identity,
        kind,
        id: `${cik}:${kind}:${key}`,
        ...detail,
      });
      result.counts[kind]++;
    };
    if (!checked(after)) {
      result.uncheckedIssuers++;
      add("coverage", "unchecked", {
        title: "Current evidence needs a completed check",
        description: after
          ? "This issuer was not checked successfully in the current capture. Earlier evidence may be retained; no financial change is inferred."
          : "This issuer has no result in the current capture. Missing research is not evidence of a financial change.",
        before: before?.status || "No earlier capture",
        after: after?.refreshStatus || after?.status || "Not checked",
        beforeSources: before
          ? [...new Set(Object.values(before.metrics).flatMap(urls))].slice(
              0,
              3,
            )
          : [],
        afterSources: sourceLinks(after),
        fresh: false,
      });
      continue;
    }
    result.checkedIssuers++;
    if (!before || !before.checked) {
      add("coverage", "first", {
        title: "Evidence is now available for comparison",
        description:
          "There is no successfully checked earlier issuer capture. This is a first observation, not a financial change.",
        before: before?.status || "No earlier capture",
        after: after.status,
        beforeSources: [],
        afterSources: sourceLinks(after),
        fresh: true,
      });
      continue;
    }
    const oldFilings = new Set(before.filings);
    for (const filing of [
      ...new Map(
        [
          ...(after.filings || []),
          after.latestAnnualFiling,
          after.latestInterimFiling,
        ]
          .filter((entry) => entry?.accession && safeUrl(entry.documentUrl))
          .map((entry) => [entry.accession, entry]),
      ).values(),
    ]) {
      if (!oldFilings.has(filing.accession))
        add("filing", filing.accession, {
          title: `${filing.form || "SEC filing"} newly observed`,
          description: `Filed ${filing.filingDate || "date unavailable"}. Newly observed means absent from the earlier captured filing list; it does not necessarily mean newly filed.`,
          before: "Not in earlier captured list",
          after: filing.accession,
          beforeSources: [],
          afterSources: [filing.documentUrl],
          fresh: true,
        });
    }
    const priorPeriod = baseline.periods[before.period],
      currentPeriod = periodFor(null, after);
    if (priorPeriod !== currentPeriod)
      add("period", "reporting", {
        title: "Reporting period changed",
        description:
          "The captures cover different reporting periods. Values from these periods are not treated as same-period revisions or growth rates.",
        before: priorPeriod || "Period unavailable",
        after: currentPeriod || "Period unavailable",
        beforeSources: [
          ...new Set(Object.values(before.metrics).flatMap(urls)),
        ].slice(0, 3),
        afterSources: sourceLinks(after),
        fresh: true,
      });
    if (before.status !== after.status)
      add("coverage", "status", {
        title: "Evidence coverage changed",
        description:
          "This is a change in available research coverage, not a rating of the company.",
        before: before.status,
        after: after.status,
        beforeSources: [],
        afterSources: sourceLinks(after),
        fresh: true,
      });
    for (const key of new Set([
      ...Object.keys(before.metrics),
      ...Object.keys(after.metrics || {}),
    ])) {
      const left = before.metrics[key],
        right = after.metrics?.[key];
      const oldAvailable = finite(left?.value),
        newAvailable = available(right);
      const label = right?.label || left?.label || key;
      const evidence = {
        metric: key,
        beforeSources: urls(left),
        afterSources: sourcesFor(right),
        fresh: true,
      };
      if (oldAvailable !== newAvailable) {
        add("coverage", key, {
          ...evidence,
          title: `${label}: availability changed`,
          description:
            "A missing or newly supported value changes evidence coverage. Missing values are never interpreted as zero.",
          before: oldAvailable ? `${left.value} ${left.unit}` : "Unavailable",
          after: newAvailable
            ? `${right.value} ${right.unit || ""}`
            : "Unavailable",
        });
      } else if (oldAvailable && newAvailable) {
        const samePeriod =
          baseline.periods[left.period] !== "" &&
          baseline.periods[left.period] === periodFor(right, after);
        const sameDefinition =
          baseline.definitions[left.definition] === portfolioMetricDefinition(right) &&
          left.unit === cleanText(right.unit, 100);
        if (
          samePeriod &&
          sameDefinition &&
          left.value !== right.value &&
          evidence.beforeSources.length &&
          evidence.afterSources.length
        )
          add("revision", key, {
            ...evidence,
            title: `${label}: same-period value changed`,
            description:
              "The metric, period, unit, and captured definition match. This is an observed value revision, not a growth rate or a conclusion about its cause.",
            before: `${left.value} ${left.unit}`,
            after: `${right.value} ${right.unit || ""}`,
            beforeValue: left.value,
            afterValue: right.value,
            unit: left.unit,
            period: baseline.periods[left.period],
          });
        else if (samePeriod && sameDefinition && left.value !== right.value)
          add("coverage", `${key}:source`, {
            ...evidence,
            title: `${label}: source verification needed`,
            description:
              "A value differs, but at least one observation has no linked SEC source. Inspect the company evidence before treating it as a verified revision.",
            before: evidence.beforeSources.length
              ? "Linked source available"
              : "No linked source",
            after: evidence.afterSources.length
              ? "Linked source available"
              : "No linked source",
          });
        else if (samePeriod && !sameDefinition)
          add("coverage", `${key}:definition`, {
            ...evidence,
            title: `${label}: definition or unit changed`,
            description:
              "These observations are not directly comparable. No numerical change is calculated.",
            before: `${left.label} · ${left.unit || "Unit unavailable"}`,
            after: `${right.label || key} · ${right.unit || "Unit unavailable"}`,
          });
        else if (
          !samePeriod &&
          priorPeriod === currentPeriod &&
          baseline.periods[left.period] !== periodFor(right, after)
        )
          add("period", key, {
            ...evidence,
            title: `${label}: observation period changed`,
            description:
              "This metric now covers a different period. No same-period revision is inferred.",
            before: baseline.periods[left.period] || "Period unavailable",
            after: periodFor(right, after) || "Period unavailable",
          });
      }
    }
  }
  if (result.uncheckedIssuers)
    result.warnings.push(
      `${result.uncheckedIssuers} issuer${result.uncheckedIssuers === 1 ? " was" : "s were"} not checked successfully. Complete or retry the refresh before treating coverage as current.`,
    );
  if (snapshot.cancelled)
    result.warnings.push(
      "This refresh was cancelled. Only successfully checked issuers can show observed evidence changes.",
    );
  return result;
}
