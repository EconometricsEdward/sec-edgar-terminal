/** Interpret the application's health endpoint without implying upstream freshness. */
export function describeServiceHealth(payload, httpStatus) {
  if (
    !payload ||
    payload.service !== "sec-edgar-terminal" ||
    !["ok", "degraded"].includes(payload.status) ||
    !payload.checks ||
    ![200, 503].includes(httpStatus)
  ) {
    throw new Error("The service check returned an unexpected response.");
  }
  const secConfigured = payload.checks.secUserAgent === "configured";
  const rateGateConfigured = payload.checks.secRateGate === "configured";
  return {
    phase:
      httpStatus === 200 && payload.status === "ok" && secConfigured && rateGateConfigured
        ? "available"
        : "degraded",
    secConfiguration: secConfigured
      ? "Configured"
      : payload.checks.secUserAgent === "invalid"
        ? "Invalid or missing contact information"
        : payload.checks.secUserAgent === "missing"
          ? "Missing"
        : "Unknown",
    cacheConfiguration:
      payload.checks.warmCache === "configured"
        ? "Configured"
        : payload.checks.warmCache === "disabled"
          ? "Disabled"
          : "Unknown",
    rateLimitConfiguration: rateGateConfigured
      ? `Configured · ${payload.checks.secStartsPerSecond || "bounded"} SEC request starts/second`
      : payload.checks.secRateGate === "disabled"
        ? "Disabled"
        : "Unknown",
  };
}

/** Interpret the independent cache-only CFTC check without affecting SEC health. */
export function describeCftcHealth(payload, httpStatus) {
  if (!payload || payload.schema_version !== 'edgar.cftc-positioning.v1' || !['ready', 'degraded', 'unavailable', 'disabled'].includes(payload.status) || ![200, 503].includes(httpStatus) || !Array.isArray(payload.families)) return 'Check unavailable';
  if (payload.status === 'disabled') return 'Shared cache disabled';
  const label = { tff: 'TFF', disaggregated: 'Disaggregated' };
  if (!payload.families.length) return payload.status === 'unavailable' ? 'No prepared snapshots' : 'Check unavailable';
  return payload.families.map(family => `${label[family.family] || family.family}: ${family.status}${family.report_date ? ` · ${family.report_date}` : ''}`).join(' | ');
}
