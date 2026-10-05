import { createPaidProductRoute } from '../../../../../utils/x402ProductRoute.js';
import { paidDisclosureEvidenceSelection, paidDisclosureEvidenceReader } from '../../../../../utils/x402DisclosureEvidence.js';
import { x402DataOptions, x402DataHead } from '../../../../../utils/x402Research.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createPaidProductRoute('disclosure-evidence', null, 'Exact Boolean-matched original disclosure paragraphs from the bounded prepared corpus, with filing links and explicit extraction coverage.', { select: paidDisclosureEvidenceSelection, read: paidDisclosureEvidenceReader });
export const OPTIONS = x402DataOptions;
export const HEAD = x402DataHead;
