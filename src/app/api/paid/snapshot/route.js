import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { buildSnapshot, normalizeTicker } from '../../../../utils/secSnapshot.js';

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
const RESOURCE_ORIGIN = process.env.NEXT_PUBLIC_SITE_URL || 'https://secedgarterminal.com';
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const MEMO_PREFIX = 'EdgarSnapshot';
const MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);
function json(payload, init = {}) {
  return Response.json(payload, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
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

function resourceUrl(ticker, memo) {
  const params = new URLSearchParams({ ticker, memo });
  return `${RESOURCE_ORIGIN}/api/paid/snapshot?${params.toString()}`;
}

function paymentRequirements(ticker, memo) {
  const resource = resourceUrl(ticker, memo);
  return {
    x402Version: 1,
    protocol: 'solana-direct-memo',
    note: 'HTTP 402-style challenge using native SOL plus an exact memo. It does not require a facilitator.',
    resource,
    accepts: [
      {
        scheme: 'solana-native-memo',
        network: SOLANA_MAINNET_CAIP2,
        asset: 'native-sol',
        amount: String(PRICE_LAMPORTS),
        decimals: 9,
        priceSol: PRICE_SOL,
        payTo: RECIPIENT_ADDRESS,
        memo,
        retryUrl: resource,
        solanaPayUrl: solanaPayUrl(memo),
      },
    ],
    metadata: {
      product: 'EDGAR Terminal paid SEC snapshot API',
      description: 'Compact public SEC filing snapshot JSON for a ticker.',
      mimeType: 'application/json',
      input: { ticker },
      output: [
        'company identity',
        'CIK and SIC metadata',
        'recent 10-K, 10-Q, 8-K, proxy, and amendment filing rows',
        'source SEC URLs',
      ],
      docs: `${RESOURCE_ORIGIN}/paid-api`,
      openapi: `${RESOURCE_ORIGIN}/openapi.json`,
      llms: `${RESOURCE_ORIGIN}/llms.txt`,
    },
  };
}

function encodePaymentHeader(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function paymentRequired(ticker, memo, verification = null) {
  const requirements = paymentRequirements(ticker, memo);
  const retryUrl = `/api/paid/snapshot?ticker=${encodeURIComponent(ticker)}&memo=${encodeURIComponent(memo)}`;
  return json(
    {
      error: 'payment_required',
      product: 'EDGAR Terminal paid SEC snapshot API',
      ...requirements,
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
        'If your client has the confirmed transaction signature, pass it as ?signature=<tx_signature> or in PAYMENT-SIGNATURE.',
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
        'PAYMENT-REQUIRED': encodePaymentHeader(requirements),
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

function transactionVerification(transaction, memo, signature) {
  if (!transaction) {
    return {
      paid: false,
      signature,
      memo,
      reason: 'transaction_not_found',
      requiredLamports: PRICE_LAMPORTS,
    };
  }

  const lamports = lamportsToRecipient(transaction);
  const memoMatched = transactionHasMemo(transaction, memo);
  return {
    paid: memoMatched && lamports >= PRICE_LAMPORTS,
    signature,
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    memo,
    memoMatched,
    lamportsToRecipient: lamports,
    solToRecipient: lamports / LAMPORTS_PER_SOL,
    requiredLamports: PRICE_LAMPORTS,
  };
}

async function verifySignaturePayment(memo, signature) {
  const transaction = await rpc('getTransaction', [
    signature,
    {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    },
  ]);
  return transactionVerification(transaction, memo, signature);
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

    const verification = transactionVerification(transaction, memo, signatureInfo.signature);
    if (verification.paid) {
      return {
        ...verification,
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

function looksLikeSolanaSignature(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(value);
}

function decodePaymentSignatureHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};
  if (looksLikeSolanaSignature(raw)) return { signature: raw };

  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return {
      signature: String(
        parsed.signature ||
          parsed.txHash ||
          parsed.transactionSignature ||
          parsed.transaction ||
          '',
      ).trim(),
      memo: String(parsed.memo || parsed.requiredMemo || '').trim(),
    };
  } catch {
    return {};
  }
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

  const paymentHeader = decodePaymentSignatureHeader(
    request.headers.get('PAYMENT-SIGNATURE') ||
      request.headers.get('X-Payment-Signature') ||
      request.headers.get('X-Payment-TxHash') ||
      request.headers.get('X-Solana-Signature') ||
      '',
  );
  const memo = String(searchParams.get('memo') || paymentHeader.memo || '').trim();
  const signature = String(searchParams.get('signature') || paymentHeader.signature || '').trim();
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
  if (signature && !looksLikeSolanaSignature(signature)) {
    return json(
      {
        error: 'invalid_signature',
        message: 'Provide a base58 Solana transaction signature in the signature query parameter or PAYMENT-SIGNATURE header.',
      },
      { status: 400 },
    );
  }

  let verification;
  try {
    verification = signature
      ? await verifySignaturePayment(memo, signature)
      : await findPayment(memo);
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
