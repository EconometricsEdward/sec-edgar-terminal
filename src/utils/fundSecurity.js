// Identifier matching is shared by fund comparisons, allocations, and changes.
// Names and ticker symbols are descriptive only; they never establish a match.
export function normalizeSecurityIdentity(holding = {}) {
  const text = (value) =>
    typeof value === "string" ? value.trim().toUpperCase() : "";
  const usable = (value) =>
    value && !/^(N\/?A|NONE|0+|UNKNOWN|NOT AVAILABLE)$/.test(value);
  const rawCusip = text(holding.cusip),
    rawIsin = text(holding.isin);
  const cusip =
    usable(rawCusip) && /^[A-Z0-9*@#]{9}$/.test(rawCusip) ? rawCusip : null;
  const isin =
    usable(rawIsin) && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(rawIsin)
      ? rawIsin
      : null;
  const ids = [
    ...(cusip ? [`CUSIP:${cusip}`] : []),
    ...(isin ? [`ISIN:${isin}`] : []),
  ];
  return { cusip, isin, ids, key: ids[0] || null };
}
export function securityEligibility(holding = {}) {
  if (!Number.isFinite(holding.pctOfNav))
    return { eligible: false, reason: "NAV weight unavailable" };
  if (holding.pctOfNav <= 0)
    return { eligible: false, reason: "Zero or negative NAV weight" };
  if (String(holding.payoffProfile || "").toLowerCase() !== "long")
    return { eligible: false, reason: "Position is not explicitly long" };
  if (/^D(IR|CR|FE|E|CO|O)$/.test(holding.assetCat || ""))
    return {
      eligible: false,
      reason: "Derivative fair value is not underlying exposure",
    };
  return { eligible: true, reason: null };
}
export function resolveSecurityGroups(portfolios = []) {
  const parent = new Map(),
    positions = [],
    unidentified = [];
  const find = (id) => {
    if (!parent.has(id)) parent.set(id, id);
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (a, b) => {
    const left = find(a),
      right = find(b);
    if (left !== right) parent.set(right, left);
  };
  portfolios.forEach((portfolio, portfolioIndex) =>
    (portfolio.holdings || []).forEach((holding, holdingIndex) => {
      const identity = normalizeSecurityIdentity(holding);
      const position = { portfolioIndex, holdingIndex, holding, identity };
      if (!identity.ids.length) {
        unidentified.push(position);
        return;
      }
      identity.ids.forEach(find);
      if (identity.ids.length > 1) union(identity.ids[0], identity.ids[1]);
      positions.push(position);
    }),
  );
  const map = new Map();
  for (const position of positions) {
    const root = find(position.identity.ids[0]);
    const group = map.get(root) || { ids: new Set(), positions: [] };
    position.identity.ids.forEach((id) => group.ids.add(id));
    group.positions.push(position);
    map.set(root, group);
  }
  const groups = [],
    ambiguous = [];
  for (const value of map.values()) {
    const ids = [...value.ids].sort();
    const conflicted =
      ids.filter((id) => id.startsWith("CUSIP:")).length > 1 ||
      ids.filter((id) => id.startsWith("ISIN:")).length > 1;
    const group = {
      key: ids.find((id) => id.startsWith("CUSIP:")) || ids[0],
      ids,
      name: value.positions[0].holding.name || "Unnamed security",
      positions: value.positions,
      ambiguous: conflicted,
    };
    (conflicted ? ambiguous : groups).push(group);
  }
  groups.sort((a, b) => a.key.localeCompare(b.key));
  ambiguous.sort((a, b) => a.key.localeCompare(b.key));
  return { groups, unidentified, ambiguous };
}
export function fundEvidence(portfolio) {
  return {
    ticker: portfolio.ticker ?? null,
    name: portfolio.name ?? null,
    cik: portfolio.cik ?? null,
    seriesId: portfolio.seriesId ?? null,
    classId: portfolio.classId ?? null,
    asOf: portfolio.asOf ?? null,
    filingDate: portfolio.filingDate ?? null,
    accession: portfolio.accession ?? null,
    form: portfolio.form ?? null,
    sourceUrl: portfolio.sourceUrl ?? null,
    filingUrl: portfolio.filingUrl ?? null,
    retrievedAt: portfolio.retrievedAt ?? null,
  };
}
export function fundCsv(rows) {
  const escape = (value) => {
    let text = value == null ? "" : String(value);
    if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text))
      text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return rows.map((row) => row.map(escape).join(",")).join("\r\n");
}
