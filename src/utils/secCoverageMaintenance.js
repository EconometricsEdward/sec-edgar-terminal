/** Daily validated holdings checks, with bounded preparation before activation. */
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { beginCoverageMembershipCheck, stageCoverageMembership, activateCoverageMembership,
  finishCoverageMembershipCheck } from './dataStore.js';
import { loadSecCoverageRegistry } from './secCoverageRegistry.js';
import { refreshSecCoverageMembershipSource } from './secCoverageMembershipSource.js';
import { refreshSecCoverageCompany } from './preparedFinancialData.js';

const DAY = 86400000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeCode = error => typeof error?.code === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(error.code)
  ? error.code : 'membership_check_failed';

/** No public reads depend on a successful check; the previous active set survives. */
export async function maintainSecCoverageMembership({ signal, deadline = Date.now() + 125000 } = {}, {
  begin = beginCoverageMembershipCheck, stage = stageCoverageMembership,
  activate = activateCoverageMembership, finish = finishCoverageMembershipCheck,
  load = loadSecCoverageRegistry, source = refreshSecCoverageMembershipSource,
  refresh = refreshSecCoverageCompany, now = Date.now,
} = {}) {
  if (signal?.aborted || now() >= deadline - 60000) return { status: 'deferred', reason: 'deadline' };
  let claim;
  try { claim = await begin(); }
  catch (error) { return { status: 'failed', code: safeCode(error) }; }
  if (!claim) return { status: 'not-due' };
  let errorCode = null;
  let result;
  try {
    let registry = await load({ force: true, required: true });
    let candidate = registry.candidate;
    // A blocked old candidate must not prevent later valid holdings updates.
    const candidateExpired = candidate && Date.parse(candidate.reference.asOf) < Math.floor(now() / DAY) * DAY - 14 * DAY;
    if (!candidate || candidateExpired) {
      const fetched = await source({ previous: registry.active, signal,
        deadline: Math.min(deadline, now() + 45000) });
      const bytes = Buffer.from(fetched.sourceBytes);
      const gzip = gzipSync(bytes, { level: 6 });
      if (!bytes.length || bytes.length > 750000 || gzip.length > 200000
        || hash(bytes) !== fetched.sourceSha256) throw Object.assign(new Error('Invalid source evidence.'), { code: 'membership_source_evidence_invalid' });
      await stage(claim, fetched.candidate, { rawSha256: fetched.sourceSha256, rawBytes: bytes.length,
        gzipSha256: hash(gzip), gzipBase64: gzip.toString('base64') });
      registry = await load({ force: true, required: true });
      candidate = registry.candidate;
    }
    if (!candidate) {
      result = { status: 'unchanged', activeId: registry.active.id, sourceAsOf: registry.active.reference.asOf };
    } else {
      let activation = await activate(claim, candidate.id);
      const prepared = [];
      if (!activation.activated) {
        if (!Array.isArray(activation.neededCiks) || activation.neededCiks.length > 600
          || activation.neededCiks.some(cik => !/^\d{10}$/.test(cik))) throw Object.assign(new Error('Invalid activation response.'), { code: 'membership_activation_invalid' });
        const allowed = new Set([...candidate.issuers.map(company => company.cik), '0000002098']);
        for (const cik of activation.neededCiks.slice(0, 2)) {
          if (!allowed.has(cik)) throw Object.assign(new Error('Unapproved preparation identity.'), { code: 'membership_preparation_identity_invalid' });
          if (signal?.aborted || now() >= deadline - 60000) break;
          try {
            // A CIK remains stable when an issuer changes its ticker.
            const refreshed = await refresh(cik, { signal, deadline });
            if (refreshed.status === 'prepared' && refreshed.cik !== cik) throw Object.assign(new Error('Wrong issuer.'), { code: 'membership_preparation_identity_invalid' });
            prepared.push({ cik, status: refreshed.status });
          } catch (error) {
            errorCode = safeCode(error);
            prepared.push({ cik, status: 'failed', code: errorCode });
          }
        }
        if (prepared.length && !signal?.aborted && now() < deadline - 5000) activation = await activate(claim, candidate.id);
      }
      if (activation.activated) {
        await load({ force: true, required: true });
        errorCode = null;
      }
      result = { status: activation.activated ? 'activated' : 'preparing', activeId: activation.activeId,
        candidateId: activation.candidateId, sourceAsOf: candidate.reference.asOf,
        remaining: activation.neededCiks?.length || 0, prepared };
    }
  } catch (error) {
    errorCode = safeCode(error);
    result = { status: 'failed', code: errorCode };
  }
  try {
    const released = await finish(claim, errorCode);
    if (!released) return { ...result, status: 'failed', code: 'membership_lease_lost' };
  } catch (error) {
    return { ...result, status: 'failed', code: safeCode(error) };
  }
  return result;
}
