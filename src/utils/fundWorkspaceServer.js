import { loadFund } from "./fundResearchServer.js";

export function fundWorkspaceMetadata(fund) {
  const { holdings: _holdings, ...metadata } = fund;
  const reports = [...(fund.reports || [])];
  if (
    fund.accession &&
    !reports.some((report) => report.accession === fund.accession)
  )
    reports.unshift({
      accession: fund.accession,
      reportDate: fund.asOf,
      filingDate: fund.filingDate,
      form: fund.form,
    });
  return { ...metadata, reports, complete: true };
}
export async function loadWorkspaceFunds(
  tickers,
  reports = {},
  { loader = loadFund, timeoutMs = 50000 } = {},
) {
  const data = new Array(tickers.length),
    failures = new Array(tickers.length);
  let next = 0;
  const worker = async () => {
    while (next < tickers.length) {
      const i = next++,
        ticker = tickers[i];
      let timer;
      try {
        const fund = await Promise.race([
          loader(ticker, reports[ticker] || ""),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error("Portfolio request timed out. Retry this fund."),
                ),
              timeoutMs,
            );
          }),
        ]);
        if (fund.status !== "ready")
          throw new Error(
            fund.reason || "Public portfolio coverage unavailable.",
          );
        data[i] = { ...fund, complete: true };
      } catch (error) {
        failures[i] = {
          ticker,
          message:
            error instanceof Error
              ? error.message
              : "Portfolio request failed.",
        };
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(2, tickers.length) }, worker),
  );
  return { portfolios: data.filter(Boolean), errors: failures.filter(Boolean) };
}
