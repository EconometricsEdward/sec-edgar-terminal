import {
  packPortfolioBaseline,
  unpackPortfolioBaseline,
} from "./portfolioBaselineCodec.js";
/** Deduplicate repeated public evidence without discarding any metric or source. */
const ENCODING = "portfolio-evidence-pool-v1";
export const PORTFOLIO_DECODED_LIMIT = 32 * 1024 * 1024;
const byteLength = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
function checkExpansion(companies) {
  let total = 0;
  for (const company of companies) {
    total += byteLength(company);
    if (company?.evidenceEncoding) {
      const pools = [
        company.sourcePool,
        company.calculationPool,
        company.periodPool,
      ];
      if (!pools.every((p) => Array.isArray(p) && p.length <= 2000))
        throw new Error("Invalid portfolio evidence catalog.");
      const sizes = pools.map((p) => p.map(byteLength));
      for (const point of Object.values(company.metrics || {})) {
        for (const [ids, pool] of [
          [point.sourceIds, sizes[0]],
          [point.calculationIds, sizes[1]],
          [point.periodId === undefined ? [] : [point.periodId], sizes[2]],
        ]) {
          if (ids === undefined) continue;
          if (!Array.isArray(ids) || ids.length > 100)
            throw new Error("Invalid portfolio metric evidence references.");
          for (const id of ids) {
            if (!Number.isInteger(id) || id < 0 || id >= pool.length)
              throw new Error("Invalid portfolio evidence reference.");
            total += pool[id];
            if (total > PORTFOLIO_DECODED_LIMIT)
              throw new Error(
                "Expanded portfolio evidence exceeds its safe memory budget.",
              );
          }
        }
      }
    }
    if (total > PORTFOLIO_DECODED_LIMIT)
      throw new Error(
        "Expanded portfolio evidence exceeds its safe memory budget.",
      );
  }
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export function packPortfolioCompany(company) {
  if (!company?.metrics || company.evidenceEncoding) return company;
  const sourcePool = [],
    calculationPool = [],
    periodPool = [];
  const maps = [new Map(), new Map(), new Map()];
  const intern = (value, pool, index) => {
    const key = JSON.stringify(value);
    if (!maps[index].has(key)) {
      maps[index].set(key, pool.length);
      pool.push(value);
    }
    return maps[index].get(key);
  };
  const metrics = Object.fromEntries(
    Object.entries(company.metrics).map(([key, point]) => {
      const { sources, calculations, period, ...rest } = point;
      return [
        key,
        {
          ...rest,
          ...(own(point, "sources")
            ? { sourceIds: sources.map((s) => intern(s, sourcePool, 0)) }
            : {}),
          ...(own(point, "calculations")
            ? {
                calculationIds: calculations.map((c) =>
                  intern(c, calculationPool, 1),
                ),
              }
            : {}),
          ...(own(point, "period")
            ? { periodId: intern(period, periodPool, 2) }
            : {}),
        },
      ];
    }),
  );
  return {
    ...company,
    evidenceEncoding: ENCODING,
    sourcePool,
    calculationPool,
    periodPool,
    metrics,
  };
}
export function unpackPortfolioCompany(company) {
  if (!company?.evidenceEncoding) return company;
  checkExpansion([company]);
  if (company.evidenceEncoding !== ENCODING)
    throw new Error("Unsupported portfolio evidence encoding.");
  const {
    evidenceEncoding: _encoding,
    sourcePool,
    calculationPool,
    periodPool,
    ...rest
  } = company;
  if (
    ![sourcePool, calculationPool, periodPool].every(
      (p) => Array.isArray(p) && p.length <= 2000,
    )
  )
    throw new Error("Invalid portfolio evidence catalog.");
  const resolve = (pool, id) => {
    if (!Number.isInteger(id) || id < 0 || id >= pool.length)
      throw new Error("Invalid portfolio evidence reference.");
    return pool[id];
  };
  return {
    ...rest,
    metrics: Object.fromEntries(
      Object.entries(company.metrics).map(([key, point]) => {
        const { sourceIds, calculationIds, periodId, ...metric } = point;
        if (
          [sourceIds, calculationIds].some(
            (ids) =>
              ids !== undefined && (!Array.isArray(ids) || ids.length > 100),
          )
        )
          throw new Error("Invalid portfolio metric evidence references.");
        return [
          key,
          {
            ...metric,
            ...(sourceIds !== undefined
              ? { sources: sourceIds.map((id) => resolve(sourcePool, id)) }
              : {}),
            ...(calculationIds !== undefined
              ? {
                  calculations: calculationIds.map((id) =>
                    resolve(calculationPool, id),
                  ),
                }
              : {}),
            ...(periodId !== undefined
              ? { period: resolve(periodPool, periodId) }
              : {}),
          },
        ];
      }),
    ),
  };
}
export const packPortfolioSnapshot = (snapshot) => {
  if (!snapshot || snapshot.metricTemplateEncoding) return snapshot;
  const templates = [],
    byValue = new Map();
  const companies = (snapshot.companies || [])
    .map(packPortfolioCompany)
    .map((company) => ({
      ...company,
      metrics: Object.fromEntries(
        Object.entries(company.metrics || {}).map(([key, point]) => {
          const { value, sourceIds, calculationIds, periodId, ...metadata } =
            point;
          const signature = JSON.stringify(metadata);
          if (!byValue.has(signature)) {
            byValue.set(signature, templates.length);
            templates.push(metadata);
          }
          return [
            key,
            {
              ...(own(point, "value") ? { value } : {}),
              templateId: byValue.get(signature),
              ...(own(point, "sourceIds") ? { sourceIds } : {}),
              ...(own(point, "calculationIds") ? { calculationIds } : {}),
              ...(own(point, "periodId") ? { periodId } : {}),
            },
          ];
        }),
      ),
    }));
  if (templates.length > 2000)
    return {
      ...snapshot,
      companies: (snapshot.companies || []).map(packPortfolioCompany),
    };
  return {
    ...snapshot,
    metricTemplateEncoding: "portfolio-metric-templates-v1",
    metricTemplates: templates,
    companies,
  };
};
export const unpackPortfolioSnapshot = (snapshot) => {
  if (!snapshot) return snapshot;
  let companies = snapshot.companies || [];
  const { metricTemplateEncoding, metricTemplates, ...rest } = snapshot;
  if (metricTemplateEncoding) {
    if (
      metricTemplateEncoding !== "portfolio-metric-templates-v1" ||
      !Array.isArray(metricTemplates) ||
      metricTemplates.length > 2000
    )
      throw new Error("Invalid portfolio metric templates.");
    const sizes = metricTemplates.map(byteLength);
    let cost = byteLength(snapshot);
    for (const company of companies)
      for (const point of Object.values(company.metrics || {})) {
        if (
          !Number.isInteger(point.templateId) ||
          point.templateId < 0 ||
          point.templateId >= sizes.length
        )
          throw new Error("Invalid portfolio metric template reference.");
        cost += sizes[point.templateId];
        if (cost > PORTFOLIO_DECODED_LIMIT)
          throw new Error(
            "Expanded portfolio evidence exceeds its safe memory budget.",
          );
      }
    companies = companies.map((company) => ({
      ...company,
      metrics: Object.fromEntries(
        Object.entries(company.metrics || {}).map(
          ([key, { templateId, ...point }]) => [
            key,
            { ...metricTemplates[templateId], ...point },
          ],
        ),
      ),
    }));
  }
  checkExpansion(companies);
  return { ...rest, companies: companies.map(unpackPortfolioCompany) };
};
export const packPortfolioStore = (store) => ({
  ...store,
  portfolios: store.portfolios.map((p) => ({
    ...p,
    snapshot: packPortfolioSnapshot(p.snapshot),
    ...(p.comparisonBaseline
      ? { comparisonBaseline: packPortfolioBaseline(p.comparisonBaseline) }
      : {}),
  })),
});
export const unpackPortfolioStore = (store) => {
  let decodedBytes = 0;

  return {
    ...store,
    portfolios: store.portfolios.map((p) => {
      const snapshot = unpackPortfolioSnapshot(p.snapshot);
      decodedBytes += byteLength(snapshot);
      if (decodedBytes > PORTFOLIO_DECODED_LIMIT)
        throw new Error(
          "Expanded portfolio evidence exceeds its safe memory budget.",
        );
      return {
        ...p,
        snapshot,
        ...(p.comparisonBaseline
          ? {
              comparisonBaseline: unpackPortfolioBaseline(p.comparisonBaseline),
            }
          : {}),
      };
    }),
  };
};
