/** The SEC form code is shared by annual reports and periodic FOCUS reports.
 * Classify a particular document from its contents, never from this code alone. */
export const BROKER_DEALER_FORM = 'X-17A-5';
export const BROKER_DEALER_FORM_DESCRIPTION = 'Broker-dealer report';

export function normalizeBrokerDealerForm(value) {
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) return '';
  const input = value.trim().toUpperCase().replace(/^FORM\s+/, '').replace(/[‐‑‒–—−]/g, '-');
  const compact = input.replace(/[\s-]/g, '');
  if (/^X17A5(?:\/A)?$/.test(compact)) return compact.endsWith('/A') ? 'X-17A-5/A' : BROKER_DEALER_FORM;
  // Retain existing search aliases without assigning annual status to a result.
  if (/^BROKER[ -]?DEALER (?:ANNUAL )?REPORTS?$/.test(input)) return BROKER_DEALER_FORM;
  return '';
}

export function isBrokerDealerForm(value) {
  return Boolean(normalizeBrokerDealerForm(value));
}

export function brokerDealerFormDescription(value) {
  const form = normalizeBrokerDealerForm(value);
  return form ? `${BROKER_DEALER_FORM_DESCRIPTION}${form.endsWith('/A') ? ' amendment' : ''}` : '';
}
