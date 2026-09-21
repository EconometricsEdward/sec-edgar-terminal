import { normalizeBrokerDealerForm } from './brokerDealerForms.js';

// Search intent only: these aliases do not classify a filing or establish its
// public availability, reporting frequency, audit status or statement coverage.
export const BROKER_DEALER_SEARCH_PATTERN = /\b(?:broker[ -]?dealer\s+(?:(?:annual(?:\s+audited)?|audited|periodic)\s+)?(?:filings?|reports?)|periodic\s+FOCUS(?:\s+reports?)?|FOCUS\s+(?:reports?|part\s+(?:IIA|III|II)|schedule\s+I)|part\s+(?:IIA|III|II)\s+(?:FOCUS|annual)(?:\s+reports?)?)\b/i;

export function brokerDealerSearchForm(value) {
  const form = normalizeBrokerDealerForm(value);
  if (form) return form;
  const input = typeof value === 'string' && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';
  const match = input.match(BROKER_DEALER_SEARCH_PATTERN);
  return input && (/^(?:FOCUS|Schedule I|Part III|Part II|Part IIA)$/i.test(input) || match?.[0].length === input.length) ? 'X-17A-5' : '';
}
