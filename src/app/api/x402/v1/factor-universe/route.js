import { createPaidHandler } from '../../../../../utils/x402Payments.js';
import { x402Ledger } from '../../../../../utils/x402Ledger.js';
import { x402DiscoveryOptions } from '../../../../../utils/x402Discovery.js';
import { paidResearchReaders, paidResearchSelection, x402DataError, x402DataOptions, x402DataHead } from '../../../../../utils/x402Research.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
const paidGet = createPaidHandler(async (request, context) => paidResearchReaders.page('factor-universe', context.selection), {
  description: 'A page of prepared company fundamentals, with coverage and source dates.',
  ...x402DiscoveryOptions('factor-universe'),
  ledger: x402Ledger,
});
export function GET(request) {
  const selection = paidResearchSelection(request, 'factor-universe');
  if (!selection) return x402DataError('INVALID_SELECTION', 'Use basis=ttm or annual, limit=1..100, offset=0..9999 and an optional snapshot token.');
  return paidGet(request, { selection });
}
export const OPTIONS = x402DataOptions;
export const HEAD = x402DataHead;
