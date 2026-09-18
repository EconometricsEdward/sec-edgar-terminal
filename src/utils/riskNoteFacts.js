/** Bounded, namespace-aware extraction of standard SEC risk note concepts.
 * Values come only from inline facts and their exact XBRL contexts and units.
 * Narrative proximity, table position and missing values never supply numbers.
 */
export const RISK_NOTE_FACTS_VERSION = 'risk-note-facts-v3';
export const RISK_NOTE_MAX_BYTES = 24_000_000;
const XBRLI = 'http://www.xbrl.org/2003/instance';
const XBRLDI = 'http://xbrl.org/2006/xbrldi';
const INLINE = new Set(['http://www.xbrl.org/2013/inlineXBRL', 'http://www.xbrl.org/2008/inlineXBRL']);
const FAIR_VALUE_CONCEPTS = new Set(['DerivativeAssets', 'DerivativeLiabilities']);
const CONCEPTS = new Set(['DerivativeNotionalAmount', 'ConcentrationRiskPercentage1', ...FAIR_VALUE_CONCEPTS]);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const local = name => String(name || '').split(':').at(-1);
const humanize = value => local(value).replace(/(?:Member|Axis)$/, '').replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
function decoded(text) {
  return text.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (whole, number, name) => {
    if (number) { const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[name.toLowerCase()];
  });
}

// XML/HTML lexical tokens, including quoted '>' characters. No document tree is
// built: only the small context/unit/fact records below retain child nodes.
function* tokens(html) {
  let position = 0;
  while (position < html.length) {
    const start = html.indexOf('<', position);
    if (start < 0) { yield { text: html.slice(position) }; break; }
    if (start > position) yield { text: html.slice(position, start) };
    if (html.startsWith('<!--', start)) { const end = html.indexOf('-->', start + 4); position = end < 0 ? html.length : end + 3; continue; }
    let end = start + 1, quote = null;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === html.length) break;
    const raw = html.slice(start + 1, end), match = /^\s*(\/?)\s*([A-Za-z_][\w:.-]*)/.exec(raw);
    position = end + 1;
    if (!match) continue;
    const attrs = {};
    if (!match[1]) {
      const source = raw.slice(match[0].length);
      for (const attribute of source.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const key = attribute[1].toLowerCase();
        if (Object.hasOwn(attrs, key)) attrs._invalid = true;
        attrs[key] = decoded(attribute[2] ?? attribute[3]);
      }
    }
    yield { name: match[2], close: Boolean(match[1]), self: /\/\s*$/.test(raw), attrs };
  }
}
const descendants = (node, name, namespace) => {
  const found = [];
  for (const child of node.children || []) {
    if (child.local === name && (!namespace || child.namespace === namespace)) found.push(child);
    found.push(...descendants(child, name, namespace));
  }
  return found;
};
const nodeText = node => (node.parts || []).map(part => typeof part === 'string' ? decoded(part) : nodeText(part)).join('').trim();
const one = (node, name, namespace) => { const found = descendants(node, name, namespace); return found.length === 1 ? nodeText(found[0]) : null; };
const standard = (qname, namespaces) => /^https?:\/\/fasb\.org\/us-gaap\/20\d{2}(?:-\d{2}-\d{2})?$/.test(namespaces[qname?.split(':')[0]] || '');
const namespaceFor = (name, namespaces) => namespaces[name.includes(':') ? name.split(':')[0] : ''] || '';

// This standard concept is also used for signed reconciliation adjustments in
// the verified ExxonMobil filing. Do not allow arbitrary negative gross asset
// values or infer offsetting from a similarly named custom member elsewhere.
const supportedFairValueOffset = (dimensions, namespaces, cik, filing) => String(cik).replace(/^0+/, '') === '34088'
  && filing.reportDate === '2026-06-30' && dimensions.length === 1
  && dimensions.some(dimension => local(dimension.axis) === 'DerivativeInstrumentRiskAxis' && standard(dimension.axis, namespaces)
    && namespaceFor(dimension.member, namespaces) === 'http://www.exxonmobil.com/20260630'
    && ['EffectOfCounterpartyNettingMember', 'EffectOfCollateralNettingMember'].includes(local(dimension.member)));

