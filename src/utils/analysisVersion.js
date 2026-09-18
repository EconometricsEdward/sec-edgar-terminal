import { FINANCIAL_DATA_VERSION } from "./xbrlPeriods.js";
// The response/storage schema is shared with the prepared-data gateway.
// Mapping revisions invalidate calculation payloads without changing that
// reviewed storage-key contract or its access controls.
export const ANALYSIS_VERSION = `analysis-v1.4:${FINANCIAL_DATA_VERSION}`;
export const ANALYSIS_MAPPING_VERSION = "analysis-mappings-v2";
