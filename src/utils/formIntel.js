// ============================================================================
// formIntel — plain-English context for SEC form types
//
// Complements formItems.js (which decodes 8-K item codes). This module answers
// two different questions for any filing row:
//   1. "What IS this form?"        → describeForm(form)  → { label, desc, tier }
//   2. "Should I look closer?"     → deriveSignals(form, itemCodes) → flags
//
// Tiers: 'routine' (background noise), 'notable' (worth a glance),
//        'alert' (read this one). Tier is about the FORM CLASS; per-filing
//        signals (late notices, non-reliance, bankruptcy items) escalate it.
// ============================================================================

const FORM_INTEL = {
  '10-K':    { label: 'Annual report',         tier: 'notable', desc: 'The full audited yearly picture: business, risk factors, MD&A, financial statements.' },
  '10-Q':    { label: 'Quarterly report',      tier: 'notable', desc: 'Unaudited quarterly financials and management discussion.' },
  '8-K':     { label: 'Current report',        tier: 'notable', desc: 'Something just happened — see the item codes for what.' },
  '20-F':    { label: 'Foreign annual report', tier: 'notable', desc: 'Annual report for foreign private issuers (the 10-K equivalent).' },
  '6-K':     { label: 'Foreign interim report',tier: 'routine', desc: 'Interim disclosure from a foreign issuer.' },
  'DEF 14A': { label: 'Proxy statement',       tier: 'notable', desc: 'Shareholder meeting agenda: board, executive pay, votes.' },
  'PRE 14A': { label: 'Preliminary proxy',     tier: 'routine', desc: 'Draft proxy statement, subject to change.' },
  'S-1':     { label: 'IPO registration',      tier: 'alert',   desc: 'Registration of new securities — IPOs and first-time offerings.' },
  'S-3':     { label: 'Shelf registration',    tier: 'notable', desc: 'Pre-cleared shelf to sell securities later — possible dilution ahead.' },
  'S-8':     { label: 'Employee stock plan',   tier: 'routine', desc: 'Registers shares for employee compensation plans.' },
  '424B2':   { label: 'Prospectus supplement', tier: 'routine', desc: 'Pricing/terms supplement for a registered offering.' },
  '424B3':   { label: 'Prospectus supplement', tier: 'routine', desc: 'Updated prospectus for a registered offering.' },
  '424B5':   { label: 'Prospectus supplement', tier: 'notable', desc: 'Terms of a shelf takedown — securities are being sold now.' },
  '3':       { label: 'Insider — initial',     tier: 'routine', desc: 'New insider declares initial ownership.' },
  '4':       { label: 'Insider trade',         tier: 'notable', desc: 'An officer, director, or 10% owner bought or sold.' },
  '5':       { label: 'Insider — annual',      tier: 'routine', desc: 'Annual statement of insider ownership changes.' },
  'SC 13D':  { label: 'Activist stake',        tier: 'alert',   desc: '>5% owner with intent to influence — the activist filing.' },
  'SC 13G':  { label: 'Passive stake',         tier: 'notable', desc: '>5% owner, passive intent (often index funds).' },
  '13F-HR':  { label: 'Fund holdings',         tier: 'routine', desc: 'Quarterly portfolio snapshot from an institutional manager.' },
  'SD':      { label: 'Specialized disclosure',tier: 'routine', desc: 'Conflict minerals and similar specialized disclosures.' },
  '11-K':    { label: 'Employee plan annual',  tier: 'routine', desc: 'Annual report of an employee stock purchase/savings plan.' },
  'ARS':     { label: 'Annual report to holders', tier: 'routine', desc: 'Glossy annual report sent to shareholders.' },
  '25':      { label: 'Delisting notice',      tier: 'alert',   desc: 'Notification of removal from listing/registration.' },
  '15':      { label: 'Deregistration',        tier: 'alert',   desc: 'Company suspending its SEC reporting obligations.' },
};

const BASE_OF = (form) => String(form || '').replace(/\/A$/i, '').replace(/^NT\s+/i, '').trim();

/**
 * Describe a form in plain English. Handles amendments (/A) and late-filing
 * notices (NT ...) as modifiers on the base form.
 * Always returns { label, desc, tier } — unknown forms get a generic shell.
 */
export function describeForm(form) {
  const raw = String(form || '').trim();
  const base = BASE_OF(raw);
  const intel = FORM_INTEL[base] || { label: base || 'Filing', tier: 'routine', desc: 'SEC filing — open the source document for details.' };

  if (/^NT\s+/i.test(raw)) {
    return {
      label: `Late ${intel.label.toLowerCase()}`,
      desc: `The company could not file its ${base} on time. Late filings are worth understanding.`,
      tier: 'alert',
    };
  }
  if (/\/A$/i.test(raw)) {
    return {
      label: `${intel.label} (amended)`,
      desc: `Amends a previously filed ${base}. Check what changed — amendments to financial reports can matter.`,
      tier: intel.tier === 'routine' ? 'notable' : intel.tier,
    };
  }
  return intel;
}

// Item codes that should escalate an 8-K visually, with the reason.
const ALERT_ITEMS = {
  '1.03': 'Bankruptcy or receivership',
  '1.05': 'Cybersecurity incident',
  '2.04': 'Debt obligation accelerated',
  '2.06': 'Material impairment',
  '3.01': 'Listing/delisting notice',
  '4.01': 'Auditor changed',
  '4.02': 'Past financials can no longer be relied on',
  '5.01': 'Change of control',
};
const NOTABLE_ITEMS = {
  '1.01': 'Material agreement signed',
  '1.02': 'Material agreement terminated',
  '2.01': 'Acquisition or disposition completed',
  '2.05': 'Restructuring / exit costs',
  '5.02': 'Executive or director change',
};

/**
 * Per-filing signals: array of { key, label, severity: 'alert'|'notable' }.
 * Derived from the form string and (for 8-Ks) decoded item codes.
 */
export function deriveSignals(form, itemCodes = []) {
  const signals = [];
  const raw = String(form || '').trim();

  if (/^NT\s+/i.test(raw)) {
    signals.push({ key: 'late', label: 'Late filing notice', severity: 'alert' });
  }
  if (/^(10-K|10-Q|20-F)\/A$/i.test(raw)) {
    signals.push({ key: 'amended-financials', label: 'Amended financial report', severity: 'notable' });
  }
  for (const code of itemCodes) {
    if (ALERT_ITEMS[code]) signals.push({ key: `item-${code}`, label: ALERT_ITEMS[code], severity: 'alert' });
    else if (NOTABLE_ITEMS[code]) signals.push({ key: `item-${code}`, label: NOTABLE_ITEMS[code], severity: 'notable' });
  }
  // De-dupe by key, alerts first
  const seen = new Set();
  return signals
    .filter((s) => (seen.has(s.key) ? false : seen.add(s.key)))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'alert' ? -1 : 1));
}

/** Effective tier for a filing row once signals are considered. */
export function effectiveTier(form, itemCodes = []) {
  const signals = deriveSignals(form, itemCodes);
  if (signals.some((s) => s.severity === 'alert')) return 'alert';
  const base = describeForm(form).tier;
  if (signals.length > 0 && base === 'routine') return 'notable';
  return base;
}
