import { SITE_NAME, SITE_URL } from "../../utils/siteMetadata";

interface HomeStructuredDataProps {
  cftcEnabled: boolean;
}

/** Describes the public research entry points, without fetching research data. */
export default function HomeStructuredData({
  cftcEnabled,
}: HomeStructuredDataProps) {
  const researchPages = [
    {
      name: "Financial Analysis",
      path: "/analysis",
      description:
        "Explore SEC financial statements, company financial highlights, and hypothetical operating scenarios.",
    },
    {
      name: "SEC Filings",
      path: "/filings",
      description: "Find and read SEC filings and compare reported disclosures.",
    },
    {
      name: "Portfolio",
      path: "/workspace",
      description:
        "Explore portfolio holdings, financials, concentration, and changes in reported evidence.",
    },
    {
      name: "Market Briefing",
      path: "/market",
      description: cftcEnabled
        ? "Explore a market summary of SEC sector fundamentals and separately sourced CFTC futures positioning."
        : "Explore a market summary of SEC sector fundamentals.",
    },
    ...(cftcEnabled
      ? [
          {
            name: "CFTC Positioning",
            path: "/market?tab=positioning",
            description:
              "Explore official futures-only Commitments of Traders reports by market, participant group, and report date.",
          },
        ]
      : []),
    {
      name: "Sector Performance",
      path: "/market?tab=sectors",
      description:
        "Compare sector growth, margins, and cash generation using reported SEC fundamentals, not stock returns.",
    },
    {
      name: "Funds & Institutional Managers",
      path: "/fund",
      description:
        "Research reported N-PORT fund portfolios and 13F manager holdings, concentration, and quarterly changes.",
    },
    {
      name: "Risk",
      path: "/risk",
      description:
        "Review company credit, liquidity, capital, and earnings with business-specific research lenses.",
    },
    {
      name: "Compare",
      path: "/compare",
      description:
        "Compare company financials while retaining reporting periods and source evidence.",
    },
    {
      name: "Disclosures",
      path: "/disclosures",
      description:
        "Search filing language and compare passages with links to the original SEC sources.",
    },
  ];

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: `${SITE_URL}/`,
        name: SITE_NAME,
        alternateName: "SEC EDGAR Terminal",
        inLanguage: "en-US",
      },
      {
        "@type": "CollectionPage",
        "@id": `${SITE_URL}/#homepage`,
        url: `${SITE_URL}/`,
        name: "Free SEC Filings & Financial Research | EDGAR Terminal",
        description: cftcEnabled
          ? "Free research tools for SEC filings, company financials, 13F manager holdings, portfolio analysis, sector fundamentals, and CFTC positioning."
          : "Free research tools for SEC filings, company financials, 13F manager holdings, portfolio analysis, and sector fundamentals.",
        isPartOf: { "@id": `${SITE_URL}/#website` },
        inLanguage: "en-US",
        isAccessibleForFree: true,
        mainEntity: {
          "@type": "ItemList",
          name: "Public financial research tools",
          numberOfItems: researchPages.length,
          itemListElement: researchPages.map((page, index) => ({
            "@type": "ListItem",
            position: index + 1,
            item: {
              "@type": "WebPage",
              name: page.name,
              url: `${SITE_URL}${page.path}`,
              description: page.description,
            },
          })),
        },
      },
    ],
  };

  return (
    <script
      id="home-research-directory"
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
      }}
    />
  );
}
