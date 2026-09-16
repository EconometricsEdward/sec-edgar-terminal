import WorkspaceClient from "./WorkspaceClient";
import { buildPageMetadata } from "../../utils/siteMetadata";
export const metadata = buildPageMetadata({
  title: "Portfolio — Upload & Research",
  description:
    "Upload your portfolio or explore the demo. Research company financials, concentration, SEC filings and recent changes in one place.",
  path: "/workspace",
});
export default function WorkspacePage() {
  return <WorkspaceClient />;
}
