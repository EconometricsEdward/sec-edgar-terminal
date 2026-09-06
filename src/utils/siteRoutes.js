/** Shared site navigation. Never infer an issuer from a peer group or a stale page. */
export const SITE_TOOLS = Object.freeze([
  {
    id: "home",
    label: "Home",
    href: "/",
    description: "Start a research workflow",
  },
  {
    id: "workspace",
    label: "Research Hub",
    href: "/workspace",
    description: "Saved research, review queues and backups",
  },
  {
    id: "filings",
    label: "Filings",
    href: "/filings",
    description: "Find and read SEC source documents",
  },
  {
    id: "analysis",
    label: "Analysis",
    href: "/analysis",
    description: "Explore source-linked financial statements",
  },
  {
    id: "market",
    label: "Market",
    href: "/market",
    description: "Explore the public-company market",
  },
  {
    id: "risk",
    label: "Risk",
    href: "/risk",
    description: "Review credit, liquidity and capital",
  },
  {
    id: "compare",
    label: "Compare",
    href: "/compare",
    description: "Compare company fundamentals",
  },
  {
    id: "fund",
    label: "Funds",
    href: "/fund",
    description: "Research fund holdings and portfolios",
  },
  {
    id: "disclosures",
    label: "Disclosures",
    href: "/disclosures",
    description: "Search and collect filing passages",
  },
  {
    id: "help",
    label: "Guide",
    href: "/help",
    description: "Understand the data and research tools",
  },
]);

const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const LANDINGS = new Set([...SITE_TOOLS.map((tool) => tool.href), "/about"]);

function normalizeTicker(value) {
  if (typeof value !== "string") return null;
  const ticker = value.trim().toUpperCase();
  return TICKER.test(ticker) ? ticker : null;
}

function queryValue(params, key) {
  if (!params) return "";
  const values =
    typeof params.getAll === "function" ? params.getAll(key) : [params[key]];
  // Conflicting repeated query parameters cannot define a unique issuer.
  if (values.length !== 1 || typeof values[0] !== "string") return "";
  return values[0];
}

/**
 * Validate a user-controlled saved destination before handing it to a router.
 * Only actual research routes are accepted; query settings and anchors survive.
 */
export function safeInternalPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 16000 ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return null;
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return null;
  let url;
  try {
    url = new URL(value, "https://secedgarterminal.com");
  } catch {
    return null;
  }
  if (url.origin !== "https://secedgarterminal.com") return null;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // Reject encoded separators, dot segments, double decoding and ambiguous paths.
  const rawPath = value.split(/[?#]/, 1)[0];
  let decodedRawPath;
  try {
    decodedRawPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    /%(?:2f|5c|25|00)/i.test(rawPath) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(decodedRawPath) ||
    pathname.includes("\\")
  )
    return null;
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  if (LANDINGS.has(path)) return `${path}${url.search}${url.hash}`;
  const match = path.match(/^\/(analysis|filings|fund|compare)\/([^/]+)$/);
  if (!match) return null;
  const tickers = match[2].split(",");
  if (match[1] === "compare") {
    if (
      tickers.length < 2 ||
      tickers.length > 5 ||
      new Set(tickers.map((t) => t.toUpperCase())).size !== tickers.length
    )
      return null;
  } else if (tickers.length !== 1) return null;
  if (
    tickers.some(
      (ticker) => !normalizeTicker(ticker) || ticker.trim() !== ticker,
    )
  )
    return null;
  return `/${match[1]}/${tickers.map((ticker) => ticker.toUpperCase()).join(",")}${url.search}${url.hash}`;
}

/** @returns {{ticker: string, kind: 'company'|'fund'} | null} */
export function entityFromRoute(pathname, searchParams) {
  if (typeof pathname !== "string") return null;
  const path = pathname.replace(/\/$/, "") || "/";
  const match = path.match(/^\/(analysis|filings|fund)\/([^/]+)$/);
  if (match) {
    let raw;
    try {
      raw = decodeURIComponent(match[2]);
    } catch {
      return null;
    }
    const ticker = normalizeTicker(raw);
    return ticker
      ? { ticker, kind: match[1] === "fund" ? "fund" : "company" }
      : null;
  }
  if (path !== "/risk" && path !== "/disclosures") return null;
  const keys =
    path === "/risk"
      ? ["ticker", "symbol"]
      : ["tickers", "focus", "ticker", "company"];
  if (
    typeof searchParams?.getAll === "function" &&
    keys.some((key) => searchParams.getAll(key).length > 1)
  )
    return null;
  const present = keys.filter((key) => queryValue(searchParams, key));
  if (!present.length) return null;
  const raw = queryValue(searchParams, present[0]);
  const ticker = normalizeTicker(raw);
  // CIKs and names are accepted by disclosure search, but are not ticker identity.
  if (!ticker || /^\d+$/.test(ticker)) return null;
  return { ticker, kind: "company" };
}

export function companyToolPath(tool, value) {
  const ticker = normalizeTicker(value);
  if (!ticker) return null;
  if (tool === "analysis" || tool === "filings" || tool === "fund")
    return `/${tool}/${ticker}`;
  if (tool === "risk") return `/risk?ticker=${encodeURIComponent(ticker)}`;
  if (tool === "disclosures")
    return `/disclosures?tickers=${encodeURIComponent(ticker)}&mode=companies`;
  return null;
}

export function activeTool(pathname) {
  return (
    SITE_TOOLS.find((tool) =>
      tool.href === "/"
        ? pathname === "/"
        : pathname === tool.href || pathname.startsWith(`${tool.href}/`),
    )?.id || null
  );
}
