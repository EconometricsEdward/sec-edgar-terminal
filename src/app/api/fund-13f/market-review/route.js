import { after } from 'next/server';
import { createThirteenFReviewApi } from '../../../../utils/thirteenFReviewApi.js';
import { drainThirteenFReviews } from '../../../../utils/thirteenFReviewDrain.js';

export const runtime = 'nodejs';
export const maxDuration = 150;
const handlers = createThirteenFReviewApi({ schedule: ({ deadline } = {}) => after(async () => {
  // The response and visitor lifecycle do not own this work. The existing
  // signed scheduler resumes any unfinished batch from durable checkpoints.
  try {
    const result = await drainThirteenFReviews({ deadline });
    console.info('Shared 13F review kickoff:', JSON.stringify(result));
  }
  catch { console.warn('Shared 13F review kickoff deferred to the scheduler.'); }
}), scheduleInitialChart: task => after(task) });
export const GET = handlers.GET;
export const POST = handlers.POST;
