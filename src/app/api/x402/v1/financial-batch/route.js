import { createPaidProductRoute, createPaidProductHead } from '../../../../../utils/x402ProductRoute.js';
import { x402DataOptions } from '../../../../../utils/x402Research.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createPaidProductRoute('financial-batch', 'financialBatch', 'Source-linked normalized financial histories for up to ten selected companies, in JSON or flat CSV.');
export const OPTIONS = x402DataOptions;
export const HEAD = createPaidProductHead('financial-batch');
