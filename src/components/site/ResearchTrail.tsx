"use client";
import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { recordResearchVisit } from "../../utils/researchTrail.js";

export default function ResearchTrail() {
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();
  useEffect(() => {
    if (!pathname) return;
    try {
      recordResearchVisit(
        localStorage,
        `${pathname}${query ? `?${query}` : ""}`,
      );
    } catch {
      /* Recent activity is optional; an unavailable browser store cannot block research. */
    }
  }, [pathname, query]);
  return null;
}
