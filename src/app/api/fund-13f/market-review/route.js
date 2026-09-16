import { after } from 'next/server';
import { createThirteenFReviewApi } from '../../../../utils/thirteenFReviewApi.js';
import { runThirteenFReviewWorker } from '../../../../utils/thirteenFReviewWorker.js';

export const runtime = 'nodejs';
export const maxDuration = 150;
const handlers = createThirteenFReviewApi({ schedule: () => after(async () => {
  // The response and visitor lifecycle do not own this work. The existing
  // signed scheduler resumes any unfinished batch from durable checkpoints.
  try { await runThirteenFReviewWorker({ signal: AbortSignal.timeout(75000), deadline: Date.now() + 75000 }); }
  catch { console.warn('Shared 13F review kickoff deferred to the scheduler.'); }
}) });
export const GET = handlers.GET;
export const POST = handlers.POST;
