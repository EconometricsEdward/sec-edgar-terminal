import { loadCompanyCftcContext, isCompanyCftcCachedContext } from "./companyCftcServer.js";

export const PORTFOLIO_MARKET_CONNECTIONS_VERSION = "edgar.portfolio-market-connections.v1";
export const PORTFOLIO_MARKET_CONNECTIONS_BATCH = 12;
export const PORTFOLIO_MARKET_CONNECTIONS_CONCURRENCY = 3;
export const PORTFOLIO_MARKET_CONNECTIONS_DEADLINE_MS = 50_000;
export const PORTFOLIO_MARKET_CONNECTIONS_BODY_BYTES = 8 * 1024;

const PUBLIC_SOURCE_CODES = new Set([
  "CFTC_DISABLED", "COMPANY_NOT_FOUND", "COMPANY_CFTC_BUSY", "COMPANY_CFTC_TIMEOUT",
  "SEC_USER_AGENT_INVALID", "SEC_RATE_GATE_UNAVAILABLE", "SEC_RATE_GATE_SATURATED",
  "SEC_UPSTREAM_COOLDOWN", "SEC_UPSTREAM_UNAVAILABLE", "SEC_SOURCE_UNAVAILABLE",
  "SEC_SOURCE_INVALID", "SEC_FILING_TEXT_UNAVAILABLE", "SEC_CONTEXT_UNAVAILABLE",
]);

function invalid(message, status = 400) {
  throw Object.assign(new Error(message), { status, code: "INVALID_PORTFOLIO_CONNECTIONS_REQUEST" });
}

/** A batch contains public identifiers only. Share classes are resolved before submitting it. */
export function parsePortfolioMarketConnections(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => key !== "companies")) invalid("Provide only a companies list.");
  if (!Array.isArray(input.companies) || input.companies.length < 1 || input.companies.length > PORTFOLIO_MARKET_CONNECTIONS_BATCH)
    invalid("Provide between 1 and 12 companies in each batch.");
  const byCik = new Map(), byTicker = new Map();
  for (const item of input.companies) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(key => !["cik", "ticker"].includes(key))) invalid("Each company may contain only cik and ticker.");
    if (typeof item.cik !== "string" || !/^\d{10}$/.test(item.cik) || Number(item.cik) === 0)
      invalid("Each company requires a nonzero ten-digit CIK string.");
    if (typeof item.ticker !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,11}$/.test(item.ticker))
      invalid("Each company requires a valid ticker of up to 12 characters.");
    const ticker = item.ticker.toUpperCase();
    if ((byCik.has(item.cik) && byCik.get(item.cik).ticker !== ticker)
      || (byTicker.has(ticker) && byTicker.get(ticker) !== item.cik)) invalid("Resolve conflicting ticker and CIK identities before scanning this batch.");
    if (!byCik.has(item.cik)) byCik.set(item.cik, { cik: item.cik, ticker });
    byTicker.set(ticker, item.cik);
  }
  return { companies: [...byCik.values()] };
}

