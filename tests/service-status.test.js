import test from "node:test";
import assert from "node:assert/strict";
import { describeServiceHealth } from "../src/utils/serviceStatus.js";

const healthy = {
  service: "sec-edgar-terminal",
  status: "ok",
  checks: { secUserAgent: "configured", warmCache: "configured" },
};

test("service status confirms only application configuration", () => {
  assert.deepEqual(describeServiceHealth(healthy, 200), {
    phase: "available",
    secConfiguration: "Configured",
    cacheConfiguration: "Configured",
  });
  assert.equal(
    Object.hasOwn(describeServiceHealth(healthy, 200), "dataFreshness"),
    false,
  );
});

test("missing request configuration is degraded including on HTTP 200", () => {
  const degraded = {
    ...healthy,
    status: "degraded",
    checks: { secUserAgent: "missing", warmCache: "disabled" },
  };
  assert.deepEqual(describeServiceHealth(degraded, 503), {
    phase: "degraded",
    secConfiguration: "Missing",
    cacheConfiguration: "Disabled",
  });
  assert.equal(
    describeServiceHealth({ ...degraded, status: "ok" }, 200).phase,
    "degraded",
  );
  assert.equal(
    describeServiceHealth({ ...healthy, checks: {} }, 200).phase,
    "degraded",
  );
});

test("unrelated, malformed and error responses cannot appear healthy", () => {
  for (const payload of [
    null,
    {},
    { ...healthy, service: "other" },
    { ...healthy, status: "unknown" },
    { ...healthy, checks: null },
  ]) {
    assert.throws(() => describeServiceHealth(payload, 200), /unexpected/);
  }
  for (const status of [301, 401, 404, 500, 502])
    assert.throws(() => describeServiceHealth(healthy, status), /unexpected/);
});
