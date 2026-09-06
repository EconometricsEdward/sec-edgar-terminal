import type { Metadata } from "next";
import DisclosureSearchClient from "./DisclosureSearchClient";
import { buildPageMetadata } from "../../utils/siteMetadata";
import { legacyDisclosureQuery } from "../../utils/disclosureQuery.js";
import type { SearchSettings } from "./disclosureTypes";

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: "SEC Disclosure Research — Search, Compare & Collect Evidence",
    description:
      "Search SEC disclosures with precise Boolean queries, an integrated filing reader, changes across reports, company-topic comparisons, coverage-aware trends, saved searches, and exportable evidence collections.",
    path: "/disclosures",
  }),
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function DisclosuresPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const initialQuery = firstParam(params.query) || firstParam(params.keywords);
  const initialFocus =
    firstParam(params.focus) ||
    firstParam(params.ticker) ||
    firstParam(params.cik) ||
    firstParam(params.company);
  const initialTickers = firstParam(params.tickers);
  const initialMode = firstParam(params.mode);
  const initialMatchMode =
    firstParam(params.match) || firstParam(params.matchMode);

  const initial: Partial<SearchSettings> = {
    query: legacyDisclosureQuery(initialQuery || "liquidity", initialMatchMode),
    tickers: initialTickers || initialFocus,
    mode:
      initialMode === "index" || initialMode === "edgar-index"
        ? "index"
        : "companies",
  };
  for (const key of ["start", "end", "forms", "section", "scope"] as const) {
    const value = firstParam(params[key]);
    if (value)
      (initial as Record<string, string | number | boolean>)[key] = value;
  }
  if (firstParam(params.depth))
    initial.depth = Number(firstParam(params.depth));
  initial.amendments = firstParam(params.amendments) === "true";
  return <DisclosureSearchClient initial={initial} />;
}
