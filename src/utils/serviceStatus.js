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
  return {
    phase:
      httpStatus === 200 && payload.status === "ok" && secConfigured
        ? "available"
        : "degraded",
    secConfiguration: secConfigured
      ? "Configured"
      : payload.checks.secUserAgent === "missing"
        ? "Missing"
        : "Unknown",
    cacheConfiguration:
      payload.checks.warmCache === "configured"
        ? "Configured"
        : payload.checks.warmCache === "disabled"
          ? "Disabled"
          : "Unknown",
  };
}
