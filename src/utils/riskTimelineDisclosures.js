import { disclosurePassages, passageSignals, compareDisclosurePassages } from './disclosureResearch.js';
import { parseDisclosureQuery, matchesQuery } from './disclosureQuery.js';

export const RISK_TIMELINE_LIMITS = Object.freeze({ filings: 4, historyFiles: 2, documentBytes: 24_000_000,
  requestMs: 55_000, excerpts: 24, excerptCharacters: 600, responseBytes: 65_536,
  passagesPerTopic: 40, analysisCharactersPerFiling: 200_000 });
export const RISK_TIMELINE_TOPICS = Object.freeze([
  { id: 'customer-concentration', label: 'Customer concentration', query: '"customer concentration" OR "major customer" OR "major customers" OR "significant customer" OR "significant customers" OR "largest customer" OR "largest customers" OR "single customer" OR "single customers" OR "customers accounted" OR "customer accounted" OR "customers represented" OR "customer represented"' },
  { id: 'covenants', label: 'Covenants', query: 'covenant OR covenants OR "event of default" OR "events of default" OR ((waiver OR waivers) AND (loan OR loans OR credit OR debt OR borrowing OR borrowings))' },
  { id: 'collateral', label: 'Collateral', query: 'collateral OR pledged OR "security interest" OR "security interests" OR "secured borrowing" OR "secured borrowings" OR "secured debt"' },
].map(topic => Object.freeze({ ...topic, parsed: parseDisclosureQuery(topic.query) })));

// A reporting-date roll-forward, punctuation or typography alone is not a
// disclosure change. Other numbers and every negation remain significant.
export function comparableTimelineText(text, reportDate) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/\b(as of(?: both)?|at|for (?:the )?(?:year|quarter|period|three months|six months|nine months) ended)\s+((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,)?\s+20\d{2}|20\d{2}-\d{2}-\d{2})\b/g, (whole, lead, date) => {
      const time = Date.parse(/^20\d{2}-/.test(date) ? `${date}T00:00:00Z` : `${date} UTC`);
      return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === reportDate ? `${lead} reportingdate` : whole;
    })
    .replace(/\u2212/g, '-').replace(/(?<=\d),(?=\d)/g, '')
    .replace(/(?<=\p{L})[-–—](?=\p{L})/gu, ' ')
    // Keep decimal points, numeric signs, currency, percentages and threshold
    // operators. They can change a disclosed amount without changing its words.
    .replace(/[^\p{L}\p{N}\p{Sc}%+<>=≥≤.()\-]+/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
}

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
function topicSentences(text, topic) {
  return [...sentenceSegmenter.segment(text)].map(part => part.segment.trim()).filter(sentence =>
    topic.id === 'customer-concentration' ? isCustomerConcentrationDisclosure(sentence) : matchesQuery(sentence, topic.parsed));
}
const topicSignature = (passage, topic, reportDate) => `${passage.sectionId}:${[...new Set(topicSentences(passage.text, topic)
  .map(sentence => comparableTimelineText(sentence, reportDate)))].sort().join('\n')}`;

