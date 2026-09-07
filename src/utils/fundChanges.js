import {
  fundCsv,
  fundEvidence,
  resolveSecurityGroups,
} from "./fundSecurity.js";

export const FUND_CHANGE_METHOD =
  "Compare all positions in the two checked N-PORT reports using unambiguous CUSIP/ISIN aliases, separated by reported long/short direction. Duplicate lots with the same identifier and direction are aggregated. Added and removed mean observed only in one checked report, not purchases or sales. Value and NAV-weight changes can reflect prices, portfolio size, corporate actions, identifier changes, or transactions; they do not establish fund flows. Derivative fair values are not underlying exposure. Report selection is limited to the recent filings checked.";
const finite = Number.isFinite;
const direction = (holding) =>
  String(holding.payoffProfile || "unknown")
    .trim()
    .toLowerCase() || "unknown";
const derivative = (holding) =>
  /^D(IR|CR|FE|E|CO|O)$/.test(holding.assetCat || "");
const complete = (portfolio) =>
  portfolio?.complete === true || portfolio?.coverage?.complete === true;
const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return finite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const safeSum = (holdings, key) => {
  if (!holdings.length || holdings.some((holding) => !finite(holding[key])))
    return null;
  const sum = holdings.reduce((total, holding) => total + holding[key], 0);
  return finite(sum) ? sum : null;
};
const difference = (after, before) =>
  finite(after) && finite(before) && finite(after - before)
    ? after - before
    : null;
const changed = (value) => finite(value) && Math.abs(value) > 1e-9;

function aggregate(positions, absentConfirmed) {
  const holdings = positions.map((position) => position.holding);
  const units = [
    ...new Set(
      holdings.map((holding) =>
        String(holding.units || "")
          .trim()
          .toUpperCase(),
      ),
    ),
  ];
  return {
    count: holdings.length,
    value: holdings.length
      ? safeSum(holdings, "value")
      : absentConfirmed
        ? 0
        : null,
    weight: holdings.length
      ? safeSum(holdings, "pctOfNav")
      : absentConfirmed
        ? 0
        : null,
    quantity: holdings.length ? safeSum(holdings, "balance") : null,
    units: units.length === 1 && units[0] ? units[0] : null,
    assetCategories: [
      ...new Set(holdings.map((holding) => holding.assetCat || "OTH")),
    ].sort(),
    derivative: holdings.some(derivative),
    absent: !holdings.length,
    absentConfirmed: !holdings.length && absentConfirmed,
    missingValues: holdings.filter((holding) => !finite(holding.value)).length,
    missingWeights: holdings.filter((holding) => !finite(holding.pctOfNav))
      .length,
  };
}

function coverage(portfolio, matched, portfolioIndex) {
  const holdings = portfolio?.holdings || [];
  const unidentified = matched.unidentified.filter(
    (position) => position.portfolioIndex === portfolioIndex,
  ).length;
  const ambiguous = matched.ambiguous
    .flatMap((group) => group.positions)
    .filter((position) => position.portfolioIndex === portfolioIndex).length;
  return {
    positions: holdings.length,
    identified: holdings.length - unidentified - ambiguous,
    unidentified,
    ambiguous,
    complete: complete(portfolio),
    valued: holdings.filter((holding) => finite(holding.value)).length,
    weighted: holdings.filter((holding) => finite(holding.pctOfNav)).length,
  };
}

