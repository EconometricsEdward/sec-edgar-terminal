// SEC Schedule 13D/G cover evidence links a security CUSIP to its issuer CIK.
// A name, 13F manager CIK, ticker guess, or reporting person's CIK is never proof.
const MAX_XML_LENGTH = 2 * 1024 * 1024;
const tidy = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const invalid = (message) => { throw new Error(`Invalid SEC issuer evidence: ${message}`); };
const normalizeCik = (value) => /^\d{1,10}$/.test(String(value)) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const formPattern = /^SCHEDULE 13[DG](?:\/A)?$/;
function decodeXml(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) invalid('unsupported or malformed XML entity');
  return value.replace(/&([^;]+);/g, (_, entity) => {
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || !(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) invalid('invalid XML character');
    return String.fromCodePoint(code);
  });
}

// A bounded, non-expanding XML reader. It accepts the XML vocabulary needed by
// SEC ownership documents, checks balanced qualified names, and never resolves DTDs.
function parseXml(input) {
  if (typeof input !== 'string' || input.length > MAX_XML_LENGTH || !input.trim()) invalid('missing or oversized XML');
  const xml = input.replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)) invalid('unsupported XML declaration or character');
  const document = { children: [], text: '', name: '#document' };
  const stack = [document];
  let cursor = 0;
  let nodes = 0;
  while (cursor < xml.length) {
    if (xml[cursor] !== '<') {
      const end = xml.indexOf('<', cursor);
      const text = xml.slice(cursor, end < 0 ? xml.length : end);
      if (stack.length === 1 && text.trim()) invalid('text outside XML root');
      if (text.includes(']]>')) invalid('malformed XML text');
      stack.at(-1).text += decodeXml(text);
      cursor = end < 0 ? xml.length : end;
      continue;
    }
    if (xml.startsWith('<!--', cursor)) {
      const end = xml.indexOf('-->', cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes('--')) invalid('malformed XML comment');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', cursor)) {
      const end = xml.indexOf(']]>', cursor + 9);
      if (end < 0 || stack.length < 2) invalid('malformed CDATA');
      stack.at(-1).text += xml.slice(cursor + 9, end);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', cursor)) {
      const end = xml.indexOf('?>', cursor + 2);
      if (end < 0 || cursor !== 0 || !/^<\?xml\s/i.test(xml.slice(cursor, end))) invalid('unsupported XML processing instruction');
      cursor = end + 2;
      continue;
    }
    let end = cursor + 1;
    let quote = null;
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else if (character === '<') invalid('malformed XML tag');
    }
    if (end === xml.length || quote) invalid('unterminated XML tag');
    const tag = xml.slice(cursor + 1, end);
    cursor = end + 1;
    if (tag.startsWith('/')) {
      if (!/^\/[A-Za-z_][\w.:-]*\s*$/.test(tag) || stack.length < 2 || stack.at(-1).qualifiedName !== tag.slice(1).trim()) invalid('mismatched XML closing tag');
      stack.pop();
      continue;
    }
    const match = /^([A-Za-z_][\w.:-]*)([\s\S]*?)\/?$/.exec(tag);
    if (!match) invalid('malformed XML opening tag');
    const [, qualifiedName, attributes] = match;
    let remaining = attributes;
    const names = new Set();
    while (remaining) {
      if (!remaining.trim()) break;
      const attribute = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(remaining);
      if (!attribute || names.has(attribute[1])) invalid('malformed or duplicate XML attribute');
      names.add(attribute[1]);
      decodeXml(attribute[2] ?? attribute[3]);
      remaining = remaining.slice(attribute[0].length);
    }
    if (++nodes > 50000 || stack.length > 48) invalid('XML structure exceeds supported limits');
    const node = { qualifiedName, name: qualifiedName.split(':').at(-1), children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!tag.endsWith('/')) stack.push(node);
  }
  if (stack.length !== 1 || document.children.length !== 1) invalid('incomplete or multiple XML roots');
  return document.children[0];
}

