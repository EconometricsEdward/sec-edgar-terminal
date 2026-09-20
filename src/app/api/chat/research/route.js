import { handleBrowserResearchPost } from '../../../../utils/chatBrowserServer.js';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(request) {
  return handleBrowserResearchPost(request);
}