export function isTimelineNarrative(text) {
  const words = text.match(/\p{L}+/gu) || [];
  if (text.length < 35 || text.length > 12_000 || words.length < 6 || !/[a-z]/.test(text)) return false;
  if (/\.{3,}\s*\d*\s*$/.test(text) || /^(?:table of contents|index to|item\s+\d|note\s+\d)[^.!?]{0,100}$/i.test(text)) return false;
  // The reader preserves table cells as separate blocks. Do not turn labels,
  // numeric tables or a contents list into narrative evidence.
  const letters = (text.match(/\p{L}/gu) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  return letters > digits * 2 && /[.;!?](?:\s|$)/.test(text);
}

/** A customer reference alone can describe sales or marketing. Require a
 * concentration benchmark, reported share, or explicit dependence on a small
 * customer group. Negated disclosures satisfy the same test without alteration. */
export function isCustomerConcentrationDisclosure(text) {
  if (!/\bcustomers?\b/i.test(text)) return false;
  if (/\bcustomer(?:s)?\s+concentration\b/i.test(text)) return true;
  // Require the relationship within a sentence. Otherwise an accounting-policy
  // paragraph can mention both customers and unrelated revenue percentages.
  return text.split(/(?<=[.!?])\s+(?=[A-Z])/).some(sentence => {
    const benchmark = /\b(?:revenues?|sales|receivables?|purchases)\b/i.test(sentence);
    const quantifiedShare = /\d[\d.,]*\s*%|\b(?:percent|percentage|portion|majority|share)\b|\$\s*\d/i.test(sentence);
    const customerShare = /\bcustomers?\b.{0,100}\b(?:account(?:ed|s)?|represent(?:ed|s)?|responsible for|contribut(?:e|ed|es)|compris(?:e|ed|es))\b/i.test(sentence);
    const qualifiedCustomer = /\b(?:single|one|two|three|largest|major|significant|individual)\s+customers?\b/i.test(sentence);
    const dependency = /\b(?:depend(?:s|ed|ent|ence|ency)?|rely|relies|reliance)\b.{0,100}\b(?:single|one|two|few|small number|limited number|major|largest|significant)\b.{0,50}\bcustomers?\b/i.test(sentence);
    return benchmark && quantifiedShare && (customerShare || qualifiedCustomer) || dependency;
  });
}

// Keep the existing comparison engine's foreign-layout safeguard even though
// this view retains only topic paragraphs rather than a second full-text copy.
function narrativeLayout(paragraphs) {
  let boundaries = 0, continuations = 0;
  const lengths = paragraphs.map(p => (p.text.match(/\p{L}+/gu) || []).length);
  for (let index = 0; index < paragraphs.length - 1; index++) {
    if (lengths[index] < 8 || lengths[index + 1] < 4) continue;
    boundaries++;
    if (!/[.!?;:][”’"')\]]*$/.test(paragraphs[index].text) && /^[a-z]/.test(paragraphs[index + 1].text)) continuations++;
  }
  return { boundaries, share: boundaries ? continuations / boundaries : 0 };
}

/** Parse each document once. Retain only bounded complete topic paragraphs;
 * comparison always happens before the display excerpt is shortened. */
export function extractTimelineDisclosures(text, form) {
  const extracted = disclosurePassages(text, form);
  let retainedCharacters = 0;
  const retainedText = new Set();
  const retain = passage => {
    if (retainedText.has(passage.text)) return true;
    if (retainedCharacters + passage.text.length > RISK_TIMELINE_LIMITS.analysisCharactersPerFiling) return false;
    retainedText.add(passage.text); retainedCharacters += passage.text.length;
    return true;
  };
  const topics = {};
  for (const topic of RISK_TIMELINE_TOPICS) {
    const matching = extracted.paragraphs.filter(p => topic.id === 'customer-concentration'
      ? isCustomerConcentrationDisclosure(p.text) : matchesQuery(p.text, topic.parsed));
    const prose = matching.filter(p => isTimelineNarrative(p.text));
    const ranked = prose.map(p => ({ ...p, ...passageSignals(p.text, topic.parsed.positive, p.sectionId), change: 'uncompared' }))
      .sort((a, b) => Number(b.sectionId !== 'other') - Number(a.sectionId !== 'other') || b.relevance - a.relevance || a.index - b.index);
    const retained = [];
    for (const p of ranked) {
      if (retained.length >= RISK_TIMELINE_LIMITS.passagesPerTopic || !retain(p)) continue;
      retained.push(p);
    }
    retained.sort((a, b) => a.index - b.index);
    topics[topic.id] = { form, paragraphs: retained, matches: retained, sections: extracted.sections,
      matchingParagraphs: prose.length, rejectedParagraphs: matching.length - prose.length,
      limited: retained.length < prose.length, omittedMatches: prose.length - retained.length };
  }
  // A new collateral clause can revise an earlier funding paragraph that did
  // not mention collateral. Keep those identified-section paragraphs only as
  // comparison candidates; they never count as collateral mentions or events.
  const collateral = topics.collateral;
  const indexes = new Set(collateral.paragraphs.map(p => p.index));
  const covenantQuery = RISK_TIMELINE_TOPICS.find(topic => topic.id === 'covenants').parsed;
  const funding = /\b(?:credit\s+(?:facilit(?:y|ies)|agreements?)|loans?\s+(?:facilit(?:y|ies)|agreements?)|(?:borrowing|lending|debt|financing)\s+(?:facilit(?:y|ies)|agreements?|arrangements?)|revolving\s+(?:credit|facilit(?:y|ies))|revolver)\b/i;
  const candidates = extracted.paragraphs.filter(p => p.sectionId !== 'other' && !indexes.has(p.index)
    && isTimelineNarrative(p.text) && (funding.test(p.text) || matchesQuery(p.text, covenantQuery)));
  collateral.paragraphs = [...collateral.matches];
  for (const p of candidates) {
    if (collateral.paragraphs.length >= RISK_TIMELINE_LIMITS.passagesPerTopic || !retain(p)) continue;
    collateral.paragraphs.push(p);
  }
  collateral.paragraphs.sort((a, b) => a.index - b.index);
  return { topics, sections: extracted.sections.map(section => section.id), extraction: extracted.extraction,
    layout: form === '20-F' ? narrativeLayout(extracted.paragraphs) : null };
}

const sentencesOf = text => [...sentenceSegmenter.segment(text)].map(part => ({ 0: part.segment, index: part.index }));
function sentenceTokens(text, reportDate) {
  const dates = [...text.matchAll(/\b(?:as of(?: both)?|at|for (?:the )?(?:year|quarter|period|three months|six months|nine months) ended)\s+(?:(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+20\d{2}|20\d{2}-\d{2}-\d{2})\b/gi)]
    .filter(match => comparableTimelineText(match[0], reportDate).includes('reportingdate'));
  const tokens = [];
  for (const match of text.matchAll(/\S+/g)) {
    const date = dates.find(span => match.index >= span.index && match.index < span.index + span[0].length);
    if (date) {
      if (tokens.at(-1)?.date !== date.index) tokens.push({ key: 'reportingdate', index: date.index, date: date.index });
    } else {
      const key = comparableTimelineText(match[0]);
      if (key) tokens.push({ key, index: match.index });
    }
  }
  return tokens;
}
function revisionPreview(full, counterpart, reportDate, counterpartReportDate, cut, topic) {
  const oldSentences = sentencesOf(counterpart.text);
  const oldKeys = new Set(oldSentences.map(match => comparableTimelineText(match[0], counterpartReportDate)));
  const changed = sentencesOf(full).find(match => match.index + match[0].length > cut
    && (!topic || topicSentences(match[0], topic).length)
    && !oldKeys.has(comparableTimelineText(match[0], reportDate)));
  if (!changed) return null;
  const tokens = sentenceTokens(changed[0], reportDate);
  // Select the corresponding sentence within the already matched paragraph.
  // Shared leading and trailing tokens distinguish it from nearby boilerplate.
  const candidates = oldSentences.map(match => {
    const other = sentenceTokens(match[0], counterpartReportDate);
    let lead = 0, tail = 0;
    while (lead < tokens.length && lead < other.length && tokens[lead].key === other[lead].key) lead++;
    while (tail < tokens.length - lead && tail < other.length - lead && tokens.at(-tail - 1).key === other.at(-tail - 1).key) tail++;
    return { lead, score: lead + tail };
  }).sort((a, b) => b.score - a.score);
  const focus = changed.index + (tokens[candidates[0]?.lead || 0]?.index ?? 0);
  if (focus <= cut) return null;
  const endOfSentence = changed.index + changed[0].length;
  const ranges = [[0, Math.min(120, full.length)], [changed.index, Math.min(changed.index + 120, endOfSentence)],
    [Math.max(changed.index, focus - 140), Math.min(endOfSentence, focus + 200)]];
  const merged = [];
  for (let [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start > 0 && !/\s/.test(full[start - 1])) { const space = full.indexOf(' ', start); if (space >= 0 && space < end) start = space + 1; }
    if (end < full.length && !/\s/.test(full[end])) { const space = full.lastIndexOf(' ', end); if (space > start) end = space; }
    if (end <= start) continue;
    if (merged.length && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], end);
    else merged.push([start, end]);
  }
  return merged.map(([start, end]) => full.slice(start, end).trim()).join('… ') + (merged.at(-1)?.[1] < full.length ? '…' : '');
}

/** Leading excerpts retain the paragraph's opening qualifications and negation.
 * They are explicitly marked when incomplete; source links retain full context. */
export function timelineExcerpt(passage, url, counterpart, reportDate, counterpartReportDate, topic) {
  const full = passage.text;
  let text = full;
  if (full.length > RISK_TIMELINE_LIMITS.excerptCharacters) {
    const prefix = full.slice(0, RISK_TIMELINE_LIMITS.excerptCharacters - 1);
    const sentences = [...prefix.matchAll(/[.!?](?:\s|$)/g)];
    const last = sentences.at(-1)?.index;
    const cut = last != null && last >= 180 ? last + 1 : Math.max(1, prefix.lastIndexOf(' '));
    text = `${prefix.slice(0, cut).trimEnd()}…`;
    // If the opening preview hides the revision, keep a short opening for
    // qualifications and append source text around the changed sentence.
    // Compare reporting dates semantically so a date roll does not steal focus.
    if (counterpart) text = revisionPreview(full, counterpart, reportDate, counterpartReportDate, cut, topic) || text;
  }
  return { text, url, section: passage.section, paragraphIndex: passage.index, truncated: full.length > text.length };
}

const side = (filing, passages, counterparts, counterpartFiling, topic) => ({ end: filing.reportDate, filed: filing.filed, form: filing.form,
  evidence: passages.map((p, index) => timelineExcerpt(p, filing.url, counterparts?.[index], filing.reportDate, counterpartFiling?.reportDate, topic)), sourceUrls: [filing.url] });

/** Only paired, recognized-section wording revisions become events. Absence,
 * unmatched passages and unreadable sections remain explicit coverage states. */
export function compareTimelineDisclosures(current, prior, currentFiling, priorFiling) {
  const events = [], coverage = {};
  const allowed = currentFiling.form === priorFiling.form && priorFiling.reportDate < currentFiling.reportDate
    && priorFiling.filed <= currentFiling.filed && !currentFiling.form.endsWith('/A') && !priorFiling.form.endsWith('/A');
  const gapDays = Math.round((Date.parse(currentFiling.reportDate) - Date.parse(priorFiling.reportDate)) / 86_400_000);
  const layoutMismatch = currentFiling.form === '20-F' && current.layout?.boundaries >= 12 && prior.layout?.boundaries >= 12
    && (current.layout.share >= 0.4 && prior.layout.share <= 0.1 || prior.layout.share >= 0.4 && current.layout.share <= 0.1);
  for (const topic of RISK_TIMELINE_TOPICS) {
    const after = current.topics[topic.id], before = prior.topics[topic.id];
    const sectionCoverage = after.sections.map(section => section.id);
    const base = { matches: after.matchingParagraphs, sectionCoverage, limited: after.limited || before.limited,
      omittedMatches: after.omittedMatches, ...(allowed ? { comparedTo: { accession: priorFiling.accession, reportDate: priorFiling.reportDate,
        filed: priorFiling.filed, form: priorFiling.form, gapDays } } : {}) };
    if (layoutMismatch) {
      coverage[topic.id] = { ...base, status: after.matchingParagraphs ? 'uncompared' : 'missing', unpairedMatches: after.matches.length,
        comparisonError: 'These 20-F reports use different text layouts: printed-line fragments versus complete paragraphs. Compare the original reports before interpreting wording changes.' };
      continue;
    }
    if (!allowed || !after.matches.length || !before.paragraphs.length) {
      coverage[topic.id] = { ...base, status: !after.matchingParagraphs ? 'missing' : 'uncompared', unpairedMatches: after.matches.length };
      continue;
    }
    const diff = compareDisclosurePassages(after, before);
    if (diff.comparisonError) {
      coverage[topic.id] = { ...base, status: 'uncompared', comparisonError: diff.comparisonError, unpairedMatches: after.matches.length };
      continue;
    }
    const revisions = diff.matches.flatMap(p => {
      if (p.change !== 'revised' || !p.priorText || p.sectionId === 'other'
        || comparableTimelineText(p.text, currentFiling.reportDate) === comparableTimelineText(p.priorText, priorFiling.reportDate)) return [];
      const old = before.paragraphs.find(candidate => candidate.text === p.priorText && candidate.sectionId === p.sectionId);
      // A paragraph can discuss several risks. A revised customer percentage
      // must not produce a collateral marker when its collateral sentence is
      // unchanged. Compare complete relevant sentences, retain original full
      // paragraphs for the source excerpts and their opening qualifications.
      return old && topicSignature(p, topic, currentFiling.reportDate) !== topicSignature(old, topic, priorFiling.reportDate)
        ? [{ after: p, before: old, relevance: p.relevance }] : [];
    }).sort((a, b) => b.relevance - a.relevance || a.after.index - b.after.index);
    const exactBefore = new Set(before.matches.map(p => topicSignature(p, topic, priorFiling.reportDate)));
    const exactAfter = new Set(after.matches.map(p => topicSignature(p, topic, currentFiling.reportDate)));
    const same = after.matches.every(p => exactBefore.has(topicSignature(p, topic, currentFiling.reportDate)))
      && before.matches.every(p => exactAfter.has(topicSignature(p, topic, priorFiling.reportDate)));
    coverage[topic.id] = { ...base, status: revisions.length ? 'differed' : same ? 'unchanged' : 'uncompared',
      unpairedMatches: diff.matches.filter(p => !['unchanged', 'revised'].includes(p.change)).length };
    if (!revisions.length) continue;
    const retained = revisions.slice(0, 2);
    events.push({ id: `${currentFiling.accession}:${priorFiling.accession}:${topic.id}`, kind: 'disclosure',
      date: currentFiling.reportDate, dateBasis: 'period-end', category: topic.id, categoryLabel: topic.label,
      title: `${topic.label} language changed`, direction: 'review',
      scope: `${currentFiling.form} primary reports · ${priorFiling.reportDate} → ${currentFiling.reportDate} · ${gapDays}-day reporting gap`,
      criterion: 'Topic-relevant sentences changed within similar full passages in the same identified section. Wording changes require source review; they do not establish a change in risk.',
      before: side(priorFiling, retained.map(p => p.before), retained.map(p => p.after), currentFiling, topic),
      after: side(currentFiling, retained.map(p => p.after), retained.map(p => p.before), priorFiling, topic) });
  }
  return { events, coverage };
}
