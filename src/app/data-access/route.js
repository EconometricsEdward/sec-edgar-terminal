import { getX402PublicConfiguration } from '../../utils/x402Payments.js';
import { getX402LivePublicConfiguration } from '../../utils/x402SolanaRecipient.js';
import { createX402DocumentationHandlers } from '../../utils/x402Documentation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handlers = createX402DocumentationHandlers(async () =>
  getX402LivePublicConfiguration(getX402PublicConfiguration()));

export const GET = handlers.GET;
export const HEAD = handlers.HEAD;
export const OPTIONS = handlers.OPTIONS;
