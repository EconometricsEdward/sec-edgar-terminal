// Production build hook: publish only SEC-derived Market/Fundamental snapshots.
import { warmCacheEnabled } from '../src/utils/warmCache.js';
import { refreshUniverseSnapshot } from '../src/utils/marketUniverseServer.js';
import { readQuantAtlas, refreshQuantBatch, readQuantMembership, membershipId, refreshQuantRevenueCorrections } from '../src/utils/quantCoverageServer.js';
import { QUANT_BATCHES } from '../src/utils/quantGroups.js';

if (process.env.VERCEL_ENV === 'production' && warmCacheEnabled()) {
  // Recompute known mapping/context fixes from the prepared public documents.
  // Missing inputs remain unavailable; this never starts an upstream SEC crawl.
  const correctionController = new AbortController(), correctionTimer = setTimeout(() => correctionController.abort(), 165000);
  try { console.log('[Market] Prepared revenue correction checkpoints:', JSON.stringify(await refreshQuantRevenueCorrections({ signal: correctionController.signal, deadline: Date.now() + 180000 }))); }
  catch (error) { console.warn('[Market] Revenue correction publication deferred:', error.message); }
  finally { clearTimeout(correctionTimer); }
  const coverage = await readQuantMembership();
  let expanded = await readQuantAtlas();
  // The final publisher re-reads checkpoints under its universe-wide lease and
  // publishes the corrected Market overview, including retained-atlas fallback.
  if (expanded?.coverage?.membership_id !== membershipId(coverage)) {
    const deadline = Date.now() + 25 * 60_000;
    for (let batch = 0; batch < QUANT_BATCHES && Date.now() < deadline - 30000; batch++) {
      const controller = new AbortController(), budget = Math.min(260000, deadline - Date.now() - 10000), timer = setTimeout(()=>controller.abort(),budget);
      try { console.log('[Fundamental Lab] SEC coverage checkpoint:', JSON.stringify(await refreshQuantBatch(batch,{signal:controller.signal,deadline:Date.now()+budget}))); }
      catch (error) { console.warn('[Fundamental Lab] SEC coverage batch deferred:', batch, error.message); }
      finally { clearTimeout(timer); }
    }
  }
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),260000);
  try { console.log('[Fundamental Lab] SEC-only v2 publication:', JSON.stringify(await refreshUniverseSnapshot({signal:controller.signal,deadline:Date.now()+285000}))); }
  catch (error) { console.warn('[Fundamental Lab] Publication retained for scheduled completion:', error.message); }
  finally { clearTimeout(timer); }
}
