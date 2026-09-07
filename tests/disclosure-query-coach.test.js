import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesQuery,
  parseDisclosureQuery,
  legacyDisclosureQuery,
} from "../src/utils/disclosureQuery.js";
import {
  describeQueryNode,
  evaluateQueryTrace,
  inspectDisclosureQuery,
  testDisclosureSample,
} from "../src/utils/disclosureQueryCoach.js";

test("query coach traces complete Boolean branches without short-circuiting", () => {
  const query = parseDisclosureQuery(
    '(liquidity OR "credit facility") AND waiver AND NOT hypothetical',
  );
  const text = "A credit facility waiver was received.";
  const trace = evaluateQueryTrace(query.ast, text);
  assert.equal(trace.passed, matchesQuery(text, query));
  assert.equal(trace.children[0].children[0].children[0].passed, false);
  assert.equal(trace.children[0].children[0].children[1].passed, true);
  assert.equal(trace.children[1].passed, true);
  assert.equal(trace.children[1].children[0].passed, false);
  assert.equal(trace.children[1].children[0].excluded, true);
});

test("nested negation explanations and traces retain exact parser semantics", () => {
  const raw = "liquidity AND NOT (waiver OR (breach AND NOT cured))";
  const parsed = parseDisclosureQuery(raw);
  const explanation = describeQueryNode(parsed.ast);
  assert.match(explanation, /Does not satisfy/);
  assert.match(explanation, / OR /);
  for (const text of [
    "liquidity",
    "liquidity waiver",
    "liquidity breach",
    "liquidity breach cured",
    "cured",
  ]) {
    assert.equal(
      evaluateQueryTrace(parsed.ast, text).passed,
      matchesQuery(text, parsed),
      text,
    );
  }
});

test("coach reports invalid syntax and blocks negative-only candidate branches", () => {
  for (const query of [
    "",
    "NOT waiver",
    "liquidity OR NOT waiver",
    '"unclosed',
    "waiver AND",
    "(liquidity",
  ]) {
    assert.equal(inspectDisclosureQuery(query).valid, false, query);
    assert.ok(inspectDisclosureQuery(query).error.length > 0);
  }
  assert.equal(inspectDisclosureQuery("NOT NOT liquidity").valid, true);
});

test("sample scope matches paragraph and document evaluator behavior", () => {
  const query = "liquidity AND waiver AND NOT hypothetical";
  const text =
    "Liquidity is available.\n\nA waiver was received.\n\nHypothetical stress is discussed.";
  assert.equal(testDisclosureSample(query, text, "paragraph").matched, 0);
  assert.equal(testDisclosureSample(query, text, "document").matched, 0);
  const two = "Liquidity is available.\r\n\r\nA waiver was received.";
  assert.equal(testDisclosureSample(query, two, "paragraph").matched, 0);
  assert.equal(testDisclosureSample(query, two, "document").matched, 1);
  assert.equal(testDisclosureSample(query, " \n\n ").units.length, 0);
});

test("sample highlights phrases and excluded terms without semantic sentiment claims", () => {
  const result = testDisclosureSample(
    '"credit facility" AND waiver AND NOT hypothetical',
    "No waiver under the CREDIT FACILITY was requested; hypothetical only.",
  );
  assert.equal(result.matched, 0);
  assert.deepEqual(
    result.units[0].parts.filter((part) => part.match).map((part) => part.text),
    ["waiver", "CREDIT FACILITY", "hypothetical"],
  );
  assert.equal(
    testDisclosureSample("waiver", "No waiver was requested.").matched,
    1,
  );
});

test("comma OR and legacy multiword queries retain shared grammar", () => {
  assert.equal(
    testDisclosureSample("liquidity, waiver", "liquidity").matched,
    1,
  );
  assert.equal(
    testDisclosureSample("liquidity waiver", "liquidity").matched,
    0,
  );
  const legacy = legacyDisclosureQuery("cash flow, covenant", "any");
  assert.equal(
    testDisclosureSample(legacy, "Cash flow remained positive").matched,
    1,
  );
  assert.equal(testDisclosureSample(legacy, "cash and flow").matched, 0);
});
