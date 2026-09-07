// Exact wording comparisons must retain punctuation that can change meaning.
// In particular, -5%, 5%, $5, 5.0 and (5) must never collapse to one value.
export function disclosureExactText(text) {
  return String(text ?? "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

const month =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const digits = "(?:(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+)";
const magnitude = "(?:\\s*(?:thousand|million|billion|trillion|bn|mm))?";
const number = `(?:[+−-]\\s*)?${digits}`;
/** @type {Array<[string, RegExp]>} */
const patterns = [
  [
    "date",
    new RegExp(
      `\\b(?:${month}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${month}\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{2,4})\\b`,
      "gi",
    ),
  ],
  [
    "money",
    new RegExp(
      `(?<![\\w.])(?:\\(\\s*)?(?:[+−-]\\s*)?(?:US\\$|USD\\s*|EUR\\s*|GBP\\s*|[$€£¥])\\s*${number}${magnitude}(?:\\s*\\))?`,
      "gi",
    ),
  ],
  [
    "percentage",
    new RegExp(
      `(?<![\\w.])(?:\\(\\s*)?${number}\\s*(?:%|percent(?:age points)?|basis points|bps)(?:\\s*\\))?(?![\\w])`,
      "gi",
    ),
  ],
  [
    "number",
    new RegExp(
      `(?<![\\w.])(?:\\(\\s*)?${number}${magnitude}(?:\\s*\\))?(?![\\w.]\\d)`,
      "gi",
    ),
  ],
];

/** Literal spans, not inferred units, economic meaning, or matched data series. */
export function disclosureQuantities(text) {
  const source = String(text ?? "");
  const spans = [];
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (spans.some((span) => start < span.end && end > span.start)) continue;
      spans.push({ start, end, text: match[0], kind });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

export function disclosureQuantityComparison(priorText, currentText) {
  const prior = disclosureQuantities(priorText);
  const current = disclosureQuantities(currentText);
  const annotate = (items, other) => {
    const otherTerms = new Set(
      other.map((item) => disclosureExactText(item.text)),
    );
    return items.map((item) => ({
      ...item,
      alsoPresent: otherTerms.has(disclosureExactText(item.text)),
    }));
  };
  return { prior: annotate(prior, current), current: annotate(current, prior) };
}

/**
 * @param {string} text
 * @param {Array<{start:number,end:number,text:string,kind:string,alsoPresent?:boolean}>} spans
 * @returns {Array<{text:string,kind:string,start?:number,end?:number,alsoPresent?:boolean}>}
 */
export function disclosureQuantityParts(
  text,
  spans = disclosureQuantities(text),
) {
  const source = String(text ?? "");
  const parts = [];
  let offset = 0;
  for (const span of spans) {
    if (span.start > offset)
      parts.push({ text: source.slice(offset, span.start), kind: "text" });
    parts.push({ ...span, text: source.slice(span.start, span.end) });
    offset = span.end;
  }
  if (offset < source.length)
    parts.push({ text: source.slice(offset), kind: "text" });
  return parts;
}