function numberValue(node, namespaces) {
  const attrs = node.attrs;
  if (attrs._invalid || attrs['xsi:nil'] === 'true' || attrs['xsi:nil'] === '1' || attrs.continuedat || descendants(node, 'exclude').length) return null;
  const format = local(attrs.format).toLowerCase();
  // Unknown transformations, fractions and locale-specific forms are omitted.
  if (format && !['num-dot-decimal', 'numdotdecimal', 'num-dot-decimal-in', 'zerodash', 'fixed-zero'].includes(format)) return null;
  if (format && !/^https?:\/\/www\.xbrl\.org\/inlineXBRL\/transformation\/20\d{2}-\d{2}-\d{2}$/.test(namespaceFor(attrs.format, namespaces))) return null;
  let raw = nodeText(node).replace(/[\s\u00a0]/g, '');
  if (format === 'fixed-zero') {
    // Registry 4/5 explicitly define fixed-zero. Support visible zero/dash/empty
    // forms only; conflicting numeric text stays unavailable instead of being
    // silently rewritten to zero. A similarly named custom transform is invalid.
    if (!/^http:\/\/www\.xbrl\.org\/inlineXBRL\/transformation\/(?:2020-02-12|2022-02-16)$/.test(namespaceFor(attrs.format, namespaces))
      || !/^(?:[-\u2010-\u2015\u2212]|0+(?:\.0+)?)?$/.test(raw)) return null;
    raw = '0';
  }
  if (format === 'zerodash' && /^[-–—]$/.test(raw)) raw = '0';
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(raw)) return null;
  const scale = attrs.scale == null ? 0 : Number(attrs.scale);
  if (!Number.isInteger(scale) || Math.abs(scale) > 12 || (attrs.sign != null && attrs.sign !== '-')) return null;
  const value = Number(`${raw.replaceAll(',', '')}e${scale}`) * (attrs.sign === '-' ? -1 : 1);
  return Number.isFinite(value) ? value === 0 ? 0 : value : null;
}

function contextValue(node, cik) {
  if (node.attrs._invalid || descendants(node, 'typedMember', XBRLDI).length || descendants(node, 'scenario', XBRLI).length) return null;
  const identifiers = descendants(node, 'identifier', XBRLI);
  if (identifiers.length !== 1 || !/^https?:\/\/www\.sec\.gov\/CIK$/i.test(identifiers[0].attrs.scheme || '')
    || nodeText(identifiers[0]).replace(/^0+/, '') !== String(cik).replace(/^0+/, '')) return null;
  const instant = one(node, 'instant', XBRLI), start = one(node, 'startDate', XBRLI), end = one(node, 'endDate', XBRLI);
  if (instant ? !validDate(instant) || start || end : !validDate(start) || !validDate(end) || start > end) return null;
  const dimensions = descendants(node, 'explicitMember', XBRLDI).map(member => ({ axis: member.attrs.dimension, member: nodeText(member), label: humanize(nodeText(member)) }));
  if (dimensions.some(dimension => !/^[\w.-]+:[\w.-]+$/.test(dimension.axis || '') || !/^[\w.-]+:[\w.-]+$/.test(dimension.member))
    || new Set(dimensions.map(dimension => dimension.axis)).size !== dimensions.length) return null;
  dimensions.sort((a, b) => a.axis.localeCompare(b.axis));
  return { start: instant ? null : start, end: instant || end, periodType: instant ? 'instant' : 'duration', dimensions };
}
function describe(tag, dimensions, namespaces) {
  if (FAIR_VALUE_CONCEPTS.has(local(tag))) {
    const asset = local(tag) === 'DerivativeAssets';
    // Fair-value levels, carrying values and signed netting adjustments are
    // independent reported measures. Keep every dimension in the row identity
    // and label; these values must never be relabeled as contract notionals.
    return { kind: 'derivative_fair_value', category: asset ? 'derivative_asset' : 'derivative_liability',
      label: [asset ? 'Derivative assets' : 'Derivative liabilities', ...dimensions.map(dimension => dimension.label)].join(' · ') };
  }
  const members = dimensions.filter(dimension => standard(dimension.axis, namespaces) && standard(dimension.member, namespaces)).map(dimension => local(dimension.member));
  if (local(tag) === 'ConcentrationRiskPercentage1') {
    const customer = dimensions.find(dimension => /MajorCustomersAxis$/.test(dimension.axis));
    const benchmark = dimensions.find(dimension => /ConcentrationRiskByBenchmarkAxis$/.test(dimension.axis));
    return { kind: 'credit_concentration', category: 'credit_concentration', label: [customer?.label, benchmark?.label || 'Concentration risk'].filter(Boolean).join(' · ') };
  }
  const category = members.includes('ForeignExchangeContractMember') ? 'foreign_exchange' : members.includes('InterestRateContractMember') ? 'interest_rate' : 'other_derivative';
  const instrument = dimensions.find(dimension => /DerivativeInstrumentRiskAxis$/.test(dimension.axis));
  const designation = dimensions.find(dimension => /HedgingDesignationAxis$/.test(dimension.axis));
  const designated = members.includes('DesignatedAsHedgingInstrumentMember'), nondesignated = members.includes('NondesignatedMember');
  const name = category === 'foreign_exchange' ? 'Foreign exchange' : category === 'interest_rate' ? 'Interest rate' : instrument?.label || 'Derivatives';
  const status = designated ? 'Accounting hedges' : nondesignated ? 'Not designated as accounting hedges' : designation?.label;
  const extras = dimensions.filter(dimension => dimension !== instrument && dimension !== designation).map(dimension => dimension.label);
  return { kind: 'derivative_notional', category, label: [name, status, ...extras].filter(Boolean).join(' · ') };
}