function child(node, name) {
  const matches = node?.children?.filter((entry) => entry.name === name) ?? [];
  if (matches.length > 1) invalid(`duplicate ${name} field`);
  return matches[0];
}
const path = (node, ...names) => names.reduce(child, node);
function field(node, ...names) {
  const target = path(node, ...names);
  if (target?.children.length) invalid(`nested content in ${names.at(-1)}`);
  return target ? tidy(target.text) : null;
}

function date(value) {
  let result = tidy(value);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(result)) result = `${result.slice(6)}-${result.slice(0, 2)}-${result.slice(3, 5)}`;
  return validDate(result) ? result : null;
}

export function holdingCompanySecurityType(holding = {}) {
  const description = `${tidy(holding.issuer)} ${tidy(holding.classTitle)}`.toUpperCase();
  if (/\b(?:ETF|ETFS|ISHARES|SPDR|POWERSHARES|PROSHARES|DIREXION|SELECT SECTOR|EXCHANGE TRADED FUND)\b/.test(description)
    || /\bVANGUARD\b.*\b(?:FUND|INDEX|TRUST|TR|ETF)\b/.test(description)) return 'fund';
  if (holding.quantityType === 'PRN') return 'principal';
  if (holding.putCall === 'PUT' || holding.putCall === 'CALL') return 'option';
  if (/\b(?:ADR|ADRS|ADS|ADSS|DEPOSITARY|DEPOSITORY|SPONSORED ADS|SPONSORED ADR)\b/.test(description)) return 'depositary_receipt';
  return 'equity';
}

