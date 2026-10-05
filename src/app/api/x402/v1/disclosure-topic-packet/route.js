import { createPaidProductRoute, createPaidProductHead } from '../../../../../utils/x402ProductRoute.js';
import { paidDisclosureTopicPacketSelection, paidDisclosureTopicPacketReader } from '../../../../../utils/x402DisclosureTopicPacket.js';
import { x402DataOptions } from '../../../../../utils/x402Research.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
export const GET = createPaidProductRoute('disclosure-topic-packet', null, 'A bounded issuer dossier of literal disclosure topics, full original paragraphs, filing and section references, and per-topic extraction coverage.', { select: paidDisclosureTopicPacketSelection, read: paidDisclosureTopicPacketReader });
export const OPTIONS = x402DataOptions;
export const HEAD = createPaidProductHead('disclosure-topic-packet', { select: paidDisclosureTopicPacketSelection });
