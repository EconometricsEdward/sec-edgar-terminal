import test from "node:test";
import assert from "node:assert/strict";
import { rankGlobalFilerMatches } from "../src/utils/globalFilerMatches.js";
import { safeInternalPath } from "../src/utils/siteRoutes.js";

const manager = { cik: "0001747057", name: "D1 Capital Partners L.P.", formTypes: ["13F-HR"] };
const offshore = { cik: "0001750024", name: "D1 Capital Partners Offshore Ltd.", formTypes: [] };
const access = { cik: "0002124401", name: "D1 Capital Access LLC", formTypes: ["D"] };

test("partial manager names rank verified holdings first without choosing a related entity", () => {
  const result = rankGlobalFilerMatches("D1 Capital", [access, offshore, manager], { truncated: true });
  assert.equal(result.exactPath, null);
  assert.equal(result.items[0].label, manager.name);
  assert.equal(result.items[0].type, "manager");
  assert.equal(result.items[0].path, "/fund?view=13f&managerCik=0001747057");
  assert.equal(result.items[1].type, "filer");
  assert.match(result.items[1].path, /^\/filings\/\d{10}$/);
  assert.equal(rankGlobalFilerMatches("D1 Capital", [manager]).exactPath, null);
});

test("a complete unique legal name can open its verified destination despite harmless punctuation", () => {
  const result = rankGlobalFilerMatches(" D1 Capital Partners, LP ", [offshore, manager]);
  assert.equal(result.exactPath, "/fund?view=13f&managerCik=0001747057");
  assert.equal(result.items[0].label, manager.name);
  assert.equal(result.items[0].query, "D1 Capital Partners, LP");
  assert.equal(rankGlobalFilerMatches(offshore.name, [manager, offshore]).exactPath, "/filings/0001750024");
});

test("ambiguous identities and incomplete name discovery never auto-navigate", () => {
  const sameName = { ...manager, cik: "0000000123" };
  assert.equal(rankGlobalFilerMatches(manager.name, [manager, sameName]).exactPath, null);
  assert.equal(rankGlobalFilerMatches(manager.name, [manager], { truncated: true }).exactPath, null);
  assert.equal(rankGlobalFilerMatches(manager.name, [manager], { warning: "One source unavailable" }).exactPath, null);
  const oversized = [manager, ...Array.from({ length: 20 }, (_, index) => ({ ...access, cik: String(index + 1).padStart(10, "0") }))];
  assert.equal(rankGlobalFilerMatches(manager.name, oversized).exactPath, null);
  assert.equal(rankGlobalFilerMatches(manager.name, oversized).items.length, 12);
});

test("13F notices do not promise holdings while holdings amendments do", () => {
  for (const form of ["13F-NT", "13F-NT/A", "13F-HR-looking", "D"]) {
    const result = rankGlobalFilerMatches(manager.name, [{ ...manager, formTypes: [form] }]);
    assert.equal(result.items[0].type, "filer");
    assert.equal(result.exactPath, "/filings/0001747057");
    assert.match(result.items[0].description, /^SEC filings/);
  }
  const amended = rankGlobalFilerMatches(manager.name, [{ ...manager, formTypes: ["13F-HR/A"] }]);
  assert.equal(amended.items[0].type, "manager");
  assert.equal(amended.exactPath, "/fund?view=13f&managerCik=0001747057");
});

test("an exact legal identity outranks a manager that only shares its prefix", () => {
  const named = { ...access, name: "D1 Capital" };
  const result = rankGlobalFilerMatches("D1 Capital", [manager, named]);
  assert.equal(result.items[0].label, named.name);
  assert.equal(result.exactPath, "/filings/0002124401");
});

test("result destinations derive only from validated CIKs and recognized filing forms", () => {
  const result = rankGlobalFilerMatches("D1 Capital", [
    { ...manager, path: "https://example.com", type: "company" },
    { ...manager },
    { ...offshore, cik: "../admin" },
    { ...offshore, cik: "0000000000" },
    { ...offshore, name: "" },
    null,
  ]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "filer:0001747057");
  assert.equal(result.items[0].path, "/fund?view=13f&managerCik=0001747057");
  for (const item of result.items) assert.equal(safeInternalPath(item.path), item.path);
  assert.deepEqual(rankGlobalFilerMatches("D1 Capital", null), { items: [], exactPath: null });
});
