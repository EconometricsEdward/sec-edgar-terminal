// One grammar shared by the browser and server. Never silently broaden a query.
export const QUERY_VERSION = "disclosures-v2";
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const quoteTerm = (s) => `"${String(s).replace(/["\\]/g, " ").trim()}"`;

export function termPattern(term, flags = "gi") {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escape(term).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`,
    `${flags}u`,
  );
}

export function parseDisclosureQuery(raw) {
  if (!raw?.trim())
    throw new Error("Enter a word, phrase, or Boolean expression.");
  if (raw.length > 1000)
    throw new Error("Keep the query under 1,000 characters.");
  const tokens = [];
  const re = /\s+|"([^"\n]+)"|([(),])|([^\s"(),]+)/gy;
  let offset = 0;
  while (offset < raw.length) {
    re.lastIndex = offset;
    const m = re.exec(raw);
    if (!m) throw new Error("Close every quoted phrase.");
    offset = re.lastIndex;
    if (/^\s+$/.test(m[0])) continue;
    if (m[1])
      tokens.push({ kind: "term", value: m[1].replace(/\s+/g, " ").trim() });
    else if (m[2]) tokens.push({ kind: m[2] === "," ? "OR" : m[2] });
    else if (/^(AND|OR|NOT)$/.test(m[3])) tokens.push({ kind: m[3] });
    else {
      if (/[*?~^{}\[\]\\:]/.test(m[3]))
        throw new Error(
          "Use literal terms, quotes, AND, OR, NOT, and parentheses. Wildcards are not supported.",
        );
      if (m[3].startsWith("-") && m[3].length > 1) {
        tokens.push({ kind: "NOT" }, { kind: "term", value: m[3].slice(1) });
      } else tokens.push({ kind: "term", value: m[3] });
    }
  }
  const terms = tokens.filter((t) => t.kind === "term");
  if (terms.length > 16) throw new Error("Use at most 16 terms or phrases.");
  if (terms.some((t) => t.value.length < 2 || t.value.length > 120))
    throw new Error("Each term or phrase must contain 2–120 characters.");
  let i = 0;
  function atom(depth) {
    if (depth > 12) throw new Error("Too many nested groups.");
    const token = tokens[i++];
    if (!token) throw new Error("The expression ends before a required term.");
    if (token.kind === "NOT") return { kind: "NOT", child: atom(depth + 1) };
    if (token.kind === "term") return token;
    if (token.kind === "(") {
      const node = or(depth + 1);
      if (tokens[i++]?.kind !== ")")
        throw new Error("Close every parenthesis.");
      return node;
    }
    throw new Error(`Expected a term, found ${token.kind}.`);
  }
  function and(depth) {
    let node = atom(depth);
    while (i < tokens.length && !["OR", ")"].includes(tokens[i].kind)) {
      if (tokens[i].kind === "AND") i++;
      node = { kind: "AND", left: node, right: atom(depth) };
    }
    return node;
  }
  function or(depth) {
    let node = and(depth);
    while (tokens[i]?.kind === "OR") {
      i++;
      node = { kind: "OR", left: node, right: and(depth) };
    }
    return node;
  }
  const ast = or(0);
  if (i !== tokens.length) throw new Error("Unexpected closing parenthesis.");
  const positive = [];
  function collect(node, negated = false) {
    if (node.kind === "term") {
      if (!negated) positive.push(node.value);
    } else if (node.kind === "NOT") collect(node.child, !negated);
    else {
      collect(node.left, negated);
      collect(node.right, negated);
    }
  }
  collect(ast);
  if (!positive.length)
    throw new Error("Include at least one positive search term.");
  // A negative-only branch can match documents outside an OR candidate search.
  const matchesEmpty = evaluateQuery(ast, () => false);
  if (matchesEmpty)
    throw new Error(
      "Every OR branch must require a positive term. Combine exclusions with AND NOT.",
    );
  return {
    raw,
    ast,
    terms: [...new Set(terms.map((t) => t.value))],
    positive: [...new Set(positive)],
  };
}

export function evaluateQuery(ast, has) {
  if (ast.kind === "term") return has(ast.value);
  if (ast.kind === "NOT") return !evaluateQuery(ast.child, has);
  return ast.kind === "AND"
    ? evaluateQuery(ast.left, has) && evaluateQuery(ast.right, has)
    : evaluateQuery(ast.left, has) || evaluateQuery(ast.right, has);
}

export function matchesQuery(text, parsed) {
  return evaluateQuery(parsed.ast, (term) => termPattern(term, "i").test(text));
}

export function highlightParts(text, terms) {
  const ranges = terms
    .flatMap((term) =>
      [...String(text).matchAll(termPattern(term))].map((m) => [
        m.index,
        m.index + m[0].length,
      ]),
    )
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const parts = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor)
      parts.push({ text: text.slice(cursor, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length)
    parts.push({ text: text.slice(cursor), match: false });
  return parts;
}

export function buildAdvancedQuery({ any = "", required = "", exclude = "" }) {
  const list = (s) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map(quoteTerm);
  const a = list(any);
  const b = list(required);
  const c = list(exclude);
  return [
    ...(a.length ? [`(${a.join(" OR ")})`] : []),
    ...b,
    ...c.map((s) => `NOT ${s}`),
  ].join(" AND ");
}

export function legacyDisclosureQuery(raw, match = "any") {
  if (!raw.includes(",") || /\b(?:AND|OR|NOT)\b|[()"]/.test(raw)) return raw;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(quoteTerm)
    .join(match === "all" ? " AND " : " OR ");
}
