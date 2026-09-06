import {
  activeTool,
  entityFromRoute,
  safeInternalPath,
  SITE_TOOLS,
} from "./siteRoutes.js";

export const RESEARCH_TRAIL_KEY = "edgar:research-trail:v1";
export function readResearchTrail(storage) {
  const raw = storage.getItem(RESEARCH_TRAIL_KEY);
  if (!raw) return [];
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !Array.isArray(data.items))
    throw new Error("Recent research could not be read.");
  return data.items
    .filter(
      (item) =>
        item &&
        safeInternalPath(item.href) &&
        typeof item.title === "string" &&
        Number.isFinite(Date.parse(item.at)),
    )
    .slice(0, 20);
}
export function recordResearchVisit(
  storage,
  href,
  at = new Date().toISOString(),
) {
  const path = safeInternalPath(href);
  if (!path) return [];
  const url = new URL(path, "https://secedgarterminal.com");
  const tool = activeTool(url.pathname);
  if (!tool || ["home", "workspace", "help"].includes(tool))
    return readResearchTrail(storage);
  const entity = entityFromRoute(url.pathname, url.searchParams);
  const label =
    SITE_TOOLS.find((item) => item.id === tool)?.label || "Research";
  const detail =
    entity?.ticker ||
    (tool === "compare" ? url.pathname.split("/")[2] : "") ||
    (tool === "disclosures" ? url.searchParams.get("query")?.slice(0, 60) : "");
  const title = `${label}${detail ? ` · ${detail}` : ""}`;
  const next = [
    { href: path, title, at },
    ...readResearchTrail(storage).filter((item) => item.href !== path),
  ].slice(0, 20);
  storage.setItem(
    RESEARCH_TRAIL_KEY,
    JSON.stringify({ version: 1, items: next }),
  );
  return next;
}
