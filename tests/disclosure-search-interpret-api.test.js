import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/api/disclosure-search/interpret/route.js';

const request = (query, options = {}) => new Request(`https://example.test/api/disclosure-search/interpret?${new URLSearchParams({ query, ...options })}`);

test('interpretation validates first, preserves explicit issuer scope during outages, and reuses a verified directory', async () => {
  const original = global.fetch;
  let available = false, directoryRequests = 0;
  global.fetch = async input => {
    const url = new URL(input);
    assert.equal(url.href, 'https://www.sec.gov/files/company_tickers.json');
    directoryRequests++;
    if (!available) return new Response('Directory unavailable', { status: 404 });
    return Response.json({
      0: { ticker: 'F', cik_str: 37996, title: 'FORD MOTOR CO' },
      1: { ticker: 'FORD', cik_str: 38264, title: 'FORWARD INDUSTRIES INC' },
      2: { ticker: 'V', cik_str: 1403161, title: 'VISA INC' },
    });
  };
  try {
    const malformed = await GET(request('liquidity AND'));
    assert.equal(malformed.status, 400);
    const exact = await GET(request('"Ford Motor" AND liquidity', { style: 'exact' }));
    assert.equal(exact.status, 200);
    assert.equal(directoryRequests, 0);

    const outage = await GET(request('$F liquidity'));
    assert.equal(outage.status, 503);
    assert.equal(outage.headers.get('cache-control'), 'private, no-store');
    const outageData = await outage.json();
    assert.equal(outageData.code, 'COMPANY_DIRECTORY_UNAVAILABLE');
    assert.ok(!outageData.settings, 'An unresolved explicit issuer must not yield executable broad-search settings.');

    for (const query of ['F liquidity', 'V payment fraud', 'MSFT cybersecurity']) {
      const bareSymbolOutage = await GET(request(query));
      assert.equal(bareSymbolOutage.status, 503, query);
      assert.equal((await bareSymbolOutage.json()).code, 'COMPANY_DIRECTORY_UNAVAILABLE', query);
    }

    const broad = await GET(request('cybersecurity'));
    assert.equal(broad.status, 200);
    const broadData = await broad.json();
    assert.equal(broadData.settings.tickers, '');
    assert.match(broadData.warnings.join(' '), /directory is temporarily unavailable/);

    available = true;
    const mapped = await GET(request('Ford Motor liquidity'));
    assert.equal(mapped.status, 200);
    assert.equal((await mapped.json()).settings.tickers, '0000037996');
    const requestsAfterLoad = directoryRequests;
    const short = await GET(request('V payment fraud'));
    assert.equal(short.status, 200);
    assert.equal((await short.json()).settings.tickers, 'V');
    const unknown = await GET(request('$UNKNOWN liquidity'));
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /No SEC company matched UNKNOWN/);
    assert.equal(directoryRequests, requestsAfterLoad, 'Warm interpretations must reuse the shared SEC directory.');
  } finally { global.fetch = original; }
});
