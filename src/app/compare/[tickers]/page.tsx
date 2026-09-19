import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CompareClient from "./CompareClient";
import { buildPageMetadata } from "../../../utils/siteMetadata";
import { comparePageMetadata, comparePageSelection } from "../../../utils/comparePublicMetadata.js";

interface PageProps {
  params: Promise<{ tickers: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Metadata and the initial shell need no SEC directory or financial requests.
// The workspace resolves identities through its shared, validated data loader.
export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const [{ tickers }, query] = await Promise.all([params, searchParams]);
  const { index, ...metadata } = comparePageMetadata(comparePageSelection(tickers), query);
  return {
    ...buildPageMetadata({ ...metadata, path: metadata.path as `/${string}` }),
    robots: { index, follow: true },
  };
}

export default async function CompareTickersPage({ params }: PageProps) {
  const { tickers: raw } = await params;
  const selection = comparePageSelection(raw);
  if (!selection) notFound();
  return <CompareClient initialTickers={selection.tickers} preloadedCompanies={[]} />;
}
