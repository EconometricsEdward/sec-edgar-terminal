import type { Metadata } from "next";
import { buildPageMetadata } from "../../utils/siteMetadata";
import ReportsClient from "./ReportsClient";

export const metadata: Metadata = {
  ...buildPageMetadata({
    title: "Reports — Company & Fund PDF and Excel Reports",
    description: "Prepare a structured company, N-PORT fund or institutional manager report from public SEC disclosures. Download a PDF brief and an Excel workbook with source references.",
    path: "/reports",
  }),
  robots: { index: false, follow: false },
};

export default function ReportsPage() {
  return <ReportsClient />;
}
