import {
  parseDisclosureQuery,
  termPattern,
  highlightParts,
} from "./disclosureQuery.js";

export const QUERY_COACH_EXAMPLE = {
  query: '(liquidity OR "credit facility") AND waiver AND NOT hypothetical',
  text: "We obtained a waiver under our credit facility through June 30, 2026.\n\nLiquidity remains available. No waiver was requested.\n\nA hypothetical liquidity waiver could be required in the future.",
};

// Render the parsed tree, not a flattened list: NOT and nested OR groups retain
// precisely the same meaning as the shared server-side query evaluator.
export function describeQueryNode(node) {
  if (node.kind === "term") return `Contains “${node.value}”`;
  if (node.kind === "NOT")
    return `Does not satisfy (${describeQueryNode(node.child)})`;
  return `(${describeQueryNode(node.left)}) ${node.kind === "AND" ? "AND" : "OR"} (${describeQueryNode(node.right)})`;
}

export function inspectDisclosureQuery(query) {
  try {
    const parsed = parseDisclosureQuery(query);
    return {
      valid: true,
      parsed,
      explanation: describeQueryNode(parsed.ast),
      error: "",
    };
  } catch (error) {
    return {
      valid: false,
      parsed: null,
      explanation: "",
      error: error instanceof Error ? error.message : "Check the query syntax.",
    };
  }
}

export function evaluateQueryTrace(ast, text) {
  function visit(node, id, excluded = false) {
    if (node.kind === "term") {
      const count = [...String(text).matchAll(termPattern(node.value))].length;
      return {
        id,
        kind: "term",
        label: `Contains “${node.value}”`,
        term: node.value,
        count,
        passed: count > 0,
        excluded,
        children: [],
      };
    }
    if (node.kind === "NOT") {
      const child = visit(node.child, `${id}.0`, !excluded);
      return {
        id,
        kind: "NOT",
        label: "NOT · condition below must be false",
        passed: !child.passed,
        excluded,
        children: [child],
      };
    }
    const children = [
      visit(node.left, `${id}.0`, excluded),
      visit(node.right, `${id}.1`, excluded),
    ];
    return {
      id,
      kind: node.kind,
      label:
        node.kind === "AND"
          ? "AND · both conditions must be true"
          : "OR · at least one condition must be true",
      passed:
        node.kind === "AND"
          ? children.every((child) => child.passed)
          : children.some((child) => child.passed),
      excluded,
      children,
    };
  }
  return visit(ast, "query");
}

export function testDisclosureSample(query, sample, scope = "paragraph") {
  const inspection = inspectDisclosureQuery(query);
  if (!inspection.valid || !inspection.parsed)
    return { error: inspection.error, units: [], matched: 0 };
  const text = String(sample).slice(0, 30000);
  const units = (scope === "document" ? [text] : text.split(/\r?\n\s*\r?\n/))
    .map((unit) => unit.trim())
    .filter(Boolean)
    .map((unit, index) => {
      const trace = evaluateQueryTrace(inspection.parsed.ast, unit);
      return {
        id: index,
        text: unit,
        passed: trace.passed,
        trace,
        parts: highlightParts(unit, inspection.parsed.terms),
      };
    });
  return {
    error: "",
    units,
    matched: units.filter((unit) => unit.passed).length,
  };
}
