import { createPaidProductRoute, createPaidProductHead } from '../../../../../utils/x402ProductRoute.js';
import { paidBankRiskBatchSelection, paidBankRiskBatchReader } from '../../../../../utils/x402BankRiskBatch.js';
import { x402DataOptions } from '../../../../../utils/x402Research.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createPaidProductRoute('bank-risk-batch', null, 'Prepared FFIEC bank capital, credit and funding evidence for one to four legal reporting banks, with compatible prior-quarter changes and exact source references.', { select: paidBankRiskBatchSelection, read: paidBankRiskBatchReader });
export const OPTIONS = x402DataOptions;
export const HEAD = createPaidProductHead('bank-risk-batch', { select: paidBankRiskBatchSelection });