/** Bound public inputs even when the caller has already selected a verified row. */
export function normalizeHoldingCompanyRequest(holding = {}, { period = '' } = {}) {
  const cusip = tidy(holding.cusip).toUpperCase();
  const issuer = tidy(holding.issuer), classTitle = tidy(holding.classTitle);
  if (!/^[A-Z0-9*@#]{9}$/.test(cusip) || /^0+$/.test(cusip)) throw Object.assign(new Error('Select a holding with a valid nine-character CUSIP.'), { status: 400, code: 'INVALID_HOLDING' });
  if (!issuer || issuer.length > 300 || !classTitle || classTitle.length > 300 || /[\u0000-\u001f\u007f<>]/.test(`${issuer}${classTitle}`)) throw Object.assign(new Error('Select a holding with a reported issuer and security class.'), { status: 400, code: 'INVALID_HOLDING' });
  if (period && (!validDate(period) || !/-(?:03-31|06-30|09-30|12-31)$/.test(period))) throw Object.assign(new Error('Select a valid holdings reporting quarter.'), { status: 400, code: 'INVALID_PERIOD' });
  if (!['SH', 'PRN'].includes(holding.quantityType) || ![null, undefined, '', 'PUT', 'CALL'].includes(holding.putCall)) throw Object.assign(new Error('The reported security units or option type are invalid.'), { status: 400, code: 'INVALID_HOLDING' });
  return { cusip, issuer, classTitle, quantityType: holding.quantityType, putCall: holding.putCall || null, period, securityType: holdingCompanySecurityType(holding) };
}

/** Only the cover's issuerInfo is authoritative. Reporting-person fields and
 * free-text references elsewhere in the filing are deliberately ignored. */
export function parseScheduleIssuer(xml, expected = {}) {
  const root = parseXml(xml);
  if (root.name !== 'edgarSubmission') invalid('not an EDGAR submission');
  const form = field(root, 'headerData', 'submissionType');
  if (!formPattern.test(form || '') || (expected.form && expected.form !== form)) invalid('unexpected ownership form');
  const cover = path(root, 'formData', 'coverPageHeader');
  const issuer = child(cover, 'issuerInfo');
  const is13D = form.startsWith('SCHEDULE 13D');
  const issuerCik = normalizeCik(field(issuer, is13D ? 'issuerCIK' : 'issuerCik'));
  const issuerName = field(issuer, 'issuerName');
  const classTitle = field(cover, 'securitiesClassTitle');
  const cusipsContainer = child(issuer, 'issuerCusips');
  // X01 initially used singular issuerCusip; X02 added the issuerCusips array.
  const oldCusip = field(issuer, is13D ? 'issuerCUSIP' : 'issuerCusip');
  if (cusipsContainer && oldCusip) invalid('conflicting CUSIP schema fields');
  const rows = cusipsContainer?.children || [];
  if (rows.length > 25 || rows.some(row => row.name !== 'issuerCusipNumber' || row.children.length)) invalid('invalid issuer CUSIP list');
  const cusips = [...new Set((oldCusip ? [oldCusip] : rows.map(row => tidy(row.text))).map(value => value.replace(/\s+/g, '').toUpperCase()))];
  const eventDate = date(field(cover, is13D ? 'dateOfEvent' : 'eventDateRequiresFilingThisStatement'));
  if (!issuerCik || !issuerName || issuerName.length > 1000 || !classTitle || classTitle.length > 2000 || !cusips.length || cusips.some(value => !/^[A-Z0-9*@#]{9}$/.test(value) || /^0+$/.test(value))) invalid('missing or invalid issuer identity');
  if (!eventDate || !validDate(expected.filingDate) || eventDate > expected.filingDate) invalid('invalid evidence dates');
  if (expected.ciks && (!Array.isArray(expected.ciks) || !expected.ciks.includes(issuerCik))) invalid('issuer CIK is absent from the SEC indexed filing');
  return { cik: issuerCik, name: issuerName, classTitle, cusips, form, filingDate: expected.filingDate, eventDate };
}

function issuerWords(value) {
  const words = tidy(value).normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
    // SEC covers use both "The Coca-Cola Company" and "Coca-Cola Co/The".
    // Only a boundary article is optional; distinctive name words stay intact.
    .replace(/^THE\s+/, '').replace(/[,/]\s*THE\s*$/, '')
    // A possessive apostrophe is often omitted from 13F issuer names (MOODYS).
    .replace(/([A-Z])['’‘`](?=[A-Z])/g, '$1')
    .replace(/&/g, ' AND ')
    .replace(/\b(?:INCORPORATED|INC|CORPORATION|CORP|LIMITED|LTD|PLC|COMPANY|CO|N V|N\.V\.|S A|S\.A\.)\b/g, ' ').match(/[A-Z0-9]+/g) || [];
  // PETE is the reported petroleum abbreviation, not a spelling prefix.
  // Never expand it in the distinctive first-word position.
  return words.map((word, index) => index > 0 && word === 'PETE' ? 'PETROLEUM' : word);
}
function issuerNamesAgree(reported, evidence) {
  const left = issuerWords(reported), right = issuerWords(evidence);
  if (!left.length || !right.length) return false;
  // Abbreviations are a corroboration check only; an exact CUSIP/CIK cover
  // relationship is still mandatory. Distinctive first words must match.
  if (left[0] !== right[0]) return false;
  return left.every(word => right.some(other => word === other || (Math.min(word.length, other.length) >= 3 && (word.startsWith(other) || other.startsWith(word)))))
    && right.every(word => left.some(other => word === other || (Math.min(word.length, other.length) >= 3 && (word.startsWith(other) || other.startsWith(word)))));
}
function classLetters(value) {
  return [...String(value).matchAll(/\b(?:CL|CLASS)\s*[-.]?\s*([A-Z])\b/gi)].map(match => match[1].toUpperCase());
}
function classesAgree(reported, source) {
  const left = classLetters(reported), right = classLetters(source);
  // A single ownership cover can name several share classes/CUSIPs. It still
  // proves the issuer; it does not prove which ticker belongs to each class.
  if (left.length && right.length && !left.some(letter => right.includes(letter))) return false;
  const preferred = value => /\b(?:PFD|PREF|PREFERRED|PREFERENCE)\b/i.test(value);
  const ordinary = value => /\b(?:COM|COMMON|ORD|ORDINARY)\b/i.test(value);
  return !(preferred(reported) && ordinary(source)) && !(ordinary(reported) && preferred(source));
}

/** Resolve the issuer, not a class-specific trading symbol. All supplied proof
 * is checked for CUSIP conflicts before matching the reported issuer name. */
export function resolveHoldingCompanyEvidence(holding, evidence = [], { period = '', now = Date.now(), maxEvidenceAgeDays = 1096 } = {}) {
  const request = normalizeHoldingCompanyRequest(holding, { period });
  const result = { status: 'unresolved', cusip: request.cusip, securityType: request.securityType, issuer: null, evidence: [], reason: '', code: '' };
  const unresolved = (code, reason) => ({ ...result, code, reason });
  if (request.securityType === 'fund') return unresolved('FUND_SECURITY', 'This is a fund security. Its portfolio should be researched as a fund; company financial statements would describe a different entity.');
  if (request.securityType === 'principal') return unresolved('PRINCIPAL_SECURITY', 'This position reports principal amount. A security-specific issuer link has not been established for company research.');
  const today = new Date(now).toISOString().slice(0, 10);
  const exact = evidence.filter(item => item && Array.isArray(item.cusips) && item.cusips.includes(request.cusip));
  if (!exact.length) return unresolved('NO_VERIFIED_IDENTITY', 'No structured SEC ownership filing checked links this exact CUSIP to a company issuer. Names alone are not used to assign company financials.');
  if (exact.some(item => !normalizeCik(item.cik) || !validDate(item.filingDate) || !validDate(item.eventDate) || item.eventDate > item.filingDate || item.filingDate > today)) return unresolved('INVALID_EVIDENCE', 'The SEC identity evidence could not be validated. Retry this holding or inspect the original filing.');
  if (new Set(exact.map(item => item.cik)).size !== 1) return unresolved('AMBIGUOUS_IDENTITY', 'SEC source documents associate this CUSIP with different issuer CIKs. Automatic company matching is withheld.');
  const fresh = exact.filter(item => (now - Date.parse(item.filingDate)) / 86400000 <= maxEvidenceAgeDays
    && (!period || Math.abs(Date.parse(period) - Date.parse(item.eventDate)) / 86400000 <= maxEvidenceAgeDays));
  if (!fresh.length) return unresolved('STALE_IDENTITY', 'Available identifier evidence is more than three years from the selected holdings quarter or current date. A current issuer link is not assumed.');
  if (fresh.some(item => !issuerNamesAgree(request.issuer, item.name))) return unresolved('ISSUER_NAME_CONFLICT', 'The exact-CUSIP evidence names a different issuer from the selected holding. A corporate change or identifier conflict needs review.');
  if (fresh.some(item => !classesAgree(request.classTitle, item.classTitle))) return unresolved('SECURITY_CLASS_CONFLICT', 'The SEC identifier evidence and selected holding report different security classes. Automatic matching is withheld.');
  const sorted = [...fresh].sort((a, b) => b.filingDate.localeCompare(a.filingDate));
  return { ...result, status: 'resolved', issuer: { cik: sorted[0].cik, name: sorted[0].name }, evidence: sorted,
    reason: request.securityType === 'option' ? 'The exact CUSIP identifies the underlying company. Company financials describe that issuer, not the option’s value or payoff.'
      : request.securityType === 'depositary_receipt' ? 'The exact CUSIP identifies the company behind this depositary receipt. Company reporting currency and receipt terms may differ.'
        : 'The exact CUSIP is linked to this issuer CIK in the SEC ownership filing cover. Company research uses that CIK.' };
}
