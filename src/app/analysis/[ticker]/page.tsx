import type { Metadata } from "next";
import AnalysisClient from "./AnalysisWorkspace";
import { buildPageMetadata } from "../../../utils/siteMetadata";

// ============================================================================
// Route configuration
//
// The server now resolves only lightweight ticker metadata for SEO and first
// paint. Financial statements are compacted by /api/analysis-research on the server,
// which avoids writing large SEC submissions JSON into the Next.js Data Cache.
// ============================================================================
export const revalidate = 3600;

// ============================================================================
// Types
// ============================================================================
interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface CompanyTickersFile {
  [key: string]: CompanyTickerEntry;
}

interface PageProps {
  params: Promise<{ ticker: string }>;
}

interface CompanyMeta {
  ticker: string;
  cik: string;
  name: string;
  sicDescription: string | null;
  exchange: string | null;
}

// ============================================================================
// Server-side ticker → lightweight company metadata
//
// We intentionally use SEC's company_tickers.json only. It gives us the CIK and
// company title needed for metadata, JSON-LD, and the initial page shell without
// fetching the much larger /submissions/CIK*.json payload server-side.
// ============================================================================
async function getCompanyMeta(ticker: string): Promise<CompanyMeta | null> {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) {
    console.error("[analysis/[ticker]] SEC_USER_AGENT env var is not set");
    return null;
  }

  try {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": userAgent },
      next: { revalidate: 86400 },
    });

    if (!res.ok) {
      console.error(
        `[analysis/[ticker]] ticker-map fetch returned ${res.status}`,
      );
      return null;
    }

    const data = (await res.json()) as CompanyTickersFile;
    const upper = ticker.toUpperCase();

    for (const entry of Object.values(data)) {
      if (entry?.ticker?.toUpperCase() === upper) {
        return {
          ticker: upper,
          cik: String(entry.cik_str).padStart(10, "0"),
          name: entry.title || upper,
          sicDescription: null,
          exchange: null,
        };
      }
    }

    return null;
  } catch (err) {
    console.error("[analysis/[ticker]] ticker-map fetch failed:", err);
    return null;
  }
}

// ============================================================================
// generateMetadata — the SEO payoff. Per-page title/description/canonical
// renders server-side so Googlebot sees correct metadata before any JS runs.
// ============================================================================
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { ticker } = await params;
  const upper = ticker.toUpperCase();
  const meta = await getCompanyMeta(upper);

  if (!meta) {
    return buildPageMetadata({
      title: `${upper} — Financial Analysis`,
      description: `Financial analysis for ticker ${upper}.`,
      path: `/analysis/${upper}`,
    });
  }

  const title = `${meta.name} (${upper}) — Financial Analysis & Ratios`;
  const description = `Analyze ${meta.name} (${upper}) with SEC financial statements, growth and seasonality, profit bridges, cash quality, funding analysis, custom ratios, and transparent scenarios. Compare source evidence and export a financial research brief.`;

  return buildPageMetadata({
    title,
    description,
    path: `/analysis/${upper}`,
  });
}

// ============================================================================
// JSON-LD Schema.org markup
//
// Adds structured-data block describing the company so Google can render
// rich SERP results. It uses lightweight ticker metadata only; the full SEC
// submissions and XBRL payloads still load through the app's SEC proxy.
// ============================================================================
function buildJsonLd(meta: CompanyMeta): object {
  return {
    "@context": "https://schema.org",
    "@type": "Corporation",
    name: meta.name,
    tickerSymbol: meta.ticker,
    identifier: {
      "@type": "PropertyValue",
      propertyID: "SEC CIK",
      value: meta.cik,
    },
    ...(meta.sicDescription && { industry: meta.sicDescription }),
    url: `https://secedgarterminal.com/analysis/${meta.ticker}`,
    sameAs: [
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${meta.cik}`,
    ],
    subjectOf: {
      "@type": "WebPage",
      "@id": `https://secedgarterminal.com/analysis/${meta.ticker}`,
      name: `${meta.name} Financial Analysis`,
      description: `SEC XBRL financial data and analysis for ${meta.name}`,
    },
  };
}

function CompanyIdentityShell({ meta }: { meta: CompanyMeta }) {
  return (
    <>
      <style>{`
        #analysis-client-shell > .border-2.border-dashed {
          display: none;
        }

        body:has(#analysis-workspace) #analysis-server-intro {
          display: none;
        }
      `}</style>

      <section
        id="analysis-server-intro"
        className="professional-card mb-6 overflow-hidden p-5 sm:p-6 lg:p-8"
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="eyebrow">Company analysis workspace</div>
            <h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
              {meta.name}
            </h1>
            <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
              <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1.5 text-amber-200">
                {meta.ticker}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5">
                CIK {meta.cik}
              </span>
              {meta.sicDescription && (
                <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5">
                  {meta.sicDescription}
                </span>
              )}
            </div>
            <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-400">
              Preparing financial statements, analytical tools, and the source
              filings behind the numbers.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <a
              href={`https://www.sec.gov/edgar/browse/?CIK=${meta.cik}`}
              target="_blank"
              rel="noreferrer"
              className="secondary-button"
            >
              SEC source
            </a>
            <a href={`/filings/${meta.ticker}`} className="primary-button">
              Browse filings
            </a>
          </div>
        </div>
      </section>
    </>
  );
}

// ============================================================================
// Page component — server-rendered shell + client island
//
// We pass the resolved ticker and CIK as props rather than re-fetching
// client-side. This shaves one network round-trip off the client load and
// guarantees the client and server agree on the company identity.
// ============================================================================
export default async function AnalysisTickerPage({ params }: PageProps) {
  const { ticker } = await params;
  const upper = ticker.toUpperCase();
  const meta = await getCompanyMeta(upper);

  // If the ticker doesn't resolve at all, render the client with no preload
  // and let it surface its own "not found" error message. This keeps error
  // UX consistent with the old client-side behavior.
  if (!meta) {
    return (
      <AnalysisClient
        urlTicker={upper}
        preloadedCik={null}
        preloadedCompanyName={null}
        preloadedSicDescription={null}
      />
    );
  }

  const jsonLd = buildJsonLd(meta);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <CompanyIdentityShell meta={meta} />
      <div id="analysis-client-shell">
        <AnalysisClient
          urlTicker={upper}
          preloadedCik={meta.cik}
          preloadedCompanyName={meta.name}
          preloadedSicDescription={meta.sicDescription}
        />
      </div>
    </>
  );
}