function readInlineRiskDocument(html, { cik, filing, concepts = CONCEPTS, captureRegistrants = false }) {
  if (typeof html !== 'string' || html.trim().length < 30 || html.length > RISK_NOTE_MAX_BYTES || !/^\d{1,10}$/.test(String(cik)) || !validDate(filing?.reportDate))
    throw new Error('A bounded SEC document, verified issuer and reporting date are required.');
  if (/<title\b[^>]*>[^<]*(?:access denied|request rate threshold|undeclared automated tool)/i.test(html)
    || /<h1\b[^>]*>\s*(?:access denied|request rate threshold|undeclared automated tool)/i.test(html))
    throw Object.assign(new Error('SEC document access is temporarily unavailable. Retry or open the original filing.'), { status: 503 });
  const namespaces = {}, records = [], stack = [];
  let skip = null, capturedNodes = 0;
  for (const token of tokens(html)) {
    if (token.text != null) { if (stack.length) stack.at(-1).parts.push(token.text); continue; }
    if (skip) { if (token.close && token.name.toLowerCase() === skip) skip = null; continue; }
    if (!token.close && ['script', 'style'].includes(token.name.toLowerCase())) { skip = token.name.toLowerCase(); continue; }
    if (!token.close) for (const [name, value] of Object.entries(token.attrs)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        const prefix = name === 'xmlns' ? '' : name.slice(6);
        // Ambiguous prefix rebinding invalidates affected namespaces instead of
        // letting a custom concept impersonate a standard taxonomy concept.
        namespaces[prefix] = namespaces[prefix] && namespaces[prefix] !== value ? 'ambiguous' : value;
      }
    }
    const namespace = namespaceFor(token.name, namespaces), name = local(token.name);
    if (token.close) {
      if (!stack.length) continue;
      if (stack.at(-1).name !== token.name) { stack.length = 0; continue; }
      const ended = stack.pop();
      if (!stack.length) records.push(ended);
      continue;
    }
    const wanted = (namespace === XBRLI && ['context', 'unit'].includes(name))
      || (INLINE.has(namespace) && name.toLowerCase() === 'nonfraction' && concepts.has(local(token.attrs.name)) && standard(token.attrs.name, namespaces))
      || (captureRegistrants && INLINE.has(namespace) && name.toLowerCase() === 'nonnumeric'
        && ['EntityCentralIndexKey', 'DocumentPeriodEndDate', 'DocumentType'].includes(local(token.attrs.name))
        && /^https?:\/\/xbrl\.sec\.gov\/dei\/20\d{2}(?:-\d{2}-\d{2})?$/.test(namespaceFor(token.attrs.name, namespaces)));
    if (!stack.length && !wanted) continue;
    if (++capturedNodes > 200_000) throw new Error('The SEC note document exceeds parser limits.');
    const node = { ...token, local: name, namespace, children: [], parts: [] };
    if (stack.length) { stack.at(-1).children.push(node); stack.at(-1).parts.push(node); }
    if (token.self) { if (!stack.length) records.push(node); }
    else stack.push(node);
    if (stack.length > 64 || records.length > 100_000) throw new Error('The SEC note document exceeds parser limits.');
  }
  const contexts = new Map(), units = new Map(), duplicates = new Set(), facts = [];
  for (const node of records) {
    if (node.namespace === XBRLI && ['context', 'unit'].includes(node.local)) {
      const target = node.local === 'context' ? contexts : units, id = node.attrs.id, duplicateKey = `${node.local}:${id}`;
      if (!id || target.has(id) || duplicates.has(duplicateKey)) { target.delete(id); duplicates.add(duplicateKey); continue; }
      if (node.local === 'context') target.set(id, contextValue(node, cik));
      else {
        const measure = one(node, 'measure', XBRLI);
        const simple = !node.attrs._invalid && !descendants(node, 'divide', XBRLI).length;
        target.set(id, simple && local(measure) === 'USD' && namespaceFor(measure, namespaces) === 'http://www.xbrl.org/2003/iso4217' ? 'USD'
          : simple && measure && local(measure) === 'pure' && namespaceFor(measure, namespaces) === XBRLI ? 'pure' : null);
      }
    } else facts.push(node);
  }
  return { namespaces, contexts, units, facts };
}

