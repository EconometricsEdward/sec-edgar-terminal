import { createPaidHandler, createX402DiscoveryHead } from '../../../../../../utils/x402Payments.js';
import { x402Ledger } from '../../../../../../utils/x402Ledger.js';
import { x402DiscoveryOptions } from '../../../../../../utils/x402Discovery.js';
import { paidResearchReaders, paidResearchSelection, x402DataError, x402DataOptions } from '../../../../../../utils/x402Research.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
const paidGet = createPaidHandler(async (request, context) => paidResearchReaders.financials(context.selection), {
  description: 'Prepared normalized company financial history, metrics and SEC evidence.',
  ...x402DiscoveryOptions('financials'),
  ledger: x402Ledger,
});
export async function GET(request, { params }) {
  const selection = paidResearchSelection(request, 'financials', (await params).ticker);
  if (!selection) return x402DataError('INVALID_SELECTION', 'Choose one company ticker and basis=annual, quarter, ytd or ttm.');
  return paidGet(request, { selection });
}
export const OPTIONS = x402DataOptions;
export const HEAD = createX402DiscoveryHead({
  description: 'Unpaid discovery metadata for prepared company financial history.',
  ...x402DiscoveryOptions('financials'),
  validate: async (request, { params }) => paidResearchSelection(request, 'financials', (await params).ticker) ? null
    : x402DataError('INVALID_SELECTION', 'Choose a documented ticker and GET basis. See /data-access and /openapi.json.'),
});
