// Filing dates determine the rolling one-year window. Portfolio dates remain source context.
export function recentFundFilings(fund, now = Date.now()) {
  const end = new Date(now), start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const from = start.toISOString().slice(0, 10), to = end.toISOString().slice(0, 10);
  const seen = new Set();
  return (fund?.reports || []).filter(report => {
    if (!/^NPORT-P(?:\/A)?$/.test(report.form || '') || !/^\d{4}-\d{2}-\d{2}$/.test(report.filingDate || '')
      || report.filingDate < from || report.filingDate > to || seen.has(report.accession)) return false;
    seen.add(report.accession); return true;
  }).sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accession.localeCompare(a.accession));
}
