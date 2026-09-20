import { after } from 'next/server';
import { handleChatPost } from '../../../utils/chatServer.js';

export const runtime = 'nodejs';
export const maxDuration = 90;
export const dynamic = 'force-dynamic';

export async function POST(request) {
  return handleChatPost(request, { after });
}
