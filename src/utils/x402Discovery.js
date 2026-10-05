import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { X402_DISCOVERY_DESCRIPTORS, X402_OUTPUT_SCHEMAS, X402_SERVICE_METADATA } from './x402DiscoveryContracts.js';
export { X402_DISCOVERY_DESCRIPTORS, X402_OUTPUT_SCHEMAS, X402_SERVICE_METADATA } from './x402DiscoveryContracts.js';

export function x402DiscoveryOptions(resourceId, { format = 'json' } = {}) {
  const descriptor = X402_DISCOVERY_DESCRIPTORS[resourceId];
  if (!descriptor) throw new Error('Unknown x402 discovery resource');
  const { routePattern, tags, omitDiscoveryRouteTemplate, ...declaration } = structuredClone(descriptor);
  // Empty queries buy the documented starter selection. Once a caller supplies
  // any query field, the original required fields still apply as a group.
  if (declaration.inputSchema.required?.length) {
    const { required, ...schema } = declaration.inputSchema;
    declaration.inputSchema = { ...schema, anyOf: [{ maxProperties: 0 }, { required }] };
  }
  if (format !== 'json' && format !== 'csv') throw new Error('Unknown discovery format');
  if (format === 'csv') {
    if (!descriptor.inputSchema.properties.format) throw new Error('CSV is unavailable for this resource');
    declaration.input.format = 'csv';
  }
  const extensions = declareDiscoveryExtension(declaration);
  // The helper only retains an output schema alongside a sample. Publish a
  // schema-only output declaration instead of fabricating a financial record.
  const outputType = format === 'csv' ? 'text' : 'json';
  extensions.bazaar.info.output = { type: outputType };
  extensions.bazaar.schema.properties.output = {
    type: 'object',
    properties: {
      type: { type: 'string', const: outputType },
      example: format === 'csv' ? { type: 'string', description: 'RFC 4180 CSV. Header row and source, selection and snapshot context columns are included.' } : structuredClone(X402_OUTPUT_SCHEMAS[resourceId]),
    },
    required: ['type'],
    additionalProperties: false,
  };
  return { ...X402_SERVICE_METADATA, tags, routePattern, ...(omitDiscoveryRouteTemplate ? { omitDiscoveryRouteTemplate: true } : {}), extensions };
}
