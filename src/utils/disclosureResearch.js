import {
  matchesQuery,
  parseDisclosureQuery,
  termPattern,
} from "./disclosureQuery.js";

export const DISCLOSURE_TOPICS = [
  {
    id: "liquidity",
    label: "Liquidity",
    query: 'liquidity OR "cash flow" OR "cash runway"',
  },
  {
    id: "refinancing",
    label: "Refinancing",
    query: "refinancing OR covenant OR waiver OR maturity",
  },
  {
    id: "litigation",
    label: "Litigation",
    query: "litigation OR lawsuit OR settlement",
  },
  {
    id: "cyber",
    label: "Cybersecurity",
    query: 'cybersecurity OR ransomware OR "data breach"',
  },
  {
    id: "concentration",
    label: "Customer concentration",
    query: '"major customer" OR "customer concentration" OR "largest customer"',
  },
  {
    id: "controls",
    label: "Internal controls",
    query: '"material weakness" OR restatement OR "internal controls"',
  },
];
const topicQueries = DISCLOSURE_TOPICS.map((t) => ({
  ...t,
  parsed: parseDisclosureQuery(t.query),
}));
export const SECTION_OPTIONS = [
  ["all", "Whole document"],
  ["risk", "Risk Factors"],
  ["mda", "MD&A"],
  ["notes", "Financial notes"],
  ["8k:1.01", "8-K · 1.01 Material agreements"],
  ["8k:1.02", "8-K · 1.02 Termination of agreements"],
  ["8k:1.05", "8-K · 1.05 Cybersecurity incidents"],
  ["8k:2.02", "8-K · 2.02 Results of operations"],
  ["8k:2.03", "8-K · 2.03 Financial obligations"],
  ["8k:2.04", "8-K · 2.04 Acceleration / defaults"],
  ["8k:4.02", "8-K · 4.02 Non-reliance"],
  ["8k:8.01", "8-K · 8.01 Other events"],
];
const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const words = (s) =>
  new Set(
    normalize(s)
      .split(" ")
      .filter((w) => w.length > 2),
  );
const subject = (s) =>
  normalize(s)
    .split(" ")
    .filter(
      (w) =>
        w.length > 2 &&
        !/^\d+$/.test(w) &&
        ![
          "the",
          "and",
          "our",
          "its",
          "this",
          "that",
          "for",
          "with",
          "january",
          "february",
          "march",
          "april",
          "may",
          "june",
          "july",
          "august",
          "september",
          "october",
          "november",
          "december",
        ].includes(w),
    )
    .slice(0, 2)
    .join(" ");

/** Bounded heading extraction. Missing headings stay unknown, never zero matches. */
export function disclosurePassages(text, form = "") {
  const headings = [
    ...text.matchAll(
      /(?:^|\n)\s*item\s+(\d+(?:\.\d{2}|[A-Z])?)\s*[.\-:—]?\s*/gim,
    ),
  ];
  const ranges = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const title = text.slice(h.index, h.index + 180);
    const item = h[1].toUpperCase();
    const end = headings[i + 1]?.index ?? text.length;
    let id = "";
    let label = "";
    if (/^8-K/.test(form) && /^\d\.\d{2}$/.test(item)) {
      id = `8k:${item}`;
      label = `8-K Item ${item}`;
    } else if (item === "1A" && /risk\s+factors/i.test(title)) {
      id = "risk";
      label = "Risk Factors";
    } else if (
      item === (form.startsWith("10-Q") ? "2" : "7") &&
      /management.{0,12}discussion/i.test(title)
    ) {
      id = "mda";
      label = "MD&A";
    }
    if (id && end - h.index > 200)
      ranges.push({ id, label, start: h.index, end });
  }
  // Bank reports sometimes introduce MD&A without a numbered narrative heading.
  const intro =
    /(?:^|\n)\s*The following is Management.{0,12}discussion and analysis[^\n]*/im.exec(
      text,
    );
  if (intro) {
    const ending =
      /\n\s*(?:CONSOLIDATED STATEMENTS OF (?:INCOME|EARNINGS)|CONSOLIDATED FINANCIAL STATEMENTS|FINANCIAL STATEMENTS)(?:\s*\([^\n]{0,50}\))?\s*(?:\n|[–—])/i.exec(
        text.slice(intro.index),
      );
    if (ending?.index > 500)
      ranges.push({
        id: "mda",
        label: "MD&A",
        start: intro.index,
        end: intro.index + ending.index,
      });
  }
  const noteHeadings = [
    ...text.matchAll(
      /(?:^|\n)\s*NOTES? TO (?:THE )?(?:CONDENSED )?(?:CONSOLIDATED )?FINANCIAL STATEMENTS[^\n]*/gim,
    ),
  ];
  for (const h of noteHeadings) {
    const nextItem = headings.find((item) => item.index > h.index + 300);
    const end = nextItem?.index ?? text.length;
    const body = text.slice(h.index, end);
    if (
      body.length > 1500 &&
      /(?:note\s*\d|accounting policies|basis of presentation)/i.test(body)
    )
      ranges.push({
        id: "notes",
        label: "Financial notes",
        start: h.index,
        end,
      });
  }
  const selected = [...new Set(ranges.map((r) => r.id))].map(
    (id) =>
      ranges
        .filter((r) => r.id === id)
        .sort((a, b) => b.end - b.start - (a.end - a.start))[0],
  );
  const paragraphs = [...text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)]
    .map((m, index) => {
      const range = selected
        .filter((r) => m.index >= r.start && m.index < r.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      return {
        index,
        text: m[0].replace(/\s+/g, " ").trim(),
        sectionId: range?.id || "other",
        section: range?.label || "Other / unclassified text",
      };
    })
    .filter((p) => p.text.length > 0);
  return {
    paragraphs,
    sections: selected.map((r) => ({ id: r.id, label: r.label })),
    extraction:
      "Heading-based text extraction; tables and unrecognized headings require checking the SEC original.",
  };
}

