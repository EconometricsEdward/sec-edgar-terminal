import type { MetadataRoute } from "next";
import { SITE_URL } from "../utils/siteMetadata";

type SitemapEntry = MetadataRoute.Sitemap[number];
type ChangeFrequency = NonNullable<SitemapEntry["changeFrequency"]>;

const MAIN_PAGES: Array<
  [path: string, changeFrequency: ChangeFrequency, priority: number]
> = [
  ["/", "weekly", 1],
  ["/about", "monthly", 0.6],
  ["/help", "monthly", 0.7],
  ["/market", "weekly", 0.8],
  ["/filings", "weekly", 0.8],
  ["/analysis", "weekly", 0.8],
  ["/risk", "weekly", 0.8],
  ["/compare", "weekly", 0.8],
  ["/fund", "weekly", 0.8],
  ["/disclosures", "weekly", 0.8],
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

const FEATURED_FUNDS = [
  "SPY",
  "VOO",
  "QQQ",
  "VTI",
  "ARKK",
  "IWM",
  "BND",
  "VXUS",
];

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

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...MAIN_PAGES.map(([path, changeFrequency, priority]) =>
      sitemapEntry(path, changeFrequency, priority),
    ),
    ...FEATURED_ANALYSIS_TICKERS.map((ticker) =>
      sitemapEntry(`/analysis/${ticker}`, "weekly", 0.9),
    ),
    ...FEATURED_FILING_TICKERS.map((ticker) =>
      sitemapEntry(`/filings/${ticker}`, "weekly", 0.85),
    ),
    ...FEATURED_FUNDS.map((ticker) =>
      sitemapEntry(`/fund/${ticker}`, "weekly", 0.8),
    ),
    ...FEATURED_COMPARISONS.map((tickers) =>
      sitemapEntry(`/compare/${tickers}`, "weekly", 0.8),
    ),
  ];
}