/** Validate the DEI identity of a pre-transition joint filing without changing
 * ordinary fact-context identity checks. Both legal registrants must be tagged;
 * the predecessor owns the undimensioned reporting context and the successor is
 * explicitly a legal-entity member in that same reporting period.
 */
export function verifiesJointRegistrantFacts(html, { cik, predecessorCik, filing }) {
  const { namespaces, contexts, facts } = readInlineRiskDocument(html, { cik: predecessorCik, filing, concepts: new Set(), captureRegistrants: true });
  const normalizeCik = value => /^\d{1,10}$/.test(value) && Number(value) > 0 ? value.padStart(10, '0') : null;
  const samePeriod = context => context?.periodType === 'duration' && context.end === filing.reportDate;
  const rows = facts.flatMap(node => {
    const context = contexts.get(node.attrs.contextref);
    if (node.attrs._invalid || node.attrs.continuedat || node.attrs['xsi:nil'] || descendants(node, 'exclude').length || !samePeriod(context)) return [];
    return [{ concept: local(node.attrs.name), value: nodeText(node), context }];
  });
  const base = rows.filter(row => !row.context.dimensions.length);
  const predecessor = base.filter(row => row.concept === 'EntityCentralIndexKey');
  if (!predecessor.length || predecessor.some(row => normalizeCik(row.value) !== normalizeCik(predecessorCik))) return false;
  const successor = rows.filter(row => row.concept === 'EntityCentralIndexKey' && row.context.dimensions.length === 1
    && local(row.context.dimensions[0].axis) === 'LegalEntityAxis'
    && /^https?:\/\/xbrl\.sec\.gov\/dei\/20\d{2}(?:-\d{2}-\d{2})?$/.test(namespaceFor(row.context.dimensions[0].axis, namespaces)));
  if (!successor.some(row => normalizeCik(row.value) === normalizeCik(cik))) return false;
  const periods = base.filter(row => row.concept === 'DocumentPeriodEndDate');
  const types = base.filter(row => row.concept === 'DocumentType');
  const periodDate = value => validDate(value) ? value : /^[A-Za-z]+ \d{1,2}, \d{4}$/.test(value) && Number.isFinite(Date.parse(`${value} UTC`)) ? new Date(`${value} UTC`).toISOString().slice(0, 10) : null;
  return periods.length > 0 && periods.every(row => periodDate(row.value) === filing.reportDate)
    && types.length > 0 && types.every(row => row.value === filing.form);
}

/** Namespace-verified standard USD facts for company concentration views.
 * The caller supplies a fixed concept allowlist; dimensions retain the exact
 * reported context. Conflicting duplicates are omitted, never picked at random.
 */