export function passageSignals(text, terms, sectionId = "other") {
  const occurrences = terms
    .flatMap((term) =>
      [...text.matchAll(termPattern(term))].map((m) => ({
        term,
        index: m.index,
        end: m.index + m[0].length,
      })),
    )
    .sort((a, b) => a.index - b.index);
  const matchedTerms = [...new Set(occurrences.map((m) => m.term))];
  let proximity = null;
  if (matchedTerms.length > 1) {
    let left = 0;
    const counts = new Map();
    let unique = 0;
    for (let right = 0; right < occurrences.length; right++) {
      const term = occurrences[right].term;
      if (!counts.get(term)) unique++;
      counts.set(term, (counts.get(term) || 0) + 1);
      while (unique === matchedTerms.length) {
        const span = text
          .slice(occurrences[left].index, occurrences[right].end)
          .split(/\s+/).length;
        proximity = proximity === null ? span : Math.min(span, proximity);
        const old = occurrences[left++].term;
        counts.set(old, counts.get(old) - 1);
        if (!counts.get(old)) unique--;
      }
    }
  }
  const concrete =
    /(?:\$\s*\d|\b\d[\d,.]*\s*(?:million|billion|percent|%)|\b20\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d)/i.test(
      text,
    );
  const hypothetical =
    /\b(?:may|might|could|potential|if we|in the event|cannot assure)\b/i.test(
      text,
    );
  const reported =
    /\b(?:entered into|incurred|repaid|breached|received|occurred|filed|terminated|experienced|was subject to|have incurred|we recorded)\b/i.test(
      text,
    );
  const label =
    reported && hypothetical
      ? "Mixed language"
      : reported
        ? "Reported-event wording"
        : hypothetical
          ? "Hypothetical wording"
          : "Unclassified wording";
  const reasons = [
    matchedTerms.length > 1
      ? `${matchedTerms.length} terms in one paragraph`
      : "Literal term match",
    proximity !== null ? `Terms within ${proximity} words` : "",
    concrete ? "Contains an amount or date" : "",
    sectionId !== "other" ? "Recognized filing section" : "",
  ].filter(Boolean);
  return {
    matchedTerms,
    proximity,
    concrete,
    label,
    reasons,
    relevance:
      text.length < 60
        ? 0
        : matchedTerms.length * 3 +
          (proximity !== null && proximity <= 40 ? 3 : 0) +
          (concrete ? 2 : 0) +
          (sectionId !== "other" ? 1 : 0),
  };
}

export function analyzeDisclosure(
  text,
  form,
  parsed,
  { section = "all", scope = "paragraph" } = {},
) {
  const extracted = disclosurePassages(text, form);
  const paragraphs =
    section === "all"
      ? extracted.paragraphs
      : extracted.paragraphs.filter((p) => p.sectionId === section);
  const sectionFound = section === "all" || paragraphs.length > 0;
  const documentMatch =
    sectionFound &&
    matchesQuery(paragraphs.map((p) => p.text).join("\n\n"), parsed);
  const topics = Object.fromEntries(
    topicQueries.map((topic) => [
      topic.id,
      paragraphs.filter((p) => matchesQuery(p.text, topic.parsed)).length,
    ]),
  );
  const matches = paragraphs.flatMap((p, i) => {
    const signals = passageSignals(p.text, parsed.positive, p.sectionId);
    const matched =
      scope === "paragraph"
        ? matchesQuery(p.text, parsed)
        : documentMatch && signals.matchedTerms.length > 0;
    if (!matched) return [];
    return [
      {
        ...p,
        ...signals,
        beforeContext: paragraphs[i - 1]?.text || "",
        afterContext: paragraphs[i + 1]?.text || "",
        change: "uncompared",
      },
    ];
  });
  return {
    status: sectionFound ? "reviewed" : "section-unavailable",
    paragraphs,
    matches,
    topics,
    sections: extracted.sections,
    extraction: extracted.extraction,
    matched: matches.length > 0,
  };
}

