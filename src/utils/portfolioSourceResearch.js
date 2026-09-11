import { canonicalPortfolioCik } from "./portfolioModel.js";
export function portfolioSourceIssuers(rows) {
  const issuers = new Map();
  for (const row of rows || []) {
    const r = row.resolution;
    if (
      row.excluded ||
      row.mergedInto ||
      row.duplicateChoice === "remove" ||
      r?.status !== "resolved" ||
      r.kind === "fund"
    )
      continue;
    const cik = canonicalPortfolioCik(r.cik);
    if (cik && !issuers.has(cik))
      issuers.set(cik, {
        cik,
        ticker: r.ticker || "",
        name: r.name || r.ticker || cik,
        rowId: row.id,
      });
  }
  return [...issuers.values()];
}
export function mergePortfolioFilingRows(previous, incoming) {
  return [
    ...new Map(
      [...previous, ...incoming].map((f) => [
        `${canonicalPortfolioCik(f.cik)}:${f.accession}`,
        {...f,documentUrl:f.documentUrl||f.indexUrl||null},
      ]),
    ).values(),
  ].sort((a, b) => (b.filingDate || "").localeCompare(a.filingDate || ""));
}
export async function portfolioSourceJson(
  path,
  signal,
  fetcher = globalThis.fetch,
) {
  const response = await fetcher(path, { signal });
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const retryAfter = retry
      ? /^\d+$/.test(retry)
        ? Number(retry)
        : Math.max(1, Math.ceil((Date.parse(retry) - Date.now()) / 1000))
      : 60;
    const body = await response.json().catch(() => ({}));
    throw Object.assign(
      new Error(
        body.error || `Research request returned HTTP ${response.status}.`,
      ),
      {
        status: response.status,
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : 60,
      },
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const decoder = new TextDecoder();
  let text = "",
    bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 12 * 1024 * 1024) {
        await reader.cancel();
        throw new Error(
          "This response exceeds the portfolio viewer's 12 MiB limit. Open the issuer's dedicated research page for this archive.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}
export function researchPause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
