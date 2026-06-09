import { buildSnapshot, normalizeTicker } from '../../../../../utils/secSnapshot.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(payload, init = {}) {
  return Response.json(payload, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const tickerParam = searchParams.get('ticker');
  const ticker = normalizeTicker(tickerParam || 'AAPL');
  if (!ticker) {
    return json(
      {
        error: 'invalid_ticker',
        message: 'Provide a ticker query parameter using 1-12 ticker characters.',
        example: '/api/x402/upstream/sec-snapshot?ticker=AAPL',
      },
      { status: 400 },
    );
  }

  try {
    return json({
      status: 'ok',
      product: 'EDGAR Terminal x402 upstream SEC snapshot API',
      defaultedTicker: !tickerParam,
      snapshot: await buildSnapshot(ticker),
      boundaries: [
        'Public SEC data only.',
        'For research and educational use only.',
        'Not investment, financial, legal, or tax advice.',
      ],
    });
  } catch (error) {
    return json(
      {
        error: 'snapshot_failed',
        message: error.message,
      },
      { status: 502 },
    );
  }
}
