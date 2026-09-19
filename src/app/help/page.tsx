import { permanentRedirect } from "next/navigation";

// Keep historical links working after About replaces the standalone Guide.
export default function RetiredGuidePage() {
  permanentRedirect("/about");
}
