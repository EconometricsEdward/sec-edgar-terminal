import { handleRefinancingCron } from '../../../../utils/refinancing/cron.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export const GET = handleRefinancingCron;
