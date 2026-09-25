export class BankDataError extends Error {
  constructor(code, { retryAt = null, status = 503 } = {}) {
    super(`Bank data: ${code}`); this.name = 'BankDataError'; this.code = code; this.retryAt = retryAt; this.status = status;
  }
}
export function safeBankError(error) {
  return error instanceof BankDataError ? { code: error.code, retryAt: error.retryAt } : { code: 'internal_failure', retryAt: null };
}
export function isBankPreview(env = process.env) {
  return env.VERCEL_ENV === 'preview' && env.VERCEL_GIT_COMMIT_REF === 'feat/ffiec-bank-pilot';
}
