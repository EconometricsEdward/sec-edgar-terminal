import { getOperatingTicker } from './tickerMap.js';
import { buildFilingUrl } from './filingTextParser.js';
import { warmGet, warmSet } from './warmCache.js';
import { RESEARCH_FORMS } from './researchWorkspace.js';

export async function secResearchJson(path, signal) {
  if (!/^\/(submissions\/CIK[\d-]+\.json|api\/xbrl\/companyfacts\/CIK\d{10}\.json)$/.test(path)) throw new Error('Invalid SEC data path.');
  const cached = await warmGet('research-sec-v1', path);
  if (cached) return cached;
  const response = await fetch(`https://data.sec.gov${path}`, {
    headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com', Accept: 'application/json' },
    signal: signal || AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`SEC data request returned HTTP ${response.status}.`);
  const data = await response.json();
  await warmSet('research-sec-v1', path, data, 300);
  return data;
}

export function submissionRows(recent, cik) {
  return (recent?.accessionNumber || []).flatMap((accession, i) => {
    if (!RESEARCH_FORMS.test(recent.form[i])) return [];
    const primaryDoc = recent.primaryDocument?.[i];
    if (!primaryDoc) return [];
    return [{ accession, form: recent.form[i], filingDate: recent.filingDate[i], reportDate: recent.reportDate?.[i], primaryDoc, documentUrl: buildFilingUrl(cik, accession, primaryDoc) }];
  });
}

export async function loadResearchCompany(ticker, { history = false, since = '', signal } = {}) {
  const entry = await getOperatingTicker(ticker);
  if (!entry) throw new Error('No SEC operating company matched that ticker.');
  const cik = String(entry.cik).padStart(10, '0');
  const [submissions, data] = await Promise.all([
    secResearchJson(`/submissions/CIK${cik}.json`, signal),
    secResearchJson(`/api/xbrl/companyfacts/CIK${cik}.json`, signal),
  ]);
  if (!data?.facts) throw new Error('SEC company facts were unavailable.');
  let filings = submissionRows(submissions.filings?.recent, cik);
  let historyLimited = false;
  if (history) {
    const cutoff = since || new Date(Date.now() - 800 * 86400000).toISOString().slice(0, 10);
    const files = (submissions.filings?.files || []).filter((f) => f.filingTo >= cutoff);
    historyLimited = files.length > 8;
    for (const file of files.slice(0, 8)) {
      if (!/^CIK\d{10}-submissions-\d+\.json$/.test(file.name)) continue;
      try {
        const response = await fetch(`https://data.sec.gov/submissions/${file.name}`, { headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com' }, signal: signal || AbortSignal.timeout(8000) });
        if (!response.ok) { historyLimited = true; continue; }
        filings.push(...submissionRows(await response.json(), cik));
      } catch { historyLimited = true; }
    }
  }
  filings = [...new Map(filings.map((f) => [f.accession, f])).values()].sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession));
  return { ticker, cik, companyName: submissions.name || entry.name, sic: submissions.sic, facts: data.facts, filings, historyLimited };
}
