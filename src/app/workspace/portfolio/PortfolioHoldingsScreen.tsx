"use client";

import { useMemo } from "react";
import { buildPortfolioAnalytics } from "../../../utils/portfolioAnalytics.js";
import { buildCatalogReport } from "../../../utils/portfolioEnrichment.js";
import PortfolioScreener from "./PortfolioScreener";

export default function PortfolioHoldingsScreen({ rows, settings, companies, capturedAt, onInspectCompany, onDisclosure }: {
  rows: any[];
  settings: any;
  companies: any[];
  capturedAt?: string | null;
  onInspectCompany: (rowId: string) => void;
  onDisclosure?: (query: string, ciks: string[]) => void;
}) {
  const report = useMemo(() => buildPortfolioAnalytics(rows, settings, companies, { capturedAt }), [rows, settings, companies, capturedAt]);
  const catalog = useMemo(() => buildCatalogReport(report, companies), [report, companies]);
  return <PortfolioScreener embedded report={catalog} companies={companies} onInspectCompany={onInspectCompany} onDisclosure={onDisclosure} />;
}
