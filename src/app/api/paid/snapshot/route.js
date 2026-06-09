import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LAMPORTS_PER_SOL = 1_000_000_000;
const RECIPIENT_ADDRESS =
  process.env.PAID_SNAPSHOT_SOLANA_ADDRESS || 'CmkHJ5W6NS4A2icKRym5gqcMXYAL8eBPMZAWd4QfBGoS';
const CONFIGURED_PRICE_SOL = Number(process.env.PAID_SNAPSHOT_PRICE_SOL || '0.001');
const PRICE_SOL = Number.isFinite(CONFIGURED_PRICE_SOL) && CONFIGURED_PRICE_SOL > 0
  ? CONFIGURED_PRICE_SOL
  : 0.001;
const PRICE_LAMPORTS = Math.max(1, Math.ceil(PRICE_SOL * LAMPORTS_PER_SOL));
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const MEMO_PREFIX = 'EdgarSnapshot';
const MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);
const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT ||
  'EDGAR Terminal paid snapshot (https://secedgarterminal.com; public SEC data)';

function json(payload, init = {}) {
  return Response.json(payload, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) return '';
  return ticker;
}

function createMemo(ticker) {
  return `${MEMO_PREFIX}:${ticker}:${randomUUID().slice(0, 8)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidMemoForTicker(memo, ticker) {
  return new RegExp(`^${MEMO_PREFIX}:${escapeRegExp(ticker)}:[A-Za-z0-9-]{4,64}$`).test(memo);
}

function solanaPayUrl(memo) {
  const params = new URLSearchParams({
    label: 'EDGAR Terminal Snapshot',
    message: `Paid SEC snapshot ${memo}`,
    amount: String(PRICE_SOL),
    memo,
  });
  return `solana:${RECIPIENT_ADDRESS}?${params.toString()}`;
}

function paymentRequired(ticker, memo, verification = null) {
  const retryUrl = `/api/paid/snapshot?ticker=${encodeURIComponent(ticker)}&memo=${encodeURIComponent(memo)}`;
  return json(
    {
      error: 'payment_required',
      product: 'EDGAR Terminal paid SEC snapshot API',
      priceSol: PRICE_SOL,
      priceLamports: PRICE_LAMPORTS,
      recipient: RECIPIENT_ADDRESS,
      requiredMemo: memo,
      solanaPayUrl: solanaPayUrl(memo),
      retryUrl,
      verification,
      instructions: [
        'Send the exact SOL amount or more to the recipient address.',
        'Include the required memo exactly.',
        'Retry the endpoint with the same ticker and memo after confirmation.',
      ],
      boundaries: [
        'The response uses public SEC data only.',
        'This is research data, not investment, financial, legal, or tax advice.',
        'Payments are on-chain and public.',
      ],
    },
    {
      status: 402,
      headers: {
        'X-Payment-Required': 'Solana transfer with memo',
        'X-Payment-Recipient': RECIPIENT_ADDRESS,
        'X-Payment-Memo': memo,
      },
    },
  );
}

async function rpc(method, params) {
  const response = await fetch(SOLANA_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'EDGAR-Terminal-Paid-Snapshot/1.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `edgar-paid-${Date.now()}`,
      method,
      params,
    }),
    cache: 'no-store',
  });

  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message || `Solana RPC failed with HTTP ${response.status}`);
  }
  return payload.result;
}

function memoFromInstruction(instruction) {
  const programId =
    typeof instruction.programId === 'string'
      ? instruction.programId
      : instruction.programId?.toString?.();
  if (instruction.program !== 'spl-memo' && !MEMO_PROGRAMS.has(programId)) return '';
  if (typeof instruction.parsed === 'string') return instruction.parsed;
  if (typeof instruction.data === 'string') return instruction.data;
  return '';
}

function transactionHasMemo(transaction, memo) {
  const instructions = transaction?.transaction?.message?.instructions || [];
  return instructions.some((instruction) => memoFromInstruction(instruction) === memo);
}

function lamportsToRecipient(transaction) {
  const instructions = transaction?.transaction?.message?.instructions || [];
  let lamports = 0;

  for (const instruction of instructions) {
    const parsed = instruction.parsed;
    if (!parsed || parsed.type !== 'transfer') continue;
    if (parsed.info?.destination === RECIPIENT_ADDRESS) {
      lamports += Number(parsed.info?.lamports || 0);
    }
  }

  return lamports;
}

async function findPayment(memo) {
  const signatures = await rpc('getSignaturesForAddress', [
    RECIPIENT_ADDRESS,
    { limit: 50, commitment: 'confirmed' },
  ]);

  for (const signatureInfo of signatures || []) {
    const transaction = await rpc('getTransaction', [
      signatureInfo.signature,
      {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (!transaction || !transactionHasMemo(transaction, memo)) continue;

    const lamports = lamportsToRecipient(transaction);
    if (lamports >= PRICE_LAMPORTS) {
      return {
        paid: true,
        signature: signatureInfo.signature,
        slot: signatureInfo.slot,
        blockTime: transaction.blockTime,
        memo,
        lamportsToRecipient: lamports,
        solToRecipient: lamports / LAMPORTS_PER_SOL,
        signaturesChecked: (signatures || []).length,
      };
    }
  }

  return {
    paid: false,
    memo,
    signaturesChecked: (signatures || []).length,
    requiredLamports: PRICE_LAMPORTS,
  };
}

async function secJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': SEC_USER_AGENT,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`SEC returned ${response.status} for ${url}`);
  return response.json();
}

function filingUrl(cik, accessionNumber, primaryDocument) {
  const cikInt = String(Number(cik));
  const accessionCompact = String(accessionNumber || '').replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accessionCompact}/${primaryDocument}`;
}

