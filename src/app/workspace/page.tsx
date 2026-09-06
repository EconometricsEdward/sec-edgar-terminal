import WorkspaceClient from "./WorkspaceClient";
import { buildPageMetadata } from "../../utils/siteMetadata";
export const metadata = buildPageMetadata({
  title: "Research Hub — Saved Evidence & Watchlists",
  description:
    "Find saved research across EDGAR Terminal, review company and fund watchlists, and back up your browser research.",
  path: "/workspace",
});
export default function WorkspacePage() {
  return <WorkspaceClient />;
}
