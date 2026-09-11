import WorkspaceClient from "./WorkspaceClient";
import { buildPageMetadata } from "../../utils/siteMetadata";
export const metadata = buildPageMetadata({
  title: "Research Hub — Portfolio Overview & Research",
  description:
    "Explore saved portfolios, compare company financials, examine concentration, search SEC filings and disclosures, and export portfolio research.",
  path: "/workspace",
});
export default function WorkspacePage() {
  return <WorkspaceClient />;
}
