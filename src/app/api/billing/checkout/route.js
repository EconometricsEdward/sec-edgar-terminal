import { handleBillingCheckout } from '../../../../utils/billingServer.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;
export const POST = request => handleBillingCheckout(request);
