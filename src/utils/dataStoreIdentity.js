/** Request-scoped workload credentials. Never expose or cache these in responses. */
export async function getDataStoreIdentityToken() {
  if (typeof window !== 'undefined' || process.env.VERCEL_ENV !== 'production') {
    throw new Error('Production workload identity required.');
  }
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const token = await getVercelOidcToken();
  if (typeof token !== 'string' || token.length > 16384 || token.split('.').length !== 3) {
    throw new Error('Workload identity unavailable.');
  }
  return token;
}
