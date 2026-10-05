import { createPaidHandler, createX402DiscoveryHead } from './x402Payments.js';
import { x402Ledger } from './x402Ledger.js';
import { x402DiscoveryOptions } from './x402Discovery.js';
import { paidProductSelection, paidProductReaders } from './x402Products.js';
import { x402DataError } from './x402Research.js';

/** Validate selections before any buyer proof, and advertise the selected format. */
export function createPaidProductRoute(kind, reader, description, { select = request => paidProductSelection(request, kind), read } = {}) {
  const handlers = new Map();
  return function GET(request) {
    const selection = select(request);
    if (!selection) return x402DataError('INVALID_SELECTION', 'Use the documented product parameters once, with valid nonempty values. See /data-access and /openapi.json.');
    if (!handlers.has(selection.format)) handlers.set(selection.format, createPaidHandler(
      (_request, context) => read ? read(context.selection) : paidProductReaders[reader](context.selection), {
        description,
        ...x402DiscoveryOptions(kind, { format: selection.format }),
        mimeType: selection.format === 'csv' ? 'text/csv' : 'application/json',
        allowCsv: true,
        ledger: x402Ledger,
      },
    ));
    return handlers.get(selection.format)(request, { selection });
  };
}

/** Bare HEAD advertises required GET selectors; query-bearing probes keep the exact selector contract. */
export function createPaidProductHead(kind, { select = request => paidProductSelection(request, kind), description } = {}) {
  const handlers = new Map();
  return function HEAD(request, ...args) {
    const format = new URL(request.url).searchParams.get('format') === 'csv' ? 'csv' : 'json';
    if (!handlers.has(format)) handlers.set(format, createX402DiscoveryHead({
      description: description || 'Unpaid discovery metadata for this prepared GET product. Supply its documented required query parameters to request data.',
      ...x402DiscoveryOptions(kind, { format }),
      mimeType: format === 'csv' ? 'text/csv' : 'application/json',
      allowCsv: true,
      validate: candidate => new URL(candidate.url).searchParams.size && !select(candidate)
        ? x402DataError('INVALID_SELECTION', 'Use the documented GET parameters once, with valid nonempty values. See /data-access and /openapi.json.') : null,
    }));
    return handlers.get(format)(request, ...args);
  };
}
