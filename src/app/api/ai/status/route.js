import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Tells the client whether AI summaries are available in this deployment.
// The feature is entirely opt-in via the ANTHROPIC_API_KEY env var — without
// it, the UI never renders an AI button and the site behaves as before.
export async function GET() {
  return NextResponse.json(
    { enabled: Boolean(process.env.ANTHROPIC_API_KEY) },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
