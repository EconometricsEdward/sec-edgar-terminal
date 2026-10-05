import { createPaidHandler, createX402DiscoveryHead } from './x402Payments.js';
import { x402Ledger } from './x402Ledger.js';
import { x402DiscoveryOptions } from './x402Discovery.js';
import { paidProductSelection, paidProductReaders } from './x402Products.js';
import { x402DataError } from './x402Research.js';
import { X402_RESOURCES } from './x402Catalog.js';

const starterKinds = new Set(['financial-batch', 'financial-changes', 'disclosure-evidence',
  'institutional-overlap', 'disclosure-topic-packet', 'bank-risk-batch']);
const starterRequest = (request, kind) => starterKinds.has(kind) && new URL(request.url).searchParams.size === 0;

/** Only an empty query uses the public starter example; explicit selections stay strict. */
export function resolvePaidProductSelection(request, kind, select = candidate => paidProductSelection(candidate, kind)) {
  if (!starterRequest(request, kind)) return select(request);
  const resource = X402_RESOURCES.find(resource => resource.id === kind);
  if (!resource?.example) return null;
  // This request exists only for the pure selector. Payment verification, replay
  // protection and settlement always receive the buyer's original request URL.
  const selectionRequest = new Request(new URL(resource.example, request.url), { method: request.method, headers: request.headers });
  return select(selectionRequest);
}

function starterDescription(kind, description) {
  const resource = X402_RESOURCES.find(resource => resource.id === kind);
  return `${description} The URL without query parameters uses the documented starter selection: ${resource.example}.`;
}

/** Validate selections before any buyer proof, and advertise the selected format. */
export function createPaidProductRoute(kind, reader, description, { select = request => paidProductSelection(request, kind), read, createHandler = createPaidHandler } = {}) {
  const handlers = new Map();
  return function GET(request) {
    const starter = starterRequest(request, kind);
    const selection = resolvePaidProductSelection(request, kind, select);
    if (!selection) return x402DataError('INVALID_SELECTION', 'Use the documented product parameters once, with valid nonempty values. See /data-access and /openapi.json.');
    const key = `${selection.format}:${starter ? 'starter' : 'selected'}`;
    if (!handlers.has(key)) handlers.set(key, createHandler(
      (_request, context) => read ? read(context.selection) : paidProductReaders[reader](context.selection), {
        description: starter ? starterDescription(kind, description) : description,
        ...x402DiscoveryOptions(kind, { format: selection.format }),
        mimeType: selection.format === 'csv' ? 'text/csv' : 'application/json',
        allowCsv: true,
        ledger: x402Ledger,
      },
    ));
    return handlers.get(key)(request, { selection });
  };
}

/** HEAD advertises the same starter or explicit selection contract as GET. */
export function createPaidProductHead(kind, { select = request => paidProductSelection(request, kind), description } = {}) {
  const handlers = new Map();
  return function HEAD(request, ...args) {
    const format = new URL(request.url).searchParams.get('format') === 'csv' ? 'csv' : 'json';
    const starter = starterRequest(request, kind);
    const key = `${format}:${starter ? 'starter' : 'selected'}`;
    const baseDescription = description || 'Unpaid discovery metadata for this prepared GET product.';
    if (!handlers.has(key)) handlers.set(key, createX402DiscoveryHead({
      description: starter ? starterDescription(kind, baseDescription) : baseDescription,
      ...x402DiscoveryOptions(kind, { format }),
      mimeType: format === 'csv' ? 'text/csv' : 'application/json',
      allowCsv: true,
      validate: candidate => !resolvePaidProductSelection(candidate, kind, select)
        ? x402DataError('INVALID_SELECTION', 'Use the documented GET parameters once, with valid nonempty values. See /data-access and /openapi.json.') : null,
    }));
    return handlers.get(key)(request, ...args);
  };
}
