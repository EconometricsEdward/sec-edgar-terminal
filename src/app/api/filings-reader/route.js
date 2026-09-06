import { filingReaderSettings, readFilingsDocument } from "../../../utils/filingsReader.js";
import { checkRateLimit, getClientIp, rateLimitedResponse } from "../../../utils/rateLimit.js";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request) {
  let settings;
  try { settings = filingReaderSettings(new URL(request.url).searchParams); }
  catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  const limit = await checkRateLimit({ key: `rl:filings-reader:${getClientIp(request)}`, max: 100, windowMs: 60000 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const result = await readFilingsDocument(settings, { signal: request.signal });
    const bytes = new TextEncoder().encode(JSON.stringify(result));
    const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8" };
    if (bytes.length <= 3500000) return new Response(bytes, { headers });
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 32768));
      offset += 32768;
    } }), { headers });
  } catch (error) {
    return Response.json({ error: error.message || "The SEC filing could not be read." }, { status: error.status || 502 });
  }
}
