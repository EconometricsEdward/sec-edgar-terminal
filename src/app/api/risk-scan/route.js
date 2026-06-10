import { NextResponse } from 'next/server';
import { fetchRecentFilings, fetchFilingText, buildFilingUrl } from '../../../utils/filingTextParser.js';
import { findRiskMatches, extractRiskExcerpt, RISK_CATEGORIES, getRiskCategory } from '../../../utils/riskKeywords.js';
import { getCached, setCached } from '../../../utils/kvCache.js';
import { getOperatingTickers } from '../../../utils/tickerMap.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

// nodejs runtime: shares the dynamic-import + timeout needs of crypto-scan
export const runtime = 'nodejs';
export const maxDuration = 60;

// Risk language lives in the core reports. Shallow depth keeps this fast and
// inside SEC rate limits — the goal is "recent red flags", not full history.
const SCAN_DEPTH = 12;
const SCAN_FORM_TYPES = ['10-K', '10-Q', '8-K', '10-K/A', '10-Q/A', 'NT 10-K', 'NT 10-Q', '20-F'];
const CACHE_NS = 'risk';
const CACHE_TTL = 60 * 60 * 12; // 12h — new filings get picked up twice a day
const MAX_FINDINGS = 25;
const MAX_EXCERPTS_PER_FILING = 3;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const ticker = String(searchParams.get('ticker') || '').trim().toUpperCase();

  if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) {
    return NextResponse.json(
      { error: 'invalid_ticker', message: 'Provide ?ticker= using 1\u201312 ticker characters.' },
      { status: 400 },
    );
  }

  // Rate limit: this endpoint fans out to SEC fetches on a cold cache
  const ip = getClientIp(request);
  const limit = await checkRateLimit({ key: `risk-scan:${ip}`, windowMs: 5 * 60 * 1000, max: 20 });
  if (!limit.ok) return rateLimitedResponse(limit);

  // Cache first — one scan serves everyone for 12 hours
  const cached = await getCached(CACHE_NS, ticker);
  if (cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  // Resolve CIK
  const map = await getOperatingTickers();
  const entry = map?.[ticker];
  const cik = entry?.cik || entry?.cik_str || null;
  if (!cik) {
    return NextResponse.json(
      { error: 'unknown_ticker', message: `No SEC-registered operating company found for ${ticker}.` },
      { status: 404 },
    );
  }

  const { filings, companyName, error: fetchErr } = await fetchRecentFilings(cik, SCAN_DEPTH, SCAN_FORM_TYPES);
  if (fetchErr) {
    return NextResponse.json(
      { error: 'fetch_failed', message: `Could not fetch filings: ${fetchErr}` },
      { status: 502 },
    );
  }

  const findings = [];
  const categoryCounts = new Map();

  await Promise.all(
    filings.map(async (f) => {
      // NT (late) filings are themselves a finding — no text scan needed
      if (/^NT\s+/i.test(f.form)) {
        findings.push({
          form: f.form,
          filingDate: f.filingDate,
          url: buildFilingUrl(cik, f.accession, f.primaryDoc),
          categoryId: 'late-filing',
          severity: 'high',
          excerpt: `${f.form} filed ${f.filingDate}: the company notified the SEC it could not file on time.`,
        });
        categoryCounts.set('late-filing', (categoryCounts.get('late-filing') || 0) + 1);
        return;
      }

      const { text, error } = await fetchFilingText(cik, f.accession, f.primaryDoc);
      if (error || !text) return;

      const matches = findRiskMatches(text);
      // One finding per category per filing (first occurrence) keeps the
      // result readable; counts still reflect every category hit.
      const seenCats = new Set();
      for (const m of matches) {
        categoryCounts.set(m.categoryId, (categoryCounts.get(m.categoryId) || 0) + 1);
        if (seenCats.has(m.categoryId) || seenCats.size >= MAX_EXCERPTS_PER_FILING) continue;
        seenCats.add(m.categoryId);
        findings.push({
          form: f.form,
          filingDate: f.filingDate,
          url: buildFilingUrl(cik, f.accession, f.primaryDoc),
          categoryId: m.categoryId,
          severity: m.severity,
          excerpt: extractRiskExcerpt(text, m.index),
          phrase: m.phrase,
        });
      }
    }),
  );

  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return new Date(b.filingDate).getTime() - new Date(a.filingDate).getTime();
  });

  const categories = [
    ...RISK_CATEGORIES.map((c) => ({ id: c.id, label: c.label, severity: c.severity, desc: c.desc, count: categoryCounts.get(c.id) || 0 })),
    { id: 'late-filing', label: 'Late filing notice', severity: 'high', desc: 'NT 10-K / NT 10-Q filed in the scanned window.', count: categoryCounts.get('late-filing') || 0 },
  ];

  const result = {
    ticker,
    companyName: companyName || entry?.name || null,
    scannedAt: new Date().toISOString(),
    filingsScanned: filings.length,
    formTypes: SCAN_FORM_TYPES,
    categories,
    findings: findings.slice(0, MAX_FINDINGS),
    methodology: 'Exact-phrase screen of recent core filings. A hit is a reading prompt, not a conclusion \u2014 always open the source.',
  };

  await setCached(CACHE_NS, ticker, result, CACHE_TTL);
  return NextResponse.json({ ...result, cached: false });
}
