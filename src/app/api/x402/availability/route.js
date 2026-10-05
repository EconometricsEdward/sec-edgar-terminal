import { createProductAvailabilityHandler } from '../../../../utils/x402ProductAvailability.js';
import { paidFinancialChangesSelection, paidFinancialChangesReader } from '../../../../utils/x402FinancialChanges.js';
import { paidDisclosureEvidenceSelection, paidDisclosureEvidenceReader } from '../../../../utils/x402DisclosureEvidence.js';
import { paidInstitutionalOverlapSelection, paidInstitutionalOverlapReader } from '../../../../utils/x402InstitutionalOverlap.js';
import { paidBankRiskBatchSelection, paidBankRiskBatchReader } from '../../../../utils/x402BankRiskBatch.js';
import { paidDisclosureTopicPacketSelection, paidDisclosureTopicPacketReader } from '../../../../utils/x402DisclosureTopicPacket.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createProductAvailabilityHandler({
  'bank-risk-batch': { select: paidBankRiskBatchSelection, read: paidBankRiskBatchReader, path: '/api/x402/v1/bank-risk-batch' },
  'disclosure-topic-packet': { select: paidDisclosureTopicPacketSelection, read: paidDisclosureTopicPacketReader, path: '/api/x402/v1/disclosure-topic-packet' },
  'financial-changes': { select: paidFinancialChangesSelection, read: paidFinancialChangesReader, path: '/api/x402/v1/financial-changes' },
  'disclosure-evidence': { select: paidDisclosureEvidenceSelection, read: paidDisclosureEvidenceReader, path: '/api/x402/v1/disclosure-evidence' },
  'institutional-overlap': { select: paidInstitutionalOverlapSelection, read: paidInstitutionalOverlapReader, path: '/api/x402/v1/institutional-overlap' },
});
