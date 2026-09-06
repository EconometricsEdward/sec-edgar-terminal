import {
  disclosureSettings,
  scanDisclosureCompany,
  readDisclosureDocument,
} from "../../../utils/disclosureResearchServer.js";
import {
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
} from "../../../utils/rateLimit.js";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  let settings;
  try {
    settings = disclosureSettings(params);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  const ticker = (params.get("ticker") || "").trim();
  if (!ticker || ticker.length > 100)
    return Response.json(
      { error: "Provide a ticker, CIK, or exact company name." },
      { status: 400 },
    );
  const action = params.get("action") || "scan";
  const page = Number(params.get("page") || 1);
  if (
    !["scan", "document"].includes(action) ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 500
  )
    return Response.json({ error: "Invalid review request." }, { status: 400 });
  const limit = await checkRateLimit({
    key: `rl:disclosure-research:${action}:${getClientIp(request)}`,
    max: action === "scan" ? 50 : 90,
    windowMs: 60000,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const data =
      action === "document"
        ? await readDisclosureDocument(
            ticker,
            params.get("accession") || "",
            params.get("document") || "",
            settings,
            page,
          )
        : await scanDisclosureCompany(ticker, settings);
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    const headers = {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
    };
    if (bytes.length <= 3500000) return new Response(bytes, { headers });
    // Preserve unusually large quotations without a buffered function-response limit.
    let offset = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + 32768));
          offset += 32768;
        },
      }),
      { headers },
    );
  } catch (error) {
    return Response.json(
      { error: error.message || "SEC disclosure review failed." },
      { status: 502 },
    );
  }
}