/** Bound bytes while reading rather than trusting the caller's Content-Length. */
export async function readPortfolioMarketConnectionsRequest(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) invalid("Use Content-Type: application/json.", 415);
  if (new URL(request.url).search) invalid("This endpoint does not accept query parameters.");
  const declared = Number(request.headers.get("content-length"));
  if (declared > PORTFOLIO_MARKET_CONNECTIONS_BODY_BYTES) invalid("The JSON batch exceeds the 8 KiB limit.", 413);
  const reader = request.body?.getReader();
  if (!reader) invalid("A JSON companies body is required.");
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PORTFOLIO_MARKET_CONNECTIONS_BODY_BYTES) {
        await reader.cancel();
        invalid("The JSON batch exceeds the 8 KiB limit.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let input;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { invalid("Use a valid JSON request body."); }
  return parsePortfolioMarketConnections(input);
}

function unavailable(company, code = "SOURCE_UNAVAILABLE") {
  return {
    ...company, status: "unavailable", context: null, errorCode: code,
    message: code === "DISCOVERY_TIMEOUT" || code === "DISCOVERY_CANCELLED"
      ? "This company was not completed before the batch stopped. Retry its filing discovery."
      : code === "ISSUER_IDENTITY_MISMATCH" || code === "CONTEXT_UNVERIFIED"
        ? "The returned filing evidence could not be verified for this company. No connection is assumed."
        : "Company filing discovery is temporarily unavailable. No missing connection is treated as absent.",
  };
}

function sourceFailure(cause) {
  return PUBLIC_SOURCE_CODES.has(cause?.code) ? cause.code : "SOURCE_UNAVAILABLE";
}

/** A loader that ignores cancellation still cannot hold the response past its deadline. */
async function withinDeadline(task, signal) {
  if (signal.aborted) { Promise.resolve(task).catch(() => {}); throw signal.reason; }
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new Error("Discovery stopped."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([task, stopped]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function verifiedContext(context, company, now) {
  if (context?.cik !== company.cik || context?.ticker !== company.ticker) return "ISSUER_IDENTITY_MISMATCH";
  if (!isCompanyCftcCachedContext(context, { ticker: company.ticker, asOf: null })) return "CONTEXT_UNVERIFIED";
  const generated = Date.parse(context.generatedAt);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(context.generatedAt) || generated > now || generated < Date.parse("1994-01-01T00:00:00Z")) return "CONTEXT_UNVERIFIED";
  return null;
}

/** Unfiltered SEC discovery: no CFTC movement threshold or market-history dependency. */
export async function buildPortfolioMarketConnections(input, {
  loadContext = loadCompanyCftcContext, signal, now = new Date(),
  deadlineMs = PORTFOLIO_MARKET_CONNECTIONS_DEADLINE_MS,
} = {}) {
  const { companies } = parsePortfolioMarketConnections(input);
  const startedAt = Date.now(), nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("A valid discovery date is required.");
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > PORTFOLIO_MARKET_CONNECTIONS_DEADLINE_MS)
    throw new TypeError("The discovery deadline must be between 1 and 50000 milliseconds.");
  const controller = new AbortController();
  const deadline = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("Discovery deadline reached.")), deadlineMs);
  const interruptedCode = () => signal?.aborted ? "DISCOVERY_CANCELLED" : "DISCOVERY_TIMEOUT";
  const results = companies.map(company => unavailable(company, interruptedCode()));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PORTFOLIO_MARKET_CONNECTIONS_CONCURRENCY, companies.length) }, async () => {
    while (cursor < companies.length && !deadline.aborted) {
      const index = cursor++, company = companies[index];
      try {
        const context = await withinDeadline(Promise.resolve().then(() => loadContext({ ticker: company.ticker }, { signal: deadline })), deadline);
        if (deadline.aborted) { results[index] = unavailable(company, interruptedCode()); continue; }
        if (context?.status === "unavailable") { results[index] = unavailable(company, sourceFailure(context)); continue; }
        const failure = verifiedContext(context, company, nowMs + Date.now() - startedAt);
        results[index] = failure ? unavailable(company, failure) : { ...company, status: context.status, context };
      } catch (cause) {
        results[index] = unavailable(company, deadline.aborted ? interruptedCode() : sourceFailure(cause));
      }
    }
  });
  try { await Promise.all(workers); }
  finally { clearTimeout(timer); }
  // Entries never started also retain a result, including when the caller cancelled.
  if (signal?.aborted) {
    for (let index = cursor; index < results.length; index++) results[index] = unavailable(companies[index], "DISCOVERY_CANCELLED");
  }
  return { schemaVersion: PORTFOLIO_MARKET_CONNECTIONS_VERSION, generatedAt: new Date(nowMs + Date.now() - startedAt).toISOString(), results };
}
