import { createRiskPeersRoute } from '../../../../utils/riskPeersServer.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const GET = createRiskPeersRoute();