/** Inputs must contain full, unpaginated portfolios. Absence is never inferred from an incomplete report. */
export function buildFundChanges(
  before,
  after,
  { scope = "all", query = "" } = {},
) {
  const selectedScope = ["all", "added", "removed", "changed"].includes(scope)
    ? scope
    : "all";
  const search = String(query || "")
    .trim()
    .slice(0, 100);
  const result = {
    available: false,
    reason: null,
    comparisonType: null,
    before: before ? fundEvidence(before) : null,
    after: after ? fundEvidence(after) : null,
    coverage: null,
    warnings: [],
    rows: [],
    summary: {
      total: 0,
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 0,
      unverified: 0,
    },
    scope: selectedScope,
    query: search,
    methodology: FUND_CHANGE_METHOD,
  };
  if (!after || !before)
    return {
      ...result,
      reason:
        "A second verified report is needed. Select an earlier filing from the recent report list; unavailable or unknown report dates are not treated as a previous period.",
    };
  if (
    !before.cik ||
    !after.cik ||
    String(before.cik).padStart(10, "0") !==
      String(after.cik).padStart(10, "0") ||
    !before.seriesId ||
    before.seriesId !== after.seriesId
  )
    return {
      ...result,
      reason:
        "The checked reports do not establish the same SEC registrant and series. Holdings changes are withheld to avoid comparing different portfolios.",
    };
  if (!validDate(before.asOf) || !validDate(after.asOf))
    return {
      ...result,
      reason:
        "Both portfolio dates must be verified from the reports before changes can be calculated.",
    };
  if (
    !before.accession ||
    !after.accession ||
    before.accession === after.accession
  )
    return {
      ...result,
      reason: "Choose two different filing accessions to compare.",
    };
  if (before.asOf > after.asOf)
    return {
      ...result,
      reason:
        "The earlier report has a later portfolio date. Reverse the report selection to calculate forward changes.",
    };
  result.available = true;
  result.comparisonType =
    before.asOf === after.asOf ? "same-period-revision" : "period-change";
  if (result.comparisonType === "same-period-revision")
    result.warnings.push(
      "Both filings cover the same portfolio date. These are filing revisions or amendments, not a change across reporting periods.",
    );
  if (
    String(before.form || "").endsWith("/A") ||
    String(after.form || "").endsWith("/A")
  )
    result.warnings.push(
      "At least one selected filing is an amendment. Values reflect that selected version of the report.",
    );
  const matched = resolveSecurityGroups([before, after]);
  result.coverage = {
    before: coverage(before, matched, 0),
    after: coverage(after, matched, 1),
  };
  const bothComplete = complete(before) && complete(after);
  if (!bothComplete)
    result.warnings.push(
      "At least one report is not verified as a complete portfolio. Positions observed on one side are unverified; absence and zero values are not inferred.",
    );
  if (matched.unidentified.length)
    result.warnings.push(
      `${matched.unidentified.length} reported positions lack a usable CUSIP or ISIN. They remain visible as unverified observations; names and tickers do not establish a match.`,
    );
  if (matched.ambiguous.length)
    result.warnings.push(
      `${matched.ambiguous.length} conflicting identifier groups cannot be matched reliably. Their observations remain visible separately.`,
    );
  result.warnings.push(
    "Corporate actions, identifier changes, and changes in reported position direction can appear as additions or removals. Review the original filings before interpreting a change as a trade.",
  );

  const rows = [];
  for (const group of matched.groups) {
    for (const side of [
      ...new Set(
        group.positions.map((position) => direction(position.holding)),
      ),
    ].sort()) {
      const positions = group.positions.filter(
        (position) => direction(position.holding) === side,
      );
      const beforePositions = positions.filter(
        (position) => position.portfolioIndex === 0,
      );
      const afterPositions = positions.filter(
        (position) => position.portfolioIndex === 1,
      );
      const left = aggregate(beforePositions, bothComplete),
        right = aggregate(afterPositions, bothComplete);
      const warnings = [];
      const deltaValue = difference(right.value, left.value),
        deltaWeight = difference(right.weight, left.weight);
      let quantityReason = null;
      if (!left.count || !right.count)
        quantityReason =
          "Quantity change requires a matched position in both reports; report absence does not establish a transaction.";
      else if (left.derivative || right.derivative)
        quantityReason =
          "Derivative balances do not establish comparable underlying quantities.";
      else if (!["long", "short"].includes(side))
        quantityReason =
          "A consistent reported long or short direction is required for quantity comparison.";
      else if (!left.units || !right.units || left.units !== right.units)
        quantityReason =
          "Quantity units are missing, mixed, or different between reports.";
      else if (
        left.assetCategories.length !== 1 ||
        right.assetCategories.length !== 1 ||
        left.assetCategories.join() !== right.assetCategories.join()
      )
        quantityReason =
          "Asset classification is mixed or changed; quantity comparability needs review.";
      else if (!finite(left.quantity) || !finite(right.quantity))
        quantityReason =
          "At least one reported quantity is missing or cannot be aggregated.";
      const deltaQuantity = quantityReason
        ? null
        : difference(right.quantity, left.quantity);
      if (!quantityReason && deltaQuantity == null)
        quantityReason =
          "The quantity difference is outside the supported numeric range.";
      if (left.count > 1 || right.count > 1)
        warnings.push(
          "Multiple reported lots are aggregated within the same identifier and position direction; quantity is shown only when all units agree.",
        );
      if (
        left.missingValues ||
        right.missingValues ||
        left.missingWeights ||
        right.missingWeights
      )
        warnings.push(
          "Some reported values or NAV weights are missing. Incomplete sums are withheld rather than treating missing inputs as zero.",
        );
      const status = !left.count
        ? bothComplete
          ? "added"
          : "unverified"
        : !right.count
          ? bothComplete
            ? "removed"
            : "unverified"
          : changed(deltaValue) ||
              changed(deltaWeight) ||
              changed(deltaQuantity) ||
              left.units !== right.units ||
              left.assetCategories.join() !== right.assetCategories.join()
            ? "changed"
            : deltaValue == null && deltaWeight == null && deltaQuantity == null
              ? "unverified"
              : "unchanged";
      rows.push({
        key: `${group.key}:${side}`,
        name:
          afterPositions[0]?.holding.name ||
          beforePositions[0]?.holding.name ||
          group.name,
        ids: group.ids,
        direction: side,
        status,
        before: left,
        after: right,
        deltaValue,
        deltaWeight,
        deltaQuantity,
        quantityReason,
        warnings,
      });
    }
  }
  for (const [position, reason] of [
    ...matched.unidentified.map((position) => [
      position,
      "No usable CUSIP or ISIN; identity cannot be linked across reports.",
    ]),
    ...matched.ambiguous.flatMap((group) =>
      group.positions.map((position) => [
        position,
        "Conflicting CUSIP/ISIN aliases; identity cannot be linked across reports.",
      ]),
    ),
  ]) {
    rows.push({
      key: `unverified:${position.portfolioIndex}:${position.holdingIndex}`,
      name: position.holding.name || "Unnamed position",
      ids: position.identity.ids,
      direction: direction(position.holding),
      status: "unverified",
      before: aggregate(position.portfolioIndex === 0 ? [position] : [], false),
      after: aggregate(position.portfolioIndex === 1 ? [position] : [], false),
      deltaValue: null,
      deltaWeight: null,
      deltaQuantity: null,
      quantityReason: reason,
      warnings: [reason],
    });
  }
  rows.sort(
    (a, b) =>
      (finite(b.deltaWeight) ? Math.abs(b.deltaWeight) : -1) -
        (finite(a.deltaWeight) ? Math.abs(a.deltaWeight) : -1) ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key),
  );
  result.summary.total = rows.length;
  for (const row of rows) result.summary[row.status]++;
  result.rows = rows.filter(
    (row) =>
      (selectedScope === "all" || row.status === selectedScope) &&
      (!search ||
        [row.name, ...row.ids, row.direction].some((value) =>
          value.toLowerCase().includes(search.toLowerCase()),
        )),
  );
  return result;
}

