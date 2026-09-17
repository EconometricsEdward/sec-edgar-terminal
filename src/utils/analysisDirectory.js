import directory from '../data/analysis-directory-samples.json' with { type: 'json' };

const SECTORS = ['Information Technology', 'Financials', 'Health Care', 'Consumer Discretionary',
  'Communication', 'Industrials', 'Consumer Staples', 'Energy', 'Utilities', 'Real Estate', 'Materials'];

// Discovery is deliberately bounded. Search uses the full SEC directory separately.
export function buildAnalysisDirectory(companies = []) {
  const annotations = new Map(directory.samples.map((sample, index) => [sample.cik, { ...sample, index }]));
  const grouped = new Map();
  const seen = new Set();
  for (const company of companies) {
    if (!company.cik || !company.ticker || seen.has(company.cik)) continue;
    seen.add(company.cik);
    const sector = String(company.sector || 'Other');
    if (!grouped.has(sector)) grouped.set(sector, []);
    grouped.get(sector).push(company);
  }
  const rank = sector => SECTORS.includes(sector) ? SECTORS.indexOf(sector) : SECTORS.length;
  return [...grouped].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([sector, members]) => ({
    sector,
    companies: members.sort((a, b) => (annotations.get(a.cik)?.index ?? 999) - (annotations.get(b.cik)?.index ?? 999)
      || a.name.localeCompare(b.name)).slice(0, 3).map(company => {
      const annotation = annotations.get(company.cik);
      return { ticker: company.ticker, cik: company.cik, name: company.name,
        industry: annotation?.industry || '', sic: annotation?.sic || '' };
    }),
  }));
}
