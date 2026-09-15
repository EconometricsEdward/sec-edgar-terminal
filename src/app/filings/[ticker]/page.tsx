import type { Metadata } from "next";
import FilingsClient from "./FilingsClient";
import { buildPageMetadata } from "../../../utils/siteMetadata";
import { getOperatingTicker } from "../../../utils/tickerMap.js";
import { validTicker } from "../../../utils/researchWorkspace.js";
import { normalizeCikIdentifier } from "../../../utils/siteRoutes.js";
import { loadFilingsCompany } from "../../../utils/filingsResearchServer.js";

export const revalidate = 3600;
type PageProps = { params: Promise<{ ticker: string }> };
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const raw = (await params).ticker.trim().toUpperCase();
  const cik = normalizeCikIdentifier(raw);
  const ticker = cik || raw;
  let name = ticker;
  if (cik) {
    try {
      name = (await loadFilingsCompany(cik)).name;
    } catch {
      /* The explorer provides a retry for unavailable SEC submissions. */
    }
  } else if (validTicker(ticker)) {
    try {
      const entry = await getOperatingTicker(ticker);
      name = entry?.name || ticker;
    } catch {
      /* The explorer reports retriable SEC lookup failures. */
    }
  }
  return buildPageMetadata({
    title: `${name} (${cik ? "CIK " : ""}${ticker}) — SEC Filings`,
    description: `Search ${name} SEC filings, inspect archive coverage, compare reports, and collect source-linked evidence in your filing review workspace.`,
    path: `/filings/${encodeURIComponent(ticker)}`,
  });
}
export default async function FilingsTickerPage({ params }: PageProps) {
  const raw = (await params).ticker.trim().toUpperCase();
  const ticker = normalizeCikIdentifier(raw) || raw;
  return <FilingsClient key={ticker} ticker={ticker} />;
}
