import { createPeerApi } from '../../../../utils/bank/peerApi.js';
export const runtime='nodejs';
// GET reads the request URL at runtime; explicit public Data Cache entries remain enabled.
export const GET=createPeerApi();
