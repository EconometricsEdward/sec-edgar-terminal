import test from "node:test";
import assert from "node:assert/strict";
import {
  readResearchTrail,
  recordResearchVisit,
} from "../src/utils/researchTrail.js";
test("recent research preserves deep settings and deduplicates revisits without accepting external routes", () => {
  let raw = null;
  const storage = {
    getItem: () => raw,
    setItem: (_, next) => {
      raw = next;
    },
  };
  recordResearchVisit(
    storage,
    "/analysis/JPM?basis=ytd&view=quality",
    "2026-09-01T00:00:00Z",
  );
  recordResearchVisit(
    storage,
    "/filings/JPM?family=quarterly",
    "2026-09-02T00:00:00Z",
  );
  recordResearchVisit(
    storage,
    "/analysis/JPM?basis=ytd&view=quality",
    "2026-09-03T00:00:00Z",
  );
  assert.equal(readResearchTrail(storage).length, 2);
  assert.equal(readResearchTrail(storage)[0].title, "Analysis · JPM");
  assert.match(readResearchTrail(storage)[0].href, /basis=ytd/);
  const before = raw;
  recordResearchVisit(storage, "//attacker.example");
  assert.equal(raw, before);
  recordResearchVisit(storage, "/workspace");
  assert.equal(raw, before);
});
test("recent research preserves corrupt storage and ignores unsafe legacy rows", () => {
  const storage = {
    getItem: () => "{broken",
    setItem: () => assert.fail("should not overwrite"),
  };
  assert.throws(() => recordResearchVisit(storage, "/analysis/AAPL"));
  assert.deepEqual(
    readResearchTrail({
      getItem: () =>
        JSON.stringify({
          version: 1,
          items: [
            { href: "javascript:alert(1)", title: "bad", at: "2026-01-01" },
          ],
        }),
    }),
    [],
  );
});
