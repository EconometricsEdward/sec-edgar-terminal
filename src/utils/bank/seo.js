const RSSD = /^[1-9]\d{0,9}$/;

export function bankPageSeo(rssd, state, error = false) {
  const bank = state?.banks?.find(b => String(b.id_rssd) === String(rssd));
  const name = bank?.legal_name || `RSSD ${rssd}`;
  const location = [bank?.city, bank?.state].filter(Boolean).join(', ');
  return {
    title: `${name} — BankScope FFIEC Analysis`,
    description: `${name}${location ? ` (${location})` : ''}, RSSD ${rssd}. Explore FFIEC Call Report financials, loan and funding exposures, securities, peer comparisons, quarterly trends and bank-to-parent research links.`,
    path: `/analysis/banks/${rssd}`,
    index: !error && !!bank && !!state?.reports?.some(r => String(r.id_rssd) === String(rssd) && r.validation?.passed),
  };
}

// The directory's ready-to-explore selection contains validated, prepared banks.
// Keep unprepared entities and filter combinations out of this discovery sitemap.
export function bankSitemapXml(directory, siteUrl) {
  const ids = [...new Set((directory?.banks || [])
    .filter(b => RSSD.test(String(b.id_rssd)) && Number(b.prepared_quarters) > 0)
    .map(b => String(b.id_rssd)))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${ids.map(id => `\n  <url><loc>${siteUrl}/analysis/banks/${id}</loc><changefreq>weekly</changefreq></url>`).join('')}\n</urlset>`;
}