export function selectDisclosureBaseline(current, filings) {
  const baseForm = current.form.replace("/A", "");
  const older = filings.filter(
    (f) =>
      f.accession !== current.accession &&
      f.form.replace("/A", "") === baseForm &&
      (f.filingDate < current.filingDate ||
        (f.filingDate === current.filingDate &&
          f.accession < current.accession)),
  );
  if (current.form.endsWith("/A")) {
    const prior = older
      .filter((f) => f.reportDate === current.reportDate)
      .sort((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
    return {
      prior: prior || null,
      kind: "amendment",
      reason: prior
        ? "Amendment compared with the prior filing for this same reporting period. Partial amendments may omit unchanged sections."
        : "No original filing for this amendment was found in inspected history.",
    };
  }
  if (!/^(10-K|10-Q|20-F|40-F)$/.test(baseForm))
    return {
      prior: null,
      kind: "event",
      reason:
        "Event filings are not automatically paired with unrelated events.",
    };
  const prior = older
    .filter(
      (f) =>
        !f.form.endsWith("/A") &&
        f.reportDate &&
        current.reportDate &&
        Math.abs(
          (Date.parse(current.reportDate) - Date.parse(f.reportDate)) /
            86400000 -
            365.25,
        ) <= 40,
    )
    .sort((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
  return {
    prior: prior || null,
    kind: "annual-season",
    reason: prior
      ? "Same form and reporting season one year earlier; original reports only."
      : "No report of the same form and reporting season was found in inspected history.",
  };
}

export function compareDisclosurePassages(
  current,
  prior,
  { amendment = false } = {},
) {
  const exact = new Map(prior.paragraphs.map((p) => [normalize(p.text), p]));
  const currentExact = new Set(
    current.paragraphs.map((p) => normalize(p.text)),
  );
  const used = new Set();
  const candidates = prior.paragraphs.map((p) => ({
    ...p,
    words: words(p.text),
    subject: subject(p.text),
  }));
  const changed = current.matches.map((p) => {
    const same = exact.get(normalize(p.text));
    if (same) {
      used.add(same.index);
      return { ...p, change: "unchanged", priorText: same.text };
    }
    let best = null;
    let score = 0.48;
    const tokens = words(p.text);
    const head = subject(p.text);
    for (const old of candidates) {
      if (
        used.has(old.index) ||
        currentExact.has(normalize(old.text)) ||
        old.sectionId !== p.sectionId ||
        head !== old.subject
      )
        continue;
      let overlap = 0;
      for (const token of tokens) if (old.words.has(token)) overlap++;
      const similarity =
        overlap / Math.max(1, tokens.size + old.words.size - overlap);
      if (similarity > score) {
        score = similarity;
        best = old;
      }
    }
    if (best) used.add(best.index);
    const comparableSection =
      p.sectionId !== "other" &&
      prior.sections.some((s) => s.id === p.sectionId);
    return {
      ...p,
      change: best
        ? "revised"
        : comparableSection && !amendment
          ? "added"
          : "unmatched",
      priorText: best?.text || "",
      reasons: [
        ...p.reasons,
        best
          ? "Similar prior passage has changed"
          : "No matching prior passage; review section coverage",
      ],
    };
  });
  const removed = prior.matches
    .filter(
      (p) =>
        !used.has(p.index) &&
        !currentExact.has(normalize(p.text)) &&
        p.sectionId !== "other" &&
        current.sections.some((s) => s.id === p.sectionId) &&
        !amendment,
    )
    .map((p) => {
      const oldWords = words(p.text);
      const head = subject(p.text);
      let replacement = null;
      let best = 0.48;
      for (const next of current.paragraphs) {
        if (
          next.sectionId !== p.sectionId ||
          subject(next.text) !== head ||
          current.matches.some((match) => match.index === next.index)
        )
          continue;
        const nextWords = words(next.text);
        let overlap = 0;
        for (const word of oldWords) if (nextWords.has(word)) overlap++;
        const score =
          overlap / Math.max(1, oldWords.size + nextWords.size - overlap);
        if (score > best) {
          replacement = next;
          best = score;
        }
      }
      return replacement
        ? {
            ...p,
            ...replacement,
            change: "revised",
            priorText: p.text,
            queryNoLongerMatches: true,
            beforeContext: "",
            afterContext: "",
            reasons: [
              "A similar current paragraph no longer satisfies the query. Compare both versions before drawing a conclusion.",
            ],
          }
        : {
            ...p,
            change: "removed",
            priorText: p.text,
            text: "",
            reasons: [
              "Prior matching paragraph was not matched in the current section; removal does not prove resolution.",
            ],
          };
    });
  return {
    matches: changed,
    removed,
    unchanged: changed.filter((p) => p.change === "unchanged").length,
  };
}

/** A readable token diff bounded to a passage, with removals and additions preserved. */
export function disclosureWordDiff(before, after) {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  if (a.length * b.length > 300000)
    return [
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ];
  const rows = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      rows[i][j] =
        a[i] === b[j]
          ? rows[i + 1][j + 1] + 1
          : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  const add = (kind, text) => {
    if (out[out.length - 1]?.kind === kind) out[out.length - 1].text += text;
    else out.push({ kind, text });
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      add("same", a[i++]);
      j++;
    } else if (
      j < b.length &&
      (i === a.length || rows[i][j + 1] >= rows[i + 1][j])
    )
      add("added", b[j++]);
    else add("removed", a[i++]);
  }
  return out;
}

export function buildDisclosureMatrix(companies, requested = []) {
  return requested.map((ticker) => {
    const company = companies.find((c) => c.ticker === ticker);
    const filings = company?.filings || [];
    const reviewed = filings.filter((f) => f.status === "reviewed");
    return {
      ticker,
      reviewed: reviewed.length,
      attempted: filings.length,
      missing: filings.length - reviewed.length,
      error: company?.error || (!company ? "Not yet searched" : ""),
      bounded: Boolean(company?.limited || company?.historyLimited),
      cells: DISCLOSURE_TOPICS.map((t) => ({
        ...t,
        hits: reviewed.filter((f) => f.topics?.[t.id] > 0).length,
        accessions: reviewed
          .filter((f) => f.topics?.[t.id] > 0)
          .map((f) => f.accession),
        state: !reviewed.length
          ? "unknown"
          : reviewed.some((f) => f.topics?.[t.id] > 0)
            ? "match"
            : "no-match",
      })),
    };
  });
}

/** @param {any[]} companies @param {{topic?: string, form?: string, requested?: string[]}} options */
export function buildDisclosureTrends(
  companies,
  { topic = "query", form = "10-K", requested = [] } = {},
) {
  const periods = new Map();
  for (const company of companies) {
    // Amendments are separate evidence, not new periods or replacements for full reports.
    const original = (company.filings || [])
      .filter((f) => f.form === form && f.reportDate)
      .sort((a, b) => b.filingDate.localeCompare(a.filingDate));
    const seen = new Set();
    for (const filing of original) {
      const period =
        form === "10-Q"
          ? `${filing.reportDate.slice(0, 4)} Q${Math.ceil(Number(filing.reportDate.slice(5, 7)) / 3)}`
          : filing.reportDate.slice(0, 4);
      if (seen.has(period)) continue;
      seen.add(period);
      if (!periods.has(period))
        periods.set(period, { period, reviewed: [], matched: [], failed: [] });
      const row = periods.get(period);
      if (filing.status !== "reviewed") row.failed.push(company.ticker);
      else {
        row.reviewed.push(company.ticker);
        if (topic === "query" ? filing.matched : filing.topics?.[topic] > 0)
          row.matched.push(company.ticker);
      }
    }
  }
  const rows = [...periods.values()].sort((a, b) =>
    a.period.localeCompare(b.period),
  );
  return rows.map((row, index) => {
    const prior = rows[index - 1];
    const same = prior
      ? row.reviewed.filter((t) => prior.reviewed.includes(t))
      : [];
    const currentPaired = same.filter((t) => row.matched.includes(t)).length;
    const previousPaired = same.filter((t) => prior.matched.includes(t)).length;
    return {
      ...row,
      denominator: row.reviewed.length,
      numerator: row.matched.length,
      prevalence: row.reviewed.length
        ? (row.matched.length / row.reviewed.length) * 100
        : null,
      missing: requested.filter((t) => !row.reviewed.includes(t)),
      entered: prior
        ? row.reviewed.filter((t) => !prior.reviewed.includes(t))
        : [],
      left: prior
        ? prior.reviewed.filter((t) => !row.reviewed.includes(t))
        : [],
      paired: {
        companies: same,
        current: currentPaired,
        previous: previousPaired,
        delta: same.length
          ? ((currentPaired - previousPaired) / same.length) * 100
          : null,
      },
    };
  });
}
