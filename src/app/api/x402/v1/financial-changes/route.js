import { createPaidProductRoute } from '../../../../../utils/x402ProductRoute.js';
import { paidFinancialChangesSelection, paidFinancialChangesReader } from '../../../../../utils/x402FinancialChanges.js';
import { x402DataOptions, x402DataHead } from '../../../../../utils/x402Research.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createPaidProductRoute('financial-changes', null, 'Compact latest-versus-baseline financial changes with compatible reporting periods, units and original SEC evidence.', { select: paidFinancialChangesSelection, read: paidFinancialChangesReader });
export const OPTIONS = x402DataOptions;
export const HEAD = x402DataHead;
