/** Pure discovery metadata; never reads storage or starts research preparation. */
export function serializeResearchJsonLd(value) {
  // Filing-derived names must not be able to close the inline script element.
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function secSource(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.sec.gov', 'sec.gov', 'data.sec.gov'].includes(url.hostname)
      && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

export function publicPortfolioStructuredData(summary, { pageUrl, jsonUrl, siteUrl }) {
  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'EDGAR Terminal', item: `${siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'Funds & institutional managers', item: `${siteUrl}/fund` },
      { '@type': 'ListItem', position: 3, name: summary.name, item: pageUrl },
    ],
  };
  if (summary.status !== 'ready') return { '@context': 'https://schema.org', '@graph': [breadcrumb] };

  const nport = summary.kind === 'nport';
  const validDate = typeof summary.reportDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(summary.reportDate)
    && Number.isFinite(Date.parse(summary.reportDate));
  const reportLabel = validDate ? ` as of ${summary.reportDate}` : '';
  const scope = nport
    ? 'SEC N-PORT fund-series net assets, disclosed position count, concentration and up to ten largest reported positions. Holdings cover all share classes in the reported series.'
    : 'SEC Form 13F manager-level reportable holdings value, disclosed position count, concentration and up to ten largest reported positions. Reported value is not total assets under management or an individual fund net asset value.';
  const variables = [
    { name: summary.valueLabel, value: summary.totalValueUsd, unitText: 'USD' },
    { name: 'Disclosed positions', value: summary.positionCount, unitText: 'positions' },
    { name: nport ? 'Top 10 positive weights' : 'Top 10 weight', value: summary.top10WeightPct,
      unitText: nport ? 'percent of net assets' : 'percent of reconciled public 13F holdings value' },
  ].filter(item => typeof item.value === 'number' && Number.isFinite(item.value))
    .map(item => ({ '@type': 'PropertyValue', ...item }));
  const sources = (summary.sources || []).slice(0, 32).flatMap(source => {
    const url = secSource(source.url);
    return url ? [{ '@type': 'CreativeWork', name: source.label, url }] : [];
  });
  const dataset = {
    '@type': 'Dataset', '@id': `${pageUrl}#reported-portfolio`,
    name: `${summary.name} — ${nport ? 'N-PORT fund portfolio' : '13F reported holdings'}${reportLabel}`,
    description: [scope, ...(summary.stale ? ['The source check is due; a newer filing or amendment may be missing.'] : []),
      ...(summary.limitations || [])].join(' '),
    url: pageUrl,
    mainEntityOfPage: pageUrl,
    creator: { '@type': 'Organization', name: 'EDGAR Terminal', url: siteUrl },
    isAccessibleForFree: true,
    inLanguage: 'en-US',
    ...(validDate ? { temporalCoverage: summary.reportDate } : {}),
    ...(summary.schemaVersion ? { version: summary.schemaVersion } : {}),
    ...(variables.length ? { variableMeasured: variables } : {}),
    ...(sources.length ? { isBasedOn: sources } : {}),
    distribution: { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: jsonUrl },
  };
  return { '@context': 'https://schema.org', '@graph': [breadcrumb, dataset] };
}

export function fundDirectoryStructuredData({ funds, managers, siteUrl }) {
  const entries = [
    ...funds.map(fund => ({ name: `${fund.ticker} · ${fund.name}`, url: `${siteUrl}/fund/${fund.ticker}` })),
    ...managers.map(manager => ({ name: manager.name, url: `${siteUrl}/fund/manager/${manager.cik}` })),
  ];
  return {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    '@id': `${siteUrl}/fund#directory`, url: `${siteUrl}/fund`,
    name: 'Funds & Institutional Managers — N-PORT and 13F Research',
    description: 'Source-linked research briefs for SEC fund portfolios and institutional manager holdings. Availability depends on public reporting coverage and prepared research.',
    mainEntity: {
      '@type': 'ItemList', numberOfItems: entries.length,
      itemListElement: entries.map((entry, index) => ({ '@type': 'ListItem', position: index + 1, ...entry })),
    },
  };
}
