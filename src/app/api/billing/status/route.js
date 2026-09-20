import { handleBillingStatus } from '../../../../utils/billingServer.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const GET = request => handleBillingStatus(request);
