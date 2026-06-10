// ============================================================================
// riskKeywords — curated red-flag language for SEC filing scans
//
// Same architectural role as cryptoKeywords.js, different domain: instead of
// crypto exposure, this library detects accounting/solvency warning language
// in 10-K / 10-Q / 8-K text. Phrases are deliberately specific — these are
// terms of art that companies do not use casually. False-positive control
// comes from phrase specificity, not from NLP.
//
// Severity: 'high' = stop and read the filing; 'medium' = context-dependent.
// ============================================================================

export const RISK_CATEGORIES = [
  {
    id: 'going-concern',
    label: 'Going concern',
    severity: 'high',
    desc: 'Doubt about the company\u2019s ability to continue operating.',
    phrases: [
      'substantial doubt about our ability to continue as a going concern',
      'substantial doubt about the company\u2019s ability to continue as a going concern',
      'substantial doubt about its ability to continue as a going concern',
      'ability to continue as a going concern',
    ],
  },
  {
    id: 'non-reliance',
    label: 'Non-reliance / restatement',
    severity: 'high',
    desc: 'Previously issued financial statements should no longer be relied upon, or are being restated.',
    phrases: [
      'should no longer be relied upon',
      'should no longer be relied on',
      'restatement of previously issued financial statements',
      'restate our previously issued financial statements',
      'restate its previously issued financial statements',
    ],
  },
  {
    id: 'material-weakness',
    label: 'Material weakness',
    severity: 'high',
    desc: 'A material weakness in internal control over financial reporting.',
    phrases: [
      'material weakness in our internal control over financial reporting',
      'material weakness in internal control over financial reporting',
      'material weaknesses in our internal control',
      'disclosure controls and procedures were not effective',
      'internal control over financial reporting was not effective',
    ],
  },
  {
    id: 'covenant-default',
    label: 'Default / covenant breach',
    severity: 'high',
    desc: 'Debt covenant violations, defaults, or acceleration events.',
    phrases: [
      'event of default',
      'breach of covenant',
      'not in compliance with the financial covenants',
      'not in compliance with certain covenants',
      'waiver of the covenant',
      'forbearance agreement',
    ],
  },
  {
    id: 'investigation',
    label: 'Investigation / subpoena',
    severity: 'medium',
    desc: 'Regulatory or governmental investigations and subpoenas.',
    phrases: [
      'sec investigation',
      'received a subpoena',
      'wells notice',
      'formal order of investigation',
      'department of justice investigation',
      'grand jury subpoena',
    ],
  },
  {
    id: 'impairment',
    label: 'Impairment',
    severity: 'medium',
    desc: 'Goodwill or asset impairment charges.',
    phrases: [
      'goodwill impairment charge',
      'impairment of goodwill',
      'non-cash impairment charge',
      'impairment of long-lived assets',
    ],
  },
  {
    id: 'liquidity',
    label: 'Liquidity stress',
    severity: 'medium',
    desc: 'Language indicating cash adequacy problems.',
    phrases: [
      'may not have sufficient cash',
      'may not be sufficient to fund our operations',
      'substantial additional financing',
      'doubt about our ability to fund',
      'negative working capital',
    ],
  },
];

const CATEGORY_BY_ID = Object.fromEntries(RISK_CATEGORIES.map((c) => [c.id, c]));
export function getRiskCategory(id) {
  return CATEGORY_BY_ID[id] || null;
}

const MAX_MATCHES_PER_DOC = 40;

/**
 * Scan text for risk phrases. Returns [{ categoryId, severity, phrase, index }].
 * Text is lowercased once; phrases are stored lowercase. Index points into the
 * ORIGINAL text so excerpts keep original casing.
 */
export function findRiskMatches(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const matches = [];
  for (const cat of RISK_CATEGORIES) {
    for (const phrase of cat.phrases) {
      let from = 0;
      while (matches.length < MAX_MATCHES_PER_DOC) {
        const idx = lower.indexOf(phrase, from);
        if (idx === -1) break;
        matches.push({ categoryId: cat.id, severity: cat.severity, phrase, index: idx });
        from = idx + phrase.length;
      }
      if (matches.length >= MAX_MATCHES_PER_DOC) break;
    }
    if (matches.length >= MAX_MATCHES_PER_DOC) break;
  }
  return matches;
}

/**
 * Pull a readable excerpt around a match index. Expands to nearby sentence
 * boundaries within a radius, collapses whitespace.
 */
export function extractRiskExcerpt(text, index, radius = 320) {
  if (!text) return '';
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  let chunk = text.slice(start, end);
  // Trim to sentence-ish boundaries where possible
  const firstStop = chunk.search(/[.!?]\s/);
  if (start > 0 && firstStop > -1 && firstStop < radius * 0.6) {
    chunk = chunk.slice(firstStop + 2);
  }
  const lastStop = chunk.lastIndexOf('. ');
  if (end < text.length && lastStop > chunk.length - radius * 0.6 && lastStop > 0) {
    chunk = chunk.slice(0, lastStop + 1);
  }
  return chunk.replace(/\s+/g, ' ').trim();
}