async function buildSnapshot(ticker) {
  const tickerMap = await secJson('https://www.sec.gov/files/company_tickers.json');
  const entry = Object.values(tickerMap).find((row) => row.ticker?.toUpperCase() === ticker);
  if (!entry) {
    return {
      ticker,
      found: false,
      message: 'Ticker was not found in the SEC company_tickers.json file.',
    };
  }

  const cik = String(entry.cik_str).padStart(10, '0');
  const submissions = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const recent = submissions.filings?.recent || {};
  const rows = [];
  const forms = recent.form || [];

  for (let index = 0; index < forms.length && rows.length < 20; index += 1) {
    const form = forms[index];
    if (!['10-K', '10-Q', '8-K', 'DEF 14A', '10-K/A', '10-Q/A'].includes(form)) continue;
    rows.push({
      form,
      filingDate: recent.filingDate?.[index] || '',
      reportDate: recent.reportDate?.[index] || '',
      accessionNumber: recent.accessionNumber?.[index] || '',
      primaryDocument: recent.primaryDocument?.[index] || '',
      sourceUrl: filingUrl(cik, recent.accessionNumber?.[index], recent.primaryDocument?.[index]),
    });
  }

  return {
    ticker,
    found: true,
    cik,
    companyName: submissions.name || entry.title,
    sic: submissions.sic || null,
    sicDescription: submissions.sicDescription || null,
    fiscalYearEnd: submissions.fiscalYearEnd || null,
    entityType: submissions.entityType || null,
    latestFilings: rows,
    source: {
      tickerMap: 'https://www.sec.gov/files/company_tickers.json',
      submissions: `https://data.sec.gov/submissions/CIK${cik}.json`,
    },
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const ticker = normalizeTicker(searchParams.get('ticker'));
  if (!ticker) {
    return json(
      {
        error: 'invalid_ticker',
        message: 'Provide a ticker query parameter using 1-12 ticker characters.',
        example: '/api/paid/snapshot?ticker=AAPL',
      },
      { status: 400 },
    );
  }

  const memo = String(searchParams.get('memo') || '').trim();
  if (!memo) return paymentRequired(ticker, createMemo(ticker));
  if (!isValidMemoForTicker(memo, ticker)) {
    return json(
      {
        error: 'invalid_memo',
        message: `Memo must match ${MEMO_PREFIX}:${ticker}:<nonce>.`,
      },
      { status: 400 },
    );
  }

  let verification;
  try {
    verification = await findPayment(memo);
  } catch (error) {
    return json(
      {
        error: 'payment_verification_unavailable',
        message: error.message,
      },
      { status: 503 },
    );
  }

  if (!verification.paid) return paymentRequired(ticker, memo, verification);

  try {
    const snapshot = await buildSnapshot(ticker);
    return json({
      status: 'paid',
      product: 'EDGAR Terminal paid SEC snapshot API',
      payment: verification,
      snapshot,
      boundaries: [
        'Public SEC data only.',
        'For research and educational use only.',
        'Not investment, financial, legal, or tax advice.',
      ],
    });
  } catch (error) {
    return json(
      {
        error: 'snapshot_failed',
        message: error.message,
        payment: verification,
      },
      { status: 502 },
    );
  }
}
