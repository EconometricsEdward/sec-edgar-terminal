import type { Metadata } from "next";
import { buildPageMetadata } from "../../utils/siteMetadata";
import ReportsClient from "./ReportsClient";

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: "Reports — Company, Fund & Market PDF and Excel Reports",
    description: "Download company financial statements, fund portfolios and market reports in PDF and Excel, with sector fundamentals and relevant CFTC positioning.",
    path: "/reports",
  }),
  robots: { index: false, follow: false },
};

export default function ReportsPage() {
  return <ReportsClient />;
}
