import { createOrganizationApi } from '../../../../utils/bank/organizationApi.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;
export const GET = createOrganizationApi();
