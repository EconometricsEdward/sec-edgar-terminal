// Application ownership conflicts are permanent for the supplied claim. They
// use PT409 so PostgREST does not treat them as retryable serialization errors.
const CONFLICTS = Object.freeze({
  edgar_publish: ['stale_generation'],
  edgar_cache_put_fenced: ['stale_generation'],
  edgar_stage_membership: ['membership_claim_lost', 'membership_candidate_pending'],
  edgar_activate_membership: ['membership_claim_lost'],
  edgar_fund_review_save: ['fund_review_lease_expired'],
  edgar_fund_review_save_batch: ['fund_review_lease_expired'],
});

/** Only audited operation/message pairs may become the sanitized marker. */
export function isApplicationConflict(operation, error) {
  return error?.code === 'PT409' && Object.hasOwn(CONFLICTS, operation)
    && CONFLICTS[operation].includes(error.message);
}

/** Keep older gateway deployments compatible while SQL and callers roll out. */
export function isApplicationConflictResponse(operation, error) {
  return error?.code === '40001'
    || error?.code === 'stale_generation' && Object.hasOwn(CONFLICTS, operation)
    || isApplicationConflict(operation, error);
}
