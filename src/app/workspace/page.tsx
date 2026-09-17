import type { Metadata } from "next";
import WorkspaceClient from "./WorkspaceClient";
import { buildPageMetadata } from "../../utils/siteMetadata";

type WorkspacePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const portfolioMetadata = buildPageMetadata({
  title: "Portfolio Analytics — SEC Financials & CFTC Context",
  description:
    "Upload a portfolio or explore the demo. Analyze holdings, financial characteristics, concentration, SEC filings, and connected CFTC futures-market positioning.",
  path: "/workspace",
});

export async function generateMetadata({ searchParams }: WorkspacePageProps): Promise<Metadata> {
  const query = await searchParams;
  const privateWorkspace = (query.view !== undefined && query.view !== "overview") ||
    ["portfolio", "row", "portfolioView", "portfolioTab", "analyticsArea", "holdingsMode"].some((key) => key in query);
  return {
    ...portfolioMetadata,
    ...(privateWorkspace ? { robots: { index: false, follow: true } } : {}),
  };
}

export default function WorkspacePage() {
  return <WorkspaceClient />;
}