export function extractCompanyInlineFacts(html, { cik, filing, concepts }) {
  const { namespaces, contexts, units, facts } = readInlineRiskDocument(html, { cik, filing, concepts });
  const observations = new Map();
  let rejectedFacts = 0;
  for (const node of facts) {
    const context = contexts.get(node.attrs.contextref), unit = units.get(node.attrs.unitref), value = numberValue(node, namespaces), tag = node.attrs.name;
    if (!standard(tag, namespaces) || !context || unit !== 'USD' || value == null || context.end > filing.reportDate) { rejectedFacts++; continue; }
    const id = JSON.stringify([local(tag), context.start, context.end, context.dimensions.map(({ axis, member }) => [axis, member])]);
    const fact = { id, tag, concept: local(tag), unit, value, ...context, contextId: node.attrs.contextref, factId: node.attrs.id || null,
      sourceUrl: `${filing.url}${node.attrs.id && /^[\w.-]+$/.test(node.attrs.id) ? `#${node.attrs.id}` : ''}` };
    if (observations.has(id) && observations.get(id)?.value !== value) observations.set(id, null);
    else if (!observations.has(id)) observations.set(id, fact);
  }
  return { rows: [...observations.values()].filter(Boolean), coverage: { inlineFactsFound: facts.length, rejectedFacts, dimensional: true } };
}

export function extractRiskNoteFacts(html, { cik, filing }) {
  const { namespaces, contexts, units, facts } = readInlineRiskDocument(html, { cik, filing });
  const grouped = new Map();
  let rejectedFacts = 0;
  for (const node of facts) {
    const context = contexts.get(node.attrs.contextref), unit = units.get(node.attrs.unitref), value = numberValue(node, namespaces), tag = node.attrs.name;
    const fairValue = FAIR_VALUE_CONCEPTS.has(local(tag));
    const expectedUnit = local(tag) === 'ConcentrationRiskPercentage1' ? 'pure' : 'USD';
    if (!standard(tag, namespaces) || !context || unit !== expectedUnit || value == null
      || (value < 0 && !(fairValue && supportedFairValueOffset(context.dimensions, namespaces, cik, filing)))
      || (unit === 'pure' && value > 1) || context.end > filing.reportDate) { rejectedFacts++; continue; }
    if (expectedUnit === 'USD' && context.periodType !== 'instant') { rejectedFacts++; continue; }
    if (expectedUnit === 'pure' && !context.dimensions.some(dimension => local(dimension.axis) === 'ConcentrationRiskByTypeAxis'
      && standard(dimension.axis, namespaces) && local(dimension.member) === 'CreditConcentrationRiskMember' && standard(dimension.member, namespaces))) { rejectedFacts++; continue; }
    const identity = JSON.stringify([tag, unit, context.dimensions.map(({ axis, member }) => [axis, member])]);
    if (!grouped.has(identity)) grouped.set(identity, { identity, tag, unit, dimensions: context.dimensions, observations: new Map() });
    const group = grouped.get(identity), dateKey = JSON.stringify([context.start, context.end]);
    const observation = { value, start: context.start, end: context.end, periodType: context.periodType,
      contextId: node.attrs.contextref, factId: node.attrs.id || null, sourceUrl: `${filing.url}${node.attrs.id && /^[\w.-]+$/.test(node.attrs.id) ? `#${node.attrs.id}` : ''}`, tag };
    if (group.observations.has(dateKey) && group.observations.get(dateKey)?.value !== value) group.observations.set(dateKey, null);
    else if (!group.observations.has(dateKey)) group.observations.set(dateKey, observation);
  }
  const rows = [];
  for (const group of grouped.values()) {
    const observations = [...group.observations.values()].filter(Boolean).sort((a, b) => b.end.localeCompare(a.end) || String(b.start).localeCompare(String(a.start)));
    const current = observations.filter(observation => observation.end === filing.reportDate);
    // Different durations ending on the same day are not interchangeable.
    if (current.length !== 1) continue;
    const priorDates = observations.filter(observation => observation.end < current[0].end && observation.periodType === current[0].periodType);
    const priorCandidates = priorDates.filter(observation => observation.end === priorDates[0]?.end);
    const prior = priorCandidates.length === 1 ? priorCandidates[0] : null;
    rows.push({ id: group.identity, ...describe(group.tag, group.dimensions, namespaces), unit: group.unit, dimensions: group.dimensions, current: current[0], prior });
  }
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  // Fair-value expansion must not displace previously supported notionals or
  // concentration shares. Bound each family independently before presentation.
  const retained = [...rows.filter(row => row.kind !== 'derivative_fair_value').slice(0, 60),
    ...rows.filter(row => row.kind === 'derivative_fair_value').slice(0, 60)];
  return { rows: retained, coverage: { inlineFactsFound: facts.length, rejectedFacts, rowsOmitted: rows.length - retained.length, concepts: [...CONCEPTS], dimensional: true } };
}
