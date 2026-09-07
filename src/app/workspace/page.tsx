import WorkspaceClient from "./WorkspaceClient";
import { buildPageMetadata } from "../../utils/siteMetadata";
export const metadata = buildPageMetadata({
  title: "Research Hub — Portfolio Research, Evidence & Watchlists",
  description:
    "Upload a portfolio or company list, research up to 100 issuers with SEC evidence, review allocations and filings, and export source-backed research. Browser-local portfolios, watchlists and backups.",
  path: "/workspace",
});
export default function WorkspacePage() {
  return <WorkspaceClient />;
}
