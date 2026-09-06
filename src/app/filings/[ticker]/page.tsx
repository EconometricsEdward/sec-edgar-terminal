import type { Metadata } from "next";
import FilingsClient from "./FilingsClient";
import { buildPageMetadata } from "../../../utils/siteMetadata";
import { getOperatingTicker } from "../../../utils/tickerMap.js";
import { validTicker } from "../../../utils/researchWorkspace.js";

export const revalidate = 3600;
type PageProps = { params: Promise<{ ticker: string }> };
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const ticker = (await params).ticker.trim().toUpperCase();
  let name = ticker;
  if (validTicker(ticker)) {
    try {
      const entry = await getOperatingTicker(ticker);
      name = entry?.name || ticker;
    } catch {
      /* The explorer reports retriable SEC lookup failures. */
    }
  }
  return buildPageMetadata({
    title: `${name} (${ticker}) — SEC Filings`,
    description: `Search ${name} SEC filings, inspect archive coverage, compare reports, and collect source-linked evidence in your filing review workspace.`,
    path: `/filings/${encodeURIComponent(ticker)}`,
  });
}
export default async function FilingsTickerPage({ params }: PageProps) {
  const ticker = (await params).ticker.trim().toUpperCase();
  return <FilingsClient key={ticker} ticker={ticker} />;
}
