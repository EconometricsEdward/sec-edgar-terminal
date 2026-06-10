import { NextResponse } from 'next/server';
import { fetchFilingText, buildFilingUrl } from '../../../../utils/filingTextParser.js';
import { getCached, setCached } from '../../../../utils/kvCache.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ============================================================================
// AI filing summaries
//
// Economics that keep this safe to run on a free site:
//   - Filings are immutable → cache by accession number for 60 days, so each
//     document costs ONE model call ever, shared by every visitor.
//   - Per-IP rate limit prevents someone scripting the endpoint into a bill.
//   - Disabled entirely unless ANTHROPIC_API_KEY is set; site works without it.
//
// Trust posture matches the site's ethos: the summary always ships with the
// source link, and the prompt forbids advice/opinions.
// ============================================================================

const MODEL = process.env.AI_SUMMARY_MODEL || 'claude-haiku-4-5-20251001';
const MAX_INPUT_CHARS = 16000;
const CACHE_NS = 'aisum';
const CACHE_TTL = 60 * 60 * 24 * 60; // 60 days
const RATE = { windowMs: 10 * 60 * 1000, max: 8 }; // 8 summaries / 10 min / IP

const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;
const PRIMARYDOC_RE = /^[\w][\w./-]{0,180}$/;
const CIK_RE = /^\d{1,10}$/;

const SYSTEM_PROMPT = [
  'You summarize a single SEC filing for a finance-literate reader.',
  'Output exactly three labeled sections in plain text, no markdown:',
  'WHAT HAPPENED \u2014 2-3 sentences on the substance of this filing.',
  'KEY NUMBERS \u2014 the few figures that matter, with periods. If none, say "None disclosed in this document."',
  'WORTH NOTING \u2014 anything a careful reader should check in the source (risks, changes, caveats).',
  'Rules: only state what the document supports; no investment advice, predictions, or opinions;',
  'if the provided text appears truncated, say so in WORTH NOTING.',
].join(' ');

export async function POST(request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ enabled: false, error: 'ai_disabled' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }

  const cik = String(body?.cik || '').replace(/^0+/, '') || '0';
  const accession = String(body?.accession || '').trim();
  const primaryDoc = String(body?.primaryDoc || '').trim();
  const form = String(body?.form || '').slice(0, 20);
  const ticker = String(body?.ticker || '').slice(0, 12).toUpperCase();

  if (!CIK_RE.test(cik) || !ACCESSION_RE.test(accession) || !PRIMARYDOC_RE.test(primaryDoc) || primaryDoc.includes('..')) {
    return NextResponse.json(
      { error: 'bad_request', message: 'cik, accession, and primaryDoc are required and must match SEC formats.' },
      { status: 400 },
    );
  }

  // The SEC URL is constructed server-side from validated parts — the client
  // never controls what host we fetch.
  const sourceUrl = buildFilingUrl(cik, accession, primaryDoc);

  // Cache hit = free for everyone, instantly
  const cached = await getCached(CACHE_NS, accession);
  if (cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  const ip = getClientIp(request);
  const limit = await checkRateLimit({ key: `aisum:${ip}`, windowMs: RATE.windowMs, max: RATE.max });
  if (!limit.ok) return rateLimitedResponse(limit);

  const { text, error: textErr } = await fetchFilingText(cik, accession, primaryDoc);
  if (textErr || !text) {
    return NextResponse.json(
      { error: 'source_unavailable', message: textErr || 'Could not read the filing text.', sourceUrl },
      { status: 502 },
    );
  }

  const truncated = text.length > MAX_INPUT_CHARS;
  const input = truncated ? text.slice(0, MAX_INPUT_CHARS) : text;

  let summary;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Filing: ${form || 'SEC filing'}${ticker ? ` for ${ticker}` : ''}. ${
              truncated ? 'NOTE: text below is truncated to the opening section of the document. ' : ''
            }Document text:\n\n${input}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn('[ai/summarize] upstream error', res.status, detail.slice(0, 300));
      return NextResponse.json({ error: 'model_error', status: res.status }, { status: 502 });
    }

    const data = await res.json();
    summary = (data?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  } catch (err) {
    return NextResponse.json({ error: 'model_unreachable', message: err.message }, { status: 502 });
  }

  if (!summary) {
    return NextResponse.json({ error: 'empty_summary' }, { status: 502 });
  }

  const result = {
    summary,
    model: MODEL,
    truncatedInput: truncated,
    sourceUrl,
    accession,
    generatedAt: new Date().toISOString(),
    disclaimer: 'AI-generated from the source filing. Verify against the document before relying on it. Not investment advice.',
  };

  await setCached(CACHE_NS, accession, result, CACHE_TTL);
  return NextResponse.json({ ...result, cached: false });
}
