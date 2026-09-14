import { isCftcEnabled } from '../../../../../utils/cftcFeature.js';
import { buildPortfolioCftcChanges, PORTFOLIO_CFTC_CHANGES_VERSION, PORTFOLIO_CFTC_COMPANY_LIMIT } from '../../../../../utils/portfolioCftcChanges.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_PORTFOLIO_CFTC_REQUEST' });
}

async function readRequest(request) {
  let body;
  try { body = await request.json(); }
  catch { invalid('Use a valid JSON request body.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Use a JSON request body.');
  if (!Object.keys(body).every(key => ['companies', 'days'].includes(key))) invalid('The request contains an unsupported field.');
  if (!Array.isArray(body.companies) || body.companies.length < 1 || body.companies.length > 100)
    invalid('Provide between 1 and 100 portfolio companies.');
  if (body.days !== undefined && (!Number.isInteger(body.days) || body.days < 1 || body.days > 90))
    invalid('days must be an integer from 1 to 90.');
  for (const item of body.companies) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.keys(item).every(key => ['ticker', 'cik', 'rowId'].includes(key)))
      invalid('Each company may contain only ticker, cik, and rowId.');
    if (typeof item.ticker !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,14}$/.test(item.ticker))
      invalid('Each company needs a valid ticker.');
    if (item.cik !== undefined && item.cik !== '' && (typeof item.cik !== 'string' || !/^\d{10}$/.test(item.cik)))
      invalid('CIKs must be ten-digit strings.');
    if (item.rowId !== undefined && (typeof item.rowId !== 'string' || item.rowId.length > 200))
      invalid('rowId is too long.');
  }
  return { companies: body.companies, days: body.days || 30 };
}

export async function POST(request) {
  if (!isCftcEnabled())
    return Response.json({ schemaVersion: PORTFOLIO_CFTC_CHANGES_VERSION, status: 'disabled', error: 'CFTC context is disabled.', code: 'CFTC_DISABLED' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  const limit = await checkRateLimit({ key: `rl:portfolio-cftc-changes:${getClientIp(request)}`, windowMs: 10 * 60_000, max: 12 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const input = await readRequest(request);
    const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(52_000)]);
    const result = await buildPortfolioCftcChanges(input, { signal: deadline });
    return Response.json(result, {
      headers: {
        ...rateLimitHeaders(limit),
        'Cache-Control': 'private, max-age=0, no-store',
        'X-Schema-Version': PORTFOLIO_CFTC_CHANGES_VERSION,
        'X-Portfolio-CFTC-Limit': String(PORTFOLIO_CFTC_COMPANY_LIMIT),
      },
    });
  } catch (error) {
    return Response.json({
      schemaVersion: PORTFOLIO_CFTC_CHANGES_VERSION,
      error: error?.message || 'Portfolio CFTC context is temporarily unavailable.',
      code: error?.code || 'PORTFOLIO_CFTC_UNAVAILABLE',
      retryable: !error?.status || error.status >= 500,
    }, {
      status: error?.status || 503,
      headers: { ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store' },
    });
  }
}
