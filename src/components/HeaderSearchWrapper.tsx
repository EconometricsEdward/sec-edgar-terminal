"use client";

import GlobalSearchBar from "./GlobalSearchBar.jsx";

export default function HeaderSearchWrapper({ cftcEnabled = true }: { cftcEnabled?: boolean }) {
  return (
    <div className="header-command-search w-full">
      <GlobalSearchBar cftcEnabled={cftcEnabled} />
    </div>
  );
}
