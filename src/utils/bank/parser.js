import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { BankDataError } from './errors.js';
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const valueOf = node => typeof node === 'object' ? node?.['#text'] : node;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: false });

export function decodeFacsimile(response) {
  let value = response?.FacsimileFile ?? response;
  if (Array.isArray(value) && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return Buffer.from(value).toString('utf8');
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024) throw new BankDataError('parsing_failure');
  if (value.trimStart().startsWith('<')) return value;
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(value)) return Buffer.from(value, 'base64').toString('utf8');
  throw new BankDataError('parsing_failure');
}

/** XBRL decimals describe accuracy, never a monetary multiplier. */
export function parseCallXbrl(xml, { rssd, reportDate }) {
  if (Buffer.byteLength(xml) > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new BankDataError('parsing_failure');
  let root; try { root = parser.parse(xml).xbrl; } catch { throw new BankDataError('parsing_failure'); }
  if (!root || typeof root !== 'object') throw new BankDataError('parsing_failure');
  const contexts = new Map(), units = new Map();
  for (const c of list(root.context)) {
    const id = c['@_id']; if (!id || contexts.has(id)) throw new BankDataError('parsing_failure');
    const identifier = String(valueOf(c.entity?.identifier) || '');
    const period = c.period || {};
    contexts.set(id, { rssd: identifier, scheme: c.entity?.identifier?.['@_scheme'] || null,
      start: valueOf(period.startDate) || null, end: valueOf(period.instant) || valueOf(period.endDate),
      instant: !!period.instant, dimensional: !!(c.entity?.segment || c.scenario) });
  }
  if (![...contexts.values()].some(c => Number(c.rssd) === rssd && c.end === reportDate)) throw new BankDataError('source_identity_period_mismatch');
  for (const u of list(root.unit)) units.set(u['@_id'], String(valueOf(u.measure) || ''));
  const facts = {};
  for (const [code, nodes] of Object.entries(root)) {
    if (!/^(RCFD|RCON|RCFN|RIAD|RCFA|RCFW|RCOA)[A-Z0-9]{4}$/.test(code)) continue;
    facts[code] = list(nodes).map(node => {
      const context = contexts.get(node['@_contextRef']);
      const raw = String(valueOf(node) ?? '').trim();
      const nil = ['true', '1'].includes(node['@_nil']);
      return { code, rawValue: nil ? null : raw, value: !nil && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : null,
        contextRef: node['@_contextRef'], context, unitRef: node['@_unitRef'] || null, unit: units.get(node['@_unitRef']) || null,
        decimals: node['@_decimals'] || null, nil };
    });
  }
  if (!Object.keys(facts).length) throw new BankDataError('parsing_failure');
  return { facts, rssd, reportDate, sha256: createHash('sha256').update(xml).digest('hex'),
    schemaReferences: list(root.schemaRef).map(s => s['@_href']).filter(Boolean), factCount: Object.values(facts).reduce((n, v) => n + v.length, 0) };
}

export function pickFact(parsed, code, period = 'instant') {
  const candidates = (parsed.facts[code] || []).filter(f => f.context && Number(f.context.rssd) === parsed.rssd && f.context.end === parsed.reportDate && !f.context.dimensional
    && (period === 'ytd' ? !f.context.instant && f.context.start === `${parsed.reportDate.slice(0, 4)}-01-01` : f.context.instant));
  if (!candidates.length) return { code, value: null, reason: 'item_not_reported_on_required_basis' };
  if (new Set(candidates.map(f => JSON.stringify([f.rawValue, f.unit]))).size > 1) return { code, value: null, reason: 'conflicting_source_facts' };
  const fact = candidates[0];
  if (fact.value === null) return { ...fact, reason: fact.nil ? 'reported_nil' : 'nonnumeric_source_value' };
  return fact;
}
