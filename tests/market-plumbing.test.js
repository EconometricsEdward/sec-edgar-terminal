import test from 'node:test';
import assert from 'node:assert/strict';
import funding from '../src/data/market-research/funding.json' with { type: 'json' };
import derivatives from '../src/data/market-research/derivatives.json' with { type: 'json' };
import { allowedSource, FUNDING_SOURCES, SWAP_REPORTS } from '../src/utils/marketPlumbing/catalog.js';
import { normalizeRates, normalizeFails, normalizeSwapTables, normalizeSwapHistory, parseSwapReport, mergeSwapObservations, validSnapshot, reportedNumber } from '../src/utils/marketPlumbing/normalize.js';
import { parsePlumbingView, plumbingPath, fundingSeries, swapView, compactNumber } from '../src/utils/marketPlumbing/model.js';
import { archiveSource, fetchPublicSource, runMarketResearchWorker } from '../src/utils/marketPlumbing/worker.js';
import { getMarketResearch } from '../src/utils/marketPlumbing/server.js';
import { createMarketResearchApi } from '../src/utils/marketPlumbing/api.js';

test('captured official reports retain their units, period, total and clearing convention', () => {
  assert.ok(validSnapshot(funding, 'funding')); assert.ok(validSnapshot(derivatives, 'derivatives'));
  assert.equal(fundingSeries(funding).latest.SOFR, 3.88);
  assert.equal(fundingSeries(funding).rates.at(-1).spread, 2);
  assert.equal(fundingSeries(funding).fails.at(-1).deliver, 174218);
  assert.equal(compactNumber(2990 * 1000), '$2.99T');
  for (const asset of ['rates','credit','fx']) for (const measure of ['volume','outstanding','tickets']) {
    const view = swapView(derivatives, parsePlumbingView(`asset=${asset}&measure=${measure}`, 'derivatives'));
    assert.equal(view.date, '2026-09-04'); assert.equal(view.dates.length, 5);
    assert.ok(Math.abs(view.total - view.cleared - view.uncleared) <= 1);
    assert.equal(view.share, view.cleared / view.total * 100);
  }
  const rates = swapView(derivatives, parsePlumbingView('', 'derivatives'));
  assert.equal(rates.total, 17618541); assert.equal(rates.cleared, 16001886);
  assert.deepEqual(rates.tenor.map(r => r.name), ['0-3','3-6','6-12','12-24','24-60','60+']);
  const fx = swapView(derivatives, parsePlumbingView('asset=fx&measure=tickets', 'derivatives'));
  assert.equal(fx.total, 749480); assert.equal(compactNumber(fx.total, 'tickets'), '749.48K');
  assert.equal(fx.currency.length, 3); assert.ok(Math.abs(fx.currency.reduce((s,r) => s+r.value, 0) - fx.total) <= 1);
});

test('missing data stays unavailable; unknown or duplicate source values fail closed', () => {
  for (const s of ['','—','N/A','*']) assert.equal(reportedNumber(s), null);
  assert.equal(reportedNumber('1,234<sup>1</sup>'), 1234);
  assert.throws(() => reportedNumber('12foo'));
  const pd = { pd: { timeseries: [{ asofdate:'2026-09-16', keyid:'PDFTD-USTET', value:'100' }] } };
  assert.equal(normalizeFails(pd)[0].deliver, null);
  assert.throws(() => normalizeFails({ pd: { timeseries: [...pd.pd.timeseries,...pd.pd.timeseries] } }));
  assert.throws(() => normalizeRates({ refRates:[{type:'SOFR', effectiveDate:'2026-02-30', percentRate:3}] }));
  const invalid = structuredClone(derivatives); invalid.observations[0].value = 'NaN'; assert.equal(validSnapshot(invalid, 'derivatives'), false);
});

test('inert HTML parser reads report dates and ignores participant double counts', () => {
  const html = '<h1>Transaction Dollar Volume - 09/04/2026</h1><table><tr><th>Product</th><th>Cleared</th><th>Uncleared</th><th>Total</th></tr><tr><td>OIS<sup>1</sup></td><td>75</td><td>25</td><td>100</td></tr><tr><td>TOTAL</td><td>75</td><td>25</td><td>100</td></tr></table><table><tr><th>Product</th><th>Cleared</th><th>Uncleared</th><th>Cleared</th><th>Uncleared</th><th>Total</th></tr><tr><td>TOTAL</td><td>150</td><td>50</td><td>150</td><td>50</td><td>400</td></tr></table>';
  const rows = parseSwapReport(html, {asset:'rates',measure:'volume'});
  assert.equal(rows.length, 6); assert.equal(rows[0].product, 'OIS'); assert.equal(rows[0].date,'2026-09-04');
  assert.throws(() => parseSwapReport(html.replace('<td>100</td></tr></table>', '<td>999</td></tr></table>'), {asset:'rates',measure:'volume'}));
});