export function fundChangesCsv(result) {
  const before = result.before || {},
    after = result.after || {};
  const coverageText = result.coverage
    ? `Before: ${result.coverage.before.identified}/${result.coverage.before.positions} identifier-matchable positions; complete=${result.coverage.before.complete}. After: ${result.coverage.after.identified}/${result.coverage.after.positions}; complete=${result.coverage.after.complete}.`
    : "Comparison unavailable";
  return fundCsv([
    [
      "Fund",
      "SEC series",
      "Before portfolio date",
      "After portfolio date",
      "Before accession",
      "After accession",
      "Before filing date",
      "After filing date",
      "Before source",
      "After source",
      "Comparison type",
      "Security",
      "Identifiers",
      "Reported direction",
      "Observation",
      "Before reported lots",
      "After reported lots",
      "Before USD value",
      "After USD value",
      "USD value change",
      "Before NAV weight %",
      "After NAV weight %",
      "NAV weight change pp",
      "Before quantity",
      "After quantity",
      "Before units",
      "After units",
      "Quantity change",
      "Quantity comparison note",
      "Row notes",
      "Coverage",
      "Scope",
      "Search",
      "Methodology",
    ],
    ...result.rows.map((row) => [
      after.ticker,
      after.seriesId,
      before.asOf,
      after.asOf,
      before.accession,
      after.accession,
      before.filingDate,
      after.filingDate,
      before.sourceUrl,
      after.sourceUrl,
      result.comparisonType,
      row.name,
      row.ids.join(" | "),
      row.direction,
      row.status,
      row.before.count,
      row.after.count,
      row.before.value,
      row.after.value,
      row.deltaValue,
      row.before.weight,
      row.after.weight,
      row.deltaWeight,
      row.before.quantity,
      row.after.quantity,
      row.before.units,
      row.after.units,
      row.deltaQuantity,
      row.quantityReason,
      row.warnings.join(" "),
      coverageText,
      result.scope,
      result.query,
      result.methodology,
    ]),
  ]);
}

