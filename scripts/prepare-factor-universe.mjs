// Production build hook: publish only SEC-derived Market/Fundamental snapshots.
import { warmCacheEnabled } from '../src/utils/warmCache.js';
import { refreshUniverseSnapshot } from '../src/utils/marketUniverseServer.js';
import { refreshQuantMembership, refreshQuantBatch, refreshQuantRevenueCorrections, refreshQuantRiskMappings } from '../src/utils/quantCoverageServer.js';
import { runRefinancingBackfill } from '../src/utils/refinancing/backfill.js';

if (process.env.VERCEL_ENV === 'production' && warmCacheEnabled()) {
  // Recompute only the affected mappings; conditionally revalidate their two
  // source documents when prepared evidence predates the company checkpoint.
  const correctionController = new AbortController(), correctionTimer = setTimeout(() => correctionController.abort(), 275000);
  try { console.log('[Market] Prepared revenue correction checkpoints:', JSON.stringify(await refreshQuantRevenueCorrections({ signal: correctionController.signal, deadline: Date.now() + 300000, revalidateSources: true, refreshUnprepared: true }))); }
  catch (error) { console.warn('[Market] Revenue correction publication deferred:', error.message); }
  finally { clearTimeout(correctionTimer); }
  const riskController = new AbortController(), riskTimer = setTimeout(() => riskController.abort(), 30000);
  try { console.log('[Market] Prepared sector risk mappings:', JSON.stringify(await refreshQuantRiskMappings({ signal: riskController.signal, deadline: Date.now() + 30000 }))); }
  catch (error) { console.warn('[Market] Risk mappings retained for scheduled completion:', error.message); }
  finally { clearTimeout(riskTimer); }
  // Activate the reviewed candidate directory, but never crawl thousands of
  // companies in a deployment. Resumable scheduled shards own SEC ingestion.
  let activatedMembership = false;
  const membershipController = new AbortController(), membershipTimer = setTimeout(() => membershipController.abort(), 65000);
  try {
    const result = await refreshQuantMembership({ signal: membershipController.signal });
    activatedMembership = Boolean(result.membership_id);
    console.log('[Market] Coverage membership:', JSON.stringify(result));
  }
  catch (error) { console.warn('[Market] Membership retained for scheduled completion:', error.message); }
  finally { clearTimeout(membershipTimer); }
  if (activatedMembership) {
    // One bounded head start only. The remaining stable shards are scheduled;
    // a deployment never waits for the complete candidate universe to load.
    const bootstrapController = new AbortController(), bootstrapTimer = setTimeout(() => bootstrapController.abort(), 60000);
    try { console.log('[Market] Initial coverage checkpoint:', JSON.stringify(await refreshQuantBatch(0, {
      signal: bootstrapController.signal, deadline: Date.now() + 60000,
    }))); }
    catch (error) { console.warn('[Market] Initial checkpoint deferred:', error.message); }
    finally { clearTimeout(bootstrapTimer); }
  }
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),260000);
  try { console.log('[Fundamental Lab] SEC-only v2 publication:', JSON.stringify(await refreshUniverseSnapshot({signal:controller.signal,deadline:Date.now()+285000}))); }
  catch (error) { console.warn('[Fundamental Lab] Publication retained for scheduled completion:', error.message); }
  finally { clearTimeout(timer); }
  // One resumable launch batch after the Market membership projection exists.
  // Archives are preferred; only known pending issuers can use companyfacts-only
  // SEC requests. The private cursor/backoff is shared with the bounded cron.
  const maturityController = new AbortController(), maturityTimer = setTimeout(() => maturityController.abort(), 240000);
  try { console.log('[Market] Refinancing coverage backfill:', JSON.stringify(await runRefinancingBackfill({
    signal: maturityController.signal, deadline: Date.now() + 240000, limit: 500,
  }))); }
  catch (error) { console.warn('[Market] Refinancing backfill retained for scheduled completion:', error.message); }
  finally { clearTimeout(maturityTimer); }
}
