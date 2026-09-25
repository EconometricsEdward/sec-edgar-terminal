import type { MetadataRoute } from "next";
import { SITE_URL } from "../utils/siteMetadata";
import { FUND_CATALOG } from "../utils/fundResearch";
import { PUBLIC_FUND_MANAGERS } from "../utils/fundPublicSelectors.js";
import { getActiveSecCoverageCompanies, loadSecCoverageRegistry } from "../utils/secCoverageRegistry.js";
export const revalidate = 3600;

type SitemapEntry = MetadataRoute.Sitemap[number];
type ChangeFrequency = NonNullable<SitemapEntry["changeFrequency"]>;

const MAIN_PAGES: Array<
  [path: string, changeFrequency: ChangeFrequency, priority: number]
> = [
  ["/", "weekly", 1],
  ["/about", "monthly", 0.6],
  ["/terms", "monthly", 0.3],
  ["/privacy", "monthly", 0.3],
  ["/market", "weekly", 0.8],
  ["/filings", "weekly", 0.8],
  ["/analysis", "weekly", 0.8],
  ["/analysis/banks", "weekly", 0.8],
  ["/analysis/scenarios", "monthly", 0.7],
  ["/risk", "weekly", 0.8],
  ["/compare", "weekly", 0.8],
  ["/fund", "weekly", 0.8],
  ["/disclosures", "weekly", 0.8],
  ["/reports", "weekly", 0.8],
  ["/workspace", "weekly", 0.8],
  ["/workspace/demo", "monthly", 0.6],
  ["/workspace/demo/changes", "daily", 0.75],
  ["/workspace/portfolio-guide", "monthly", 0.7],
];

const FEATURED_ANALYSIS_TICKERS = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "META",
  "NVDA",
  "TSLA",
  "JPM",
  "BAC",
  "C",
  "WFC",
  "GS",
  "XOM",
  "CVX",
  "WMT",
  "TGT",
];

const FEATURED_FILING_TICKERS = ["AAPL", "JPM", "NVDA", "XOM"];

const FEATURED_COMPARISONS = [
  "AAPL,MSFT,GOOGL,META,AMZN",
  "JPM,BAC,WFC,C,GS",
  "NVDA,AMD,INTC,AVGO,QCOM",
];

function sitemapEntry(
  path: string,
  changeFrequency: ChangeFrequency,
  priority: number,
): SitemapEntry {
  return {
    url: `${SITE_URL}${path}`,
    changeFrequency,
    priority,
  };
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await loadSecCoverageRegistry();
  const analysisTickers = [...new Set([...FEATURED_ANALYSIS_TICKERS, ...getActiveSecCoverageCompanies().map(company => company.ticker)])];
  return [
    ...MAIN_PAGES.map(([path, changeFrequency, priority]) =>
      sitemapEntry(path, changeFrequency, priority),
    ),
    ...analysisTickers.map((ticker) =>
      sitemapEntry(`/analysis/${ticker}`, "weekly", 0.9),
    ),
    ...FEATURED_FILING_TICKERS.map((ticker) =>
      sitemapEntry(`/filings/${ticker}`, "weekly", 0.85),
    ),
    ...FUND_CATALOG.map(({ ticker }) =>
      sitemapEntry(`/fund/${ticker}`, "weekly", 0.8),
    ),
    ...PUBLIC_FUND_MANAGERS.map((manager) =>
      sitemapEntry(`/fund/manager/${manager.cik}`, "weekly", 0.8),
    ),
    ...FEATURED_COMPARISONS.map((tickers) =>
      sitemapEntry(`/compare/${tickers}`, "weekly", 0.8),
    ),
  ];
}
