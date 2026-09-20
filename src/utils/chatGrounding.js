const DATA_TOOLS = new Set(['company_financials', 'fund_portfolio', 'market_summary', 'cftc_positioning', 'disclosure_passages',
  'sector_companies', 'cftc_history', 'company_comparison', 'company_risk', 'company_exposures', 'fund_holdings', 'fund_changes', 'fund_overlap', 'filings_list', 'filing_document', 'shared_context']);
const PAGE_HELP = new Set([
  'explain this page', 'explain what this page shows', 'what does this page show',
  'how do i use this page', 'what can i do on this page', 'how do i use edgar terminal',
  'what is edgar terminal', 'how do i research a fund on edgar terminal',
  'how do i download a report', 'how do i change reading preferences',
  'hi', 'hello', 'thanks', 'thank you', 'what can you help me with',
]);
const DEFINITIONS = '(?:free cash flow|operating cash flow|revenue|net income|gross margin|operating margin|net margin|current ratio|debt[- ]to[- ]equity ratio|return on equity|return on assets|ttm|year[- ]to[- ]date|form 13f|13f|form n[- ]port|n[- ]port|a cik|cik|cftc positioning)';
const DEFINITION = new RegExp(`^(?:what is ${DEFINITIONS}|define ${DEFINITIONS}|what does ${DEFINITIONS} mean)$`);

/** Fail toward fresh research. The exceptions are whole, single-intent generic
 * questions, not a financial-keyword classifier that misses follow-ups. */
export function chatRequiresResearch(messages = []) {
  const content = messages.findLast(message => message?.role === 'user')?.content;
  if (typeof content !== 'string') return true;
  const question = content.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.?!]$/, '');
  return !PAGE_HELP.has(question) && !DEFINITION.test(question);
}

function citedSourceIds(value, ids = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return ids;
  if (Array.isArray(value)) {
    for (const child of value) citedSourceIds(child, ids, depth + 1);
  } else {
    if (Array.isArray(value.sourceIds)) {
      for (const id of value.sourceIds.flat(2)) if (typeof id === 'string') ids.add(id);
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'sourceIds') citedSourceIds(child, ids, depth + 1);
  }
  return ids;
}

/** Ephemeral state for one response. Only successful substantive tool results
 * can unlock model prose; earlier assistant messages and entity search cannot. */
export function createChatGrounding(messages, { sharedContext = null } = {}) {
  const requiresResearch = chatRequiresResearch(messages);
  let evidence = false, attempts = 0, identityOnly = false, outcome = '', lastTool = '', choices = [], unavailableBasis = '', suggestedBasis = '';
  return {
    requiresResearch,
    hasEvidence: () => evidence,
    shouldStopResearch: () => attempts > 0 && !identityOnly && !evidence,
    observe(name, result, sources = []) {
      attempts++;
      lastTool = name;
      outcome = ['ready', 'unavailable', 'not_found', 'needs_selection'].includes(result?.status) ? result.status : 'unavailable';
      identityOnly = name === 'search_entities' && outcome === 'ready';
      unavailableBasis = result?.code === 'SOURCE_BASIS_UNAVAILABLE' && ['annual', 'quarter', 'ttm'].includes(result.requestedBasis) ? result.requestedBasis : '';
      suggestedBasis = unavailableBasis && ['annual', 'quarter', 'ttm'].includes(result.suggestedBasis) ? result.suggestedBasis : '';
      choices = outcome === 'needs_selection' && Array.isArray(result.choices)
        ? result.choices.map(choice => choice?.id).filter(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,35}$/.test(id)).slice(0, 6) : [];
      if (!DATA_TOOLS.has(name) || outcome !== 'ready') return;
      // A deliberately shared portfolio is usable only as user-provided input,
      // never as a verified public financial source. No fabricated citation is
      // created to unlock an explanation of these weights.
      if (name === 'shared_context' && sharedContext?.kind === 'portfolio' && result.evidenceType === 'user-provided') {
        evidence = true;
        return;
      }
      const registered = new Set(sources.filter(source => typeof source?.id === 'string' && typeof source?.url === 'string').map(source => source.id));
      if ([...citedSourceIds(result)].some(id => registered.has(id))) evidence = true;
    },
    limitation() {
      if (unavailableBasis) return `Verified financial data is unavailable on the requested ${unavailableBasis === 'quarter' ? 'quarterly' : unavailableBasis.toUpperCase() === 'TTM' ? 'TTM' : 'annual'} basis. This does not establish that no SEC filing exists.${suggestedBasis ? ` You can ask to try ${suggestedBasis === 'quarter' ? 'quarterly' : suggestedBasis} data; availability of that basis has not been checked.` : ''} You can also inspect the original filings.`;
      if (outcome === 'needs_selection' && lastTool === 'cftc_history') return `Please choose the CFTC contract code and trader group you want to examine.${choices.length ? ` Matching contract codes: ${choices.join(', ')}.` : ''}`;
      if (outcome === 'needs_selection' && lastTool === 'sector_companies') return 'Please select a sector on the Market page or name the sector you want to examine.';
      if (outcome === 'needs_selection') return `Please specify the exact company ticker, fund identifier, or manager CIK before I summarize financial data.${choices.length ? ` Matching identifiers: ${choices.join(', ')}.` : ''}`;
      if (outcome === 'not_found') return 'I could not match this request to a verified SEC entity. Please provide the company ticker, SEC CIK, or N-PORT fund identifier.';
      if (lastTool === 'disclosure_passages' && outcome === 'ready') return 'The retained filing index returned no source-backed passages for this question. That does not establish that the company lacks the risk or exposure. Try a different filing term or open Disclosures.';
      return 'I could not retrieve verified source data for this answer. I will not fill the gap with figures from an earlier response. Please try again with a company ticker, fund identifier, or a more specific research question.';
    },
  };
}

export function omitUnverifiedAssistantHistory(messages) {
  return messages.map(message => message.role === 'assistant'
    ? { role: 'assistant', content: '[Earlier assistant answer omitted. It is not evidence; retrieve current source data for this question.]' }
    : message);
}