export function fundChangeEvidence(result, row) {
  return {
    kind: "change",
    title: `${result.after.ticker} · ${row.name}`.slice(0, 240),
    summary:
      `${row.status}: ${row.ids.join(" / ") || "unidentified position"}; reported direction ${row.direction}. Compare ${result.before.asOf} with ${result.after.asOf} (${result.comparisonType}). ${row.warnings.join(" ")} ${row.quantityReason || "Reported quantities use matching units; changes do not establish purchases or sales."}`.slice(
        0,
        3000,
      ),
    values: [
      {
        label: "Before reported USD value",
        value: row.before.value,
        unit: "USD",
      },
      {
        label: "After reported USD value",
        value: row.after.value,
        unit: "USD",
      },
      {
        label: "Reported USD value change",
        value: row.deltaValue,
        unit: "USD",
      },
      { label: "Before NAV weight", value: row.before.weight, unit: "%" },
      { label: "After NAV weight", value: row.after.weight, unit: "%" },
      { label: "NAV weight change", value: row.deltaWeight, unit: "pp" },
      {
        label: "Before quantity",
        value: row.before.quantity,
        unit: row.before.units || "unavailable",
      },
      {
        label: "After quantity",
        value: row.after.quantity,
        unit: row.after.units || "unavailable",
      },
      {
        label: "Quantity change",
        value: row.deltaQuantity,
        unit:
          row.before.units === row.after.units
            ? row.before.units || "unavailable"
            : "incomparable units",
      },
      {
        label: "Before positions read",
        value: result.coverage.before.positions,
        unit: "positions",
      },
      {
        label: "After positions read",
        value: result.coverage.after.positions,
        unit: "positions",
      },
      {
        label: "Before matchable positions",
        value: result.coverage.before.identified,
        unit: "positions",
      },
      {
        label: "After matchable positions",
        value: result.coverage.after.identified,
        unit: "positions",
      },
    ],
    sources: [result.before, result.after],
    methodology:
      `${result.methodology} Complete report checks: before=${result.coverage.before.complete}, after=${result.coverage.after.complete}. Missing aggregate inputs remain unavailable; zero on an absent side denotes only non-observation in a complete checked report. Scope=${result.scope}; query=${result.query || "none"}.`.slice(
        0,
        3000,
      ),
  };
}
