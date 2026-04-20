// ============================================================================
// filingTextParser — Fetches SEC filings and extracts plain text for scanning
//
// Handles:
//   - SEC rate limiting (10 req/sec max per SEC policy)
//   - Required User-Agent header (SEC blocks requests without it)
//   - HTML stripping (inline tags, scripts, styles removed)
//   - XBRL-tagged HTML (preserves text, drops tags)
//   - Error handling (timeouts, 404s, parser failures)
//
// Does NOT handle:
//   - PDFs (rare in modern filings, skipped)
//   - Binary attachments (images, Excel files)
// ============================================================================

// SEC requires a descriptive User-Agent with contact info.
// This is reused from our existing secApi setup — if your env has a different
// agent, pass it in.
const DEFAULT_USER_AGENT = 'SEC EDGAR Terminal research@secedgarterminal.com';

// SEC rate limit: 10 requests per second. We use 8 to be safe.
const MAX_CONCURRENT = 4;   // Parallel requests
const REQUEST_DELAY_MS = 125; // ~8 req/sec

/**
 * Simple semaphore for controlling concurrency.
 */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.active--;
    if (this.queue.length > 0) {
      this.active++;
      const next = this.queue.shift();
      next();
    }
  }
}

const semaphore = new Semaphore(MAX_CONCURRENT);

/**
 * Sleep helper for rate limiting.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a URL with SEC-compliant headers and rate limiting.
 *
 * @param {string} url
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<Response|null>}
 */
async function fetchSec(url, timeoutMs = 15000) {
  await semaphore.acquire();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      headers: {
        'User-Agent': process.env.SEC_USER_AGENT || DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    // Small delay to stay under rate limit
    await sleep(REQUEST_DELAY_MS);

    return res;
  } catch (err) {
    return null;
  } finally {
    semaphore.release();
  }
}

/**
 * Strip HTML tags and convert entities to plain text.
 * Reasonably robust — handles scripts, styles, inline tags, entities.
 *
 * NOT a full HTML parser (no DOM). Good enough for keyword scanning.
 */
export function stripHtml(html) {
  if (!html) return '';

  let text = html;

  // Remove scripts, styles, and comments entirely
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  // Replace block-level tags with double newlines (preserves paragraph boundaries)
  const blockTags = '(?:p|div|section|article|header|footer|table|tr|td|th|li|ul|ol|h[1-6]|br|hr)';
  text = text.replace(new RegExp(`</${blockTags}\\s*>`, 'gi'), '\n\n');
  text = text.replace(new RegExp(`<br\\s*/?>`, 'gi'), '\n');

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  const entities = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
    '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#34;': '"',
    '&ndash;': '–', '&mdash;': '—', '&hellip;': '…',
    '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&rdquo;': '\u201D', '&ldquo;': '\u201C',
    '&trade;': '™', '&reg;': '®', '&copy;': '©',
  };
  text = text.replace(/&\w+;/g, (m) => entities[m] || ' ');
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

  // Normalize whitespace (but preserve paragraph breaks)
  text = text.replace(/[ \t]+/g, ' ');           // collapse spaces/tabs
  text = text.replace(/\n[ \t]+/g, '\n');         // trim line starts
  text = text.replace(/[ \t]+\n/g, '\n');         // trim line ends
  text = text.replace(/\n{3,}/g, '\n\n');         // max 2 consecutive newlines

  return text.trim();
}

/**
 * Build the URL for a filing's primary document.
 *
 * @param {string} cik - CIK (will be stripped of leading zeros)
 * @param {string} accession - Accession number (with hyphens)
 * @param {string} primaryDoc - Primary document filename from submissions API
 * @returns {string}
 */
export function buildFilingUrl(cik, accession, primaryDoc) {
  const cikInt = parseInt(cik, 10);
  const accnClean = accession.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accnClean}/${primaryDoc}`;
}

/**
 * Fetch a single filing document and return its plain text.
 *
 * @param {string} cik
 * @param {string} accession
 * @param {string} primaryDoc
 * @returns {Promise<{text: string, url: string, sizeBytes: number, error?: string}>}
 */
export async function fetchFilingText(cik, accession, primaryDoc) {
  const url = buildFilingUrl(cik, accession, primaryDoc);

  // Skip non-text documents (PDFs, images, Excel files)
  const lowerDoc = (primaryDoc || '').toLowerCase();
  if (lowerDoc.endsWith('.pdf') || lowerDoc.endsWith('.xlsx') ||
      lowerDoc.endsWith('.xls') || lowerDoc.endsWith('.jpg') ||
      lowerDoc.endsWith('.png') || lowerDoc.endsWith('.gif')) {
    return { text: '', url, sizeBytes: 0, error: `Skipped non-text format: ${lowerDoc.split('.').pop()}` };
  }

  const res = await fetchSec(url);
  if (!res) {
    return { text: '', url, sizeBytes: 0, error: 'Network error or timeout' };
  }
  if (!res.ok) {
    return { text: '', url, sizeBytes: 0, error: `HTTP ${res.status}` };
  }

  try {
    const html = await res.text();
    const text = stripHtml(html);
    return {
      text,
      url,
      sizeBytes: html.length,
    };
  } catch (err) {
    return { text: '', url, sizeBytes: 0, error: `Parse error: ${err.message}` };
  }
}

/**
 * Fetch the most recent N filings for a company.
 *
 * @param {string} cik - CIK (padded 10-digit form)
 * @param {number} [maxFilings=50] - Max filings to return
 * @param {Array<string>} [formTypes] - Optional filter (e.g. ['10-K', '10-Q', '8-K'])
 * @returns {Promise<{filings: Array, companyName: string|null, error?: string}>}
 */
export async function fetchRecentFilings(cik, maxFilings = 50, formTypes = null) {
  const cikPadded = String(cik).padStart(10, '0');
  const url = `https://data.sec.gov/submissions/CIK${cikPadded}.json`;

  const res = await fetchSec(url);
  if (!res || !res.ok) {
    return { filings: [], companyName: null, error: res ? `HTTP ${res.status}` : 'Network error' };
  }

  try {
    const data = await res.json();
    const recent = data.filings?.recent;
    if (!recent) return { filings: [], companyName: data.name || null };

    const filings = [];
    for (let i = 0; i < recent.accessionNumber.length; i++) {
      const form = recent.form[i];
      if (formTypes && !formTypes.some((t) => form === t || form.startsWith(t))) continue;

      filings.push({
        accession: recent.accessionNumber[i],
        form,
        filingDate: recent.filingDate[i],
        reportDate: recent.reportDate[i],
        primaryDoc: recent.primaryDocument[i],
        primaryDescription: recent.primaryDocDescription?.[i] || '',
      });

      if (filings.length >= maxFilings) break;
    }

    return { filings, companyName: data.name };
  } catch (err) {
    return { filings: [], companyName: null, error: `Parse error: ${err.message}` };
  }
}
