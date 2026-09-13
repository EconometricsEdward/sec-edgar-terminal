/** Provider-free rollback switch. CFTC is enabled unless explicitly disabled. */
export function isCftcEnabled(env = process.env) {
  return !['0', 'false'].includes(String(env?.CFTC_ENABLED ?? '').trim().toLowerCase());
}
