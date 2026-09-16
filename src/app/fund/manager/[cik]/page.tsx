import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_cache } from "next/cache";
import { buildPageMetadata, SITE_URL } from "../../../../utils/siteMetadata";
import { PUBLIC_FUND_MANAGERS, publicManagerSelection } from "../../../../utils/fundPublicSelectors.js";
import { readPublicManagerSummary } from "../../../../utils/fundPublicResearch.js";
import FundResearchBrief, { type PublicFundSummary } from "../../FundResearchBrief";
import base from "../../fund.module.css";
import s from "../../FundResearchBrief.module.css";

export const runtime = "nodejs";
export const maxDuration = 15;
// Metadata and visible research share one read, including temporary misses.
const readSummary = cache(unstable_cache(
  async (cik: string, period: string) => {
    const summary = await readPublicManagerSummary(cik, period) as PublicFundSummary | null;
    if (summary?.status !== "ready") throw new Error("Manager summary is not prepared");
    return summary;
  },
  ["public-13f-manager-summary-v1"], { revalidate: 60 },
));
type Props = { params: Promise<{ cik: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> };
async function selection({ params, searchParams }: Props) {
  const [{ cik }, query] = await Promise.all([params, searchParams]);
  if (Array.isArray(query?.period)) return null;
  return publicManagerSelection(cik, query?.period ?? "");
}
export async function generateMetadata(props: Props): Promise<Metadata> {
  const selected = await selection(props);
  if (!selected) return { title: "Manager report unavailable", robots: { index: false } };
  const { cik, period } = selected;
  const summary = await readSummary(cik, period).catch(() => null);
  const known = PUBLIC_FUND_MANAGERS.find(manager => manager.cik === cik);
  const name = summary?.name || known?.name || `SEC manager ${cik}`;
  const reportDate = summary?.reportDate;
  const metadata = buildPageMetadata({ title: `${name} — Reported 13F Holdings${reportDate ? `, ${reportDate}` : " & Sources"}`,
    description: `${name} SEC Form 13F holdings${reportDate ? ` as of ${reportDate}` : ""}: disclosed positions, concentration and original filing sources. Reported holdings value is not total assets under management.`,
    path: `/fund/manager/${cik}${period ? `?period=${period}` : ""}`,
  });
  return { ...metadata,
    alternates: { ...metadata.alternates, types: { "application/json": `${SITE_URL}/api/v1/managers/${cik}${period ? `?period=${period}` : ""}` } },
    ...((period || !known) && summary?.status !== "ready" ? { robots: { index: false } } : {}) };
}
export default async function ManagerResearchPage(props: Props) {
  const selected = await selection(props);
  if (!selected) notFound();
  const { cik, period } = selected;
  const result = await readSummary(cik, period).catch(() => null);
  const summary: PublicFundSummary = result || {
    kind: "13f", status: "unavailable", cik,
    name: PUBLIC_FUND_MANAGERS.find(manager => manager.cik === cik)?.name || `SEC manager ${cik}`,
    stale: false, valueLabel: "Reported 13F holdings value", topHoldings: [], sources: [],
    limitations: ["Form 13F covers reportable securities, not all assets, cash, short positions or investment performance. A missing prepared report is not evidence of an empty portfolio."],
    reason: period ? `A prepared report for the quarter ended ${period} is not available.` : "A verified summary is not currently available.",
    interactiveUrl: `/fund?view=13f&managerCik=${cik}${period ? `&managerPeriod=${period}` : ""}`,
    summaryUrl: `/fund/manager/${cik}${period ? `?period=${period}` : ""}`,
  };
  return <div className={base.page}>
    <Link href="/fund" prefetch={false} className={s.back}>← Funds & institutional managers</Link>
    <FundResearchBrief summary={summary} standalone canonicalPath={`/fund/manager/${cik}${period ? `?period=${period}` : ""}`} jsonUrl={`/api/v1/managers/${cik}${period ? `?period=${period}` : ""}`} />
  </div>;
}
