import { createExposureApi } from '../../../../utils/bank/exposureApi.js';
export const runtime = 'nodejs';
// Request-specific GET remains dynamic while hash-pinned public reports can be shared.
export const GET = createExposureApi();
