import { createPaidProductRoute } from '../../../../../utils/x402ProductRoute.js';
import { x402DataOptions, x402DataHead } from '../../../../../utils/x402Research.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createPaidProductRoute('credit-screen', 'creditScreen', 'Screen prepared debt maturities, liquidity and interest coverage, with filing evidence and JSON or CSV export.');
export const OPTIONS = x402DataOptions;
export const HEAD = x402DataHead;
