import { createPaidProductRoute, createPaidProductHead } from '../../../../../utils/x402ProductRoute.js';
import { x402DataOptions } from '../../../../../utils/x402Research.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createPaidProductRoute('fundamental-screen', 'fundamentalScreen', 'Filter and rank prepared SEC fundamentals by sector and metric, with snapshot-pinned JSON or CSV pages.');
export const OPTIONS = x402DataOptions;
export const HEAD = createPaidProductHead('fundamental-screen');
