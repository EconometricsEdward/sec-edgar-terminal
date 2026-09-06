"use client";

import { ReactNode, Suspense } from "react";
import ResearchTrail from "../components/site/ResearchTrail";
import { WorkspaceProvider } from "../components/research/WorkspaceProvider";
import { TickerProvider } from "../contexts/TickerContext";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <TickerProvider>
        <Suspense fallback={null}>
          <ResearchTrail />
        </Suspense>
        {children}
      </TickerProvider>
    </WorkspaceProvider>
  );
}
