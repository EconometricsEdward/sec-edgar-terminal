import { createProductAvailabilityHandler } from '../../../../utils/x402ProductAvailability.js';
import { paidFinancialChangesSelection, paidFinancialChangesReader } from '../../../../utils/x402FinancialChanges.js';
import { paidDisclosureEvidenceSelection, paidDisclosureEvidenceReader } from '../../../../utils/x402DisclosureEvidence.js';
import { paidInstitutionalOverlapSelection, paidInstitutionalOverlapReader } from '../../../../utils/x402InstitutionalOverlap.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createProductAvailabilityHandler({
  'financial-changes': { select: paidFinancialChangesSelection, read: paidFinancialChangesReader, path: '/api/x402/v1/financial-changes' },
  'disclosure-evidence': { select: paidDisclosureEvidenceSelection, read: paidDisclosureEvidenceReader, path: '/api/x402/v1/disclosure-evidence' },
  'institutional-overlap': { select: paidInstitutionalOverlapSelection, read: paidInstitutionalOverlapReader, path: '/api/x402/v1/institutional-overlap' },
});
