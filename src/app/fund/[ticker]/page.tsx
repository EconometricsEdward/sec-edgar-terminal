import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { buildPageMetadata } from "../../../utils/siteMetadata";
import { FUND_CATALOG } from "../../../utils/fundResearch";
import FundClient from "./FundClient";
interface Props {
  params: Promise<{ ticker: string }>;
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ticker = (await params).ticker.toUpperCase();
  const name = FUND_CATALOG.find((f) => f.ticker === ticker)?.name || ticker;
  return buildPageMetadata({
    title: `${name} (${ticker}) — Holdings & Portfolio Research`,
    description: `Explore SEC-reported positions, net assets, concentration, and source filings for ${ticker}.`,
    path: `/fund/${ticker}`,
  });
}
export default async function FundPage({ params }: Props) {
  const ticker = (await params).ticker.toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)) notFound();
  return (
    <Suspense fallback={<p role="status">Opening fund research…</p>}>
      <FundClient key={ticker} urlTicker={ticker} />
    </Suspense>
  );
}
