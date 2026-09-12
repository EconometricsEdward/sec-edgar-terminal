/** Compact checkpoint observations; the public comparison model remains expanded. */
export const PORTFOLIO_BASELINE_METRIC_LIMIT = 128;
export function packPortfolioBaseline(value) {
  if (!value || value.metricEncoding) return value;
  const descriptors = [],
    lookup = new Map();
  const companies = value.companies.map((company) => ({
    ...company,
    metrics: Object.fromEntries(
      Object.entries(company.metrics).map(([key, p]) => {
        const descriptor = [p.unit, p.label],
          signature = JSON.stringify(descriptor);
        if (!lookup.has(signature)) {
          lookup.set(signature, descriptors.length);
          descriptors.push(descriptor);
        }
        return [
          key,
          [p.value, lookup.get(signature), p.period, p.definition, p.sources],
        ];
      }),
    ),
  }));
  return {
    ...value,
    metricEncoding: "portfolio-checkpoint-tuples-v1",
    metricDescriptors: descriptors,
    companies,
  };
}
export function unpackPortfolioBaseline(value) {
  if (!value?.metricEncoding) return value;
  const { metricEncoding, metricDescriptors, ...rest } = value;
  if (
    metricEncoding !== "portfolio-checkpoint-tuples-v1" ||
    !Array.isArray(metricDescriptors) ||
    metricDescriptors.length > 2000 ||
    !Array.isArray(value.companies) ||
    value.companies.length > 100
  )
    throw new Error("Invalid comparison checkpoint encoding.");
  if (
    metricDescriptors.some(
      (d) =>
        !Array.isArray(d) ||
        d.length !== 2 ||
        typeof d[0] !== "string" ||
        d[0].length > 100 ||
        typeof d[1] !== "string" ||
        d[1].length > 200,
    )
  )
    throw new Error("Invalid comparison checkpoint descriptors.");
  return {
    ...rest,
    companies: value.companies.map((c) => {
      if (
        !c.metrics ||
        typeof c.metrics !== "object" ||
        Object.keys(c.metrics).length > PORTFOLIO_BASELINE_METRIC_LIMIT
      )
        throw new Error("Invalid comparison checkpoint metrics.");
      return {
        ...c,
        metrics: Object.fromEntries(
          Object.entries(c.metrics).map(([key, p]) => {
            if (
              !Array.isArray(p) ||
              p.length !== 5 ||
              !Number.isInteger(p[1]) ||
              p[1] < 0 ||
              p[1] >= metricDescriptors.length
            )
              throw new Error("Invalid comparison checkpoint reference.");
            const [unit, label] = metricDescriptors[p[1]];
            return [
              key,
              {
                value: p[0],
                unit,
                label,
                period: p[2],
                definition: p[3],
                sources: p[4],
              },
            ];
          }),
        ),
      };
    }),
  };
}
