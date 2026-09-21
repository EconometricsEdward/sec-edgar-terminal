import type { Metadata } from "next";
import { buildPageMetadata } from "../../utils/siteMetadata";
import ReportsClient from "./ReportsClient";

const isPreview = process.env.VERCEL_ENV === "preview";

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: "Reports — Company, Fund & Market PDF and Excel Reports",
    description: "Download company financial statements, public broker-dealer X-17A-5 annual reports, fund portfolios and market research in PDF and Excel with original SEC sources.",
    path: "/reports",
  }),
  ...(isPreview ? { robots: { index: false, follow: false } } : {}),
};

export default function ReportsPage() {
  return <ReportsClient preview={isPreview} />;
}
