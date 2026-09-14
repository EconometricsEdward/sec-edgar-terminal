import { scenarioMarketCandidates } from "./portfolioScenarioMarket.js";

const cache = new Map();
const TTL = 10 * 60_000;
const BATCH = 12;
export const PORTFOLIO_MARKET_SCAN_LIMIT = 500;
const identity = (company) => `${company.cik}:${company.ticker}`;

export function clearPortfolioMarketConnections(companies) {
  for (const company of companies) cache.delete(identity(company));
}

/** Fetch a bounded batch at a time; retain successful results across tab changes.
 * @param {any[]} companies
 * @param {{signal?: AbortSignal, onProgress?: (results: any[]) => void, fetchImpl?: typeof fetch}} options
 */
export async function scanPortfolioMarketConnections(
  companies,
  { signal, onProgress = () => {}, fetchImpl = fetch } = {},
) {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key);
  const selected = [
    ...new Map(
      companies.map((company) => [
        identity(company),
        { cik: company.cik, ticker: company.ticker },
      ]),
    ).values(),
  ].slice(0, PORTFOLIO_MARKET_SCAN_LIMIT);
  const results = new Map();
  const waiting = [];
  for (const company of selected) {
    const cached = cache.get(identity(company));
    if (cached) results.set(identity(company), cached.value);
    else waiting.push(company);
  }
  const publish = () => onProgress([...results.values()]);
  publish();
  for (let offset = 0; offset < waiting.length; offset += BATCH) {
    if (signal?.aborted) break;
    const batch = waiting.slice(offset, offset + BATCH);
    let data;
    let failure = "";
    let rateLimited = false;
    try {
      const response = await fetchImpl("/api/v1/cftc/portfolio-connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ companies: batch }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(55_000)])
          : AbortSignal.timeout(55_000),
      });
      rateLimited = response.status === 429;
      data = await response.json().catch(() => null);
      if (
        !response.ok ||
        data?.schemaVersion !== "edgar.portfolio-market-connections.v1" ||
        !Array.isArray(data.results)
      )
        throw new Error(
          data?.error || "Filing connections are temporarily unavailable.",
        );
    } catch (error) {
      if (signal?.aborted) break;
      failure = String(
        error?.message || "The filing scan could not complete.",
      ).slice(0, 300);
    }
    for (const company of batch) {
      const matches = !failure
        ? data.results.filter(
            (result) =>
              result?.cik === company.cik && result.ticker === company.ticker,
          )
        : [];
      const result =
        matches.length === 1
          ? matches[0]
          : {
              ...company,
              status: "unavailable",
              context: null,
              message:
                failure ||
                "The response did not contain a unique matching company.",
            };
      results.set(identity(company), result);
      const verified = scenarioMarketCandidates(result.context, company, "");
      if (
        ["ready", "no_matches", "no_filing"].includes(result.status) &&
        result.context?.status === result.status &&
        verified.verified &&
        verified.omitted === 0 &&
        (result.status !== "ready" || verified.links.length > 0)
      ) {
        while (cache.size >= PORTFOLIO_MARKET_SCAN_LIMIT)
          cache.delete(cache.keys().next().value);
        cache.set(identity(company), {
          value: result,
          until: Date.now() + TTL,
        });
      }
    }
    publish();
    if (rateLimited) break;
  }
  return [...results.values()];
}