test('FX currency groups exclude overlapping regional and individual-pair rows', () => {
  const tables = [[['Product','Cleared','Uncleared','Total'],['OTHER','10','90','100'],['TOTAL','10','90','100']],
    [['Currency Pair','Other','Total'],['USD/','80','80'],['Europe','50','50'],['EUR','20','20'],['OTHER','30','30'],['EUR/non-USD','15','15'],['OTHER','5','5'],['TOTAL','100','100']]];
  const rows = normalizeSwapTables({date:'2026-09-04',tables,asset:'fx',measure:'volume'});
  const other = rows.filter(r => r.product === 'Other' && r.dimension === 'currency');
  assert.deepEqual(other.map(r => r.value), [80,15,5]);
});

test('history resolves year boundaries, corrected releases replace removed products, and retention is bounded', () => {
  const table = [['','Jan 2','Dec 26'],...['Interest Rate','Credit','FX'].flatMap(a => [[`Total ${a}`,'100','90'],['Cleared','80','70'],['Uncleared','20','20']])];
  const rows = normalizeSwapHistory({ date:'2026-01-02', tables:[table], measure:'volume' });
  assert.deepEqual([...new Set(rows.map(r => r.date))], ['2026-01-02','2025-12-26']);
  const original = {date:'2026-01-02',asset:'rates',measure:'volume',dimension:'clearing',product:'Old',bucket:'Total',value:100};
  const revised = {...original,product:'New',value:110};
  assert.deepEqual(mergeSwapObservations([original], [[revised]]), [revised]);
  const long = Array.from({length:110},(_,i) => { const date=new Date(Date.UTC(2024,0,1)+i*604800000).toISOString().slice(0,10); return [{...original,date},{...original,date,product:'TOTAL'}]; }).flat();
  const retained=mergeSwapObservations(long,[]);
  assert.equal(retained.filter(r=>r.product==='TOTAL').length,104); assert.equal(retained.filter(r=>r.product==='Old').length,12);
});

test('view links round trip, invalid input is bounded, product history is not invented', () => {
  const view=parsePlumbingView('asset=fx&measure=tickets&product=Other&date=2026-09-04','derivatives');
  assert.deepEqual(parsePlumbingView(plumbingPath(view).split('?')[1],'derivatives'),view);
  assert.equal(parsePlumbingView('asset=unknown').asset,'rates');
  const product=swapView(derivatives,view); assert.equal(product.trend.filter(r=>r.value!==null).length,1); assert.equal(product.change,null);
});

test('source allowlist, redirects and source size limits prevent arbitrary extraction', async () => {
  for (const url of ['http://markets.newyorkfed.org/api/rates/secured/all/search.json','https://www.dtcc.com/data','https://www.cftc.gov.evil.test/MarketReports/SwapsReports/L2IRSAct.html', `${FUNDING_SOURCES.rates}?callback=bad`]) assert.equal(allowedSource(url),false);
  await assert.rejects(fetchPublicSource('https://example.com'),/Unapproved/);
  await assert.rejects(fetchPublicSource(SWAP_REPORTS[0].url,{fetchImpl:async()=>new Response('denied',{status:403})}),/403/);
  await assert.rejects(fetchPublicSource(SWAP_REPORTS[0].url,{fetchImpl:async()=>new Response('large',{headers:{'content-length':'4000000'}})}),/Oversize/);
  const archive=archiveSource(SWAP_REPORTS[0].url,'public source','2026-09-26T00:00:00Z'); assert.match(archive.hash,/^[a-f0-9]{64}$/);
});

test('scheduled source failure retains the last snapshot, stops at denial and releases the fenced claim', async () => {
  const calls=[], fetches=[];
  const result=await runMarketResearchWorker({store:async(op,p)=>{calls.push([op,p]);return op==='begin'?{allowed:true,owner:'owner',generation:1}: {snapshot:derivatives};},fetchImpl:async(url)=>{fetches.push(url);return new Response('unavailable',{status:403});}});
  assert.equal(result.funding,'retained');assert.equal(result.derivatives,'retained');
  assert.equal(fetches.filter(url=>url.includes('cftc')).length,1);
  assert.ok(!calls.some(([op])=>op==='publish'));assert.equal(calls.at(-1)[0],'finish');
});

test('read API serves verified fallback without source requests and rejects ambiguous queries',async()=>{
  const data=await getMarketResearch('funding',{useCache:false,store:async()=>{throw new Error('unavailable');}});
  assert.equal(data.availability,'retained');assert.match(data.notice,/Federal Reserve Bank of New York/);
  const api=createMarketResearchApi({read:async()=>data,rateLimit:async()=>({allowed:true})});
  const r=await api(new Request('https://site.test/api/market-plumbing?view=funding'));assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/s-maxage/);
  for(const query of ['','view=other','view=funding&view=derivatives','view=funding&ticker=JPM']) assert.equal((await api(new Request(`https://site.test/api/market-plumbing?${query}`))).status,400);
});
