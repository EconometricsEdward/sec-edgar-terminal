import { permanentRedirect } from "next/navigation";

// Keep historical links useful after retiring the Fundamental Lab surface.
export default function LegacyMarketFactorsPage() {
  permanentRedirect("/market?tab=sectors");
}
