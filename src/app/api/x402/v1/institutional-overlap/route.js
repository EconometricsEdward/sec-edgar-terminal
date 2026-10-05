import { createPaidProductRoute } from '../../../../../utils/x402ProductRoute.js';
import { paidInstitutionalOverlapSelection, paidInstitutionalOverlapReader } from '../../../../../utils/x402InstitutionalOverlap.js';
import { x402DataOptions, x402DataHead } from '../../../../../utils/x402Research.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createPaidProductRoute('institutional-overlap', null, 'Reconciled same-quarter institutional position overlap for two to four complete prepared 13F manager portfolios, with amendment-chain evidence.', { select: paidInstitutionalOverlapSelection, read: paidInstitutionalOverlapReader });
export const OPTIONS = x402DataOptions;
export const HEAD = x402DataHead;
