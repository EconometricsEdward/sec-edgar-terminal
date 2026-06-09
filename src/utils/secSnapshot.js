const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT ||
  'EDGAR Terminal snapshot API (https://secedgarterminal.com; public SEC data)';

export function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) return '';
  return ticker;
}

async function secJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': SEC_USER_AGENT,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`SEC returned ${response.status} for ${url}`);
  return response.json();
}

function filingUrl(cik, accessionNumber, primaryDocument) {
  const cikInt = String(Number(cik));
  const accessionCompact = String(accessionNumber || '').replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accessionCompact}/${primaryDocument}`;
}

export async function buildSnapshot(ticker) {
  const tickerMap = await secJson('https://www.sec.gov/files/company_tickers.json');
  const entry = Object.values(tickerMap).find((row) => row.ticker?.toUpperCase() === ticker);
  if (!entry) {
    return {
      ticker,
      found: false,
      message: 'Ticker was not found in the SEC company_tickers.json file.',
    };
  }

  const cik = String(entry.cik_str).padStart(10, '0');
  const submissions = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const recent = submissions.filings?.recent || {};
  const rows = [];
  const forms = recent.form || [];

  for (let index = 0; index < forms.length && rows.length < 20; index += 1) {
    const form = forms[index];
    if (!['10-K', '10-Q', '8-K', 'DEF 14A', '10-K/A', '10-Q/A'].includes(form)) continue;
    rows.push({
      form,
      filingDate: recent.filingDate?.[index] || '',
      reportDate: recent.reportDate?.[index] || '',
      accessionNumber: recent.accessionNumber?.[index] || '',
      primaryDocument: recent.primaryDocument?.[index] || '',
      sourceUrl: filingUrl(cik, recent.accessionNumber?.[index], recent.primaryDocument?.[index]),
    });
  }

  return {
    ticker,
    found: true,
    cik,
    companyName: submissions.name || entry.title,
    sic: submissions.sic || null,
    sicDescription: submissions.sicDescription || null,
    fiscalYearEnd: submissions.fiscalYearEnd || null,
    entityType: submissions.entityType || null,
    latestFilings: rows,
    source: {
      tickerMap: 'https://www.sec.gov/files/company_tickers.json',
      submissions: `https://data.sec.gov/submissions/CIK${cik}.json`,
    },
  };
}
