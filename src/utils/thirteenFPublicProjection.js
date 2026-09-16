import { validFilingDate } from './filingsResearch.js';

const text = (value, limit = 240) => typeof value === 'string' ? value.slice(0, limit) : '';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/** Called only after the complete portfolio has reconciled, never on a holdings page. */
export function project13FPublicSummary(data) {
  const portfolio = data.portfolio;
  // Sorting the original rows avoids constructing a public object for every holding.
  const topHoldings = [...portfolio.holdings].sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 10).map(holding => ({
    name: text(`${holding.issuer} · ${holding.classTitle}`), identifier: holding.cusip,
    valueUsd: holding.valueUsd, weightPct: holding.weightPct, putCall: holding.putCall, quantityType: holding.quantityType,
  }));
  return {
    name: text(data.manager.name), reportDate: portfolio.period,
    filingDate: portfolio.filings.map(filing => filing.filingDate).sort().at(-1), retrievedAt: data.observedAt,
    positionCount: portfolio.positionCount, totalValueUsd: portfolio.totalValueUsd, top10WeightPct: data.summary.top10Pct,
    weightBasis: 'Percentage of all reported 13F holdings value; not manager assets under management or net assets.',
    confidentialOmitted: portfolio.confidentialOmitted, comparable: portfolio.comparable, topHoldings,
    sources: portfolio.filings.flatMap(filing => [
      { label: `${filing.form} · ${filing.filingDate}${filing.superseded ? ' · superseded' : ''}`, url: filing.indexUrl },
      { label: `Original cover · ${filing.accession}`, url: filing.primaryUrl },
    ]),
    limitations: ['Quarter-end public reportable holdings. Reported value is not assets under management, net assets, cash flow or performance.',
      'The full portfolio determines weights. Options remain distinct from ordinary shares; their reported underlying value is not option premium.',
      portfolio.confidentialOmitted ? 'This report explicitly omits confidential holdings; coverage and comparisons are limited.'
        : 'Cash, short positions, non-reportable securities and any non-public holdings are outside this summary.',
      ...(data.coverage.note ? [text(data.coverage.note, 800)] : [])],
  };
}

/** Defense in depth for a digest-bound projection in the trusted prepared cache. */
export function valid13FPublicSummary(value, cik, period, checkedAt) {
  try {
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 240
      || value.reportDate !== period || !validFilingDate(value.filingDate) || value.filingDate < period
      || !iso(value.retrievedAt) || Date.parse(value.retrievedAt) > Date.parse(checkedAt)
      || !integer(value.positionCount) || value.positionCount > 20000 || !integer(value.totalValueUsd)
      || typeof value.confidentialOmitted !== 'boolean' || typeof value.comparable !== 'boolean'
      || value.confidentialOmitted && value.comparable
      || !Array.isArray(value.topHoldings) || value.topHoldings.length !== Math.min(10, value.positionCount)
      || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 32
      || !Array.isArray(value.limitations) || value.limitations.length < 3 || value.limitations.length > 4
      || value.limitations.some(item => typeof item !== 'string' || item.length > 800)
      || value.weightBasis !== 'Percentage of all reported 13F holdings value; not manager assets under management or net assets.') return false;
    const keys = new Set();
    for (const [index, row] of value.topHoldings.entries()) {
      const key = `${row.identifier}|${row.putCall}|${row.quantityType}`;
      if (!/^[A-Z0-9*@#]{9}$/.test(row.identifier) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 240
        || !integer(row.valueUsd) || ![null, 'PUT', 'CALL'].includes(row.putCall) || !['SH', 'PRN'].includes(row.quantityType)
        || row.weightPct !== (value.totalValueUsd > 0 ? row.valueUsd / value.totalValueUsd * 100 : null)
        || index && row.valueUsd > value.topHoldings[index - 1].valueUsd || keys.has(key)) return false;
      keys.add(key);
    }
    const topValue = value.topHoldings.reduce((sum, row) => sum + row.valueUsd, 0);
    if (!integer(topValue) || topValue > value.totalValueUsd || value.positionCount <= 10 && topValue !== value.totalValueUsd
      || value.top10WeightPct !== (value.totalValueUsd > 0 ? topValue / value.totalValueUsd * 100 : null)) return false;
    const archiveRoot = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/`;
    return value.sources.every(source => typeof source.label === 'string' && source.label.length <= 240
      && typeof source.url === 'string' && source.url.startsWith(archiveRoot)
      && /^\d{18}\/[\w][\w.-]{0,259}\.(?:xml|html)$/i.test(source.url.slice(archiveRoot.length))
      && !source.url.slice(archiveRoot.length).includes('..'));
  } catch { return false; }
}
