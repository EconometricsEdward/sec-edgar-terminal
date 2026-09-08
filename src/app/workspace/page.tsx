import WorkspaceClient from "./WorkspaceClient";
import { buildPageMetadata } from "../../utils/siteMetadata";
export const metadata = buildPageMetadata({
  title: "Research Hub — Portfolio Research, Evidence & Watchlists",
  description:
    "Resume portfolio research, triage a review inbox, compare evidence changes, save screening views, and build source-backed research briefs. Browser-local portfolios, watchlists and backups.",
  path: "/workspace",
});
export default function WorkspacePage() {
  return <WorkspaceClient />;
}
