/* global Deno */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { BANK_TRUST, createBankGateway } from './handler.js';
const jwks = createRemoteJWKSet(new URL(`${BANK_TRUST.issuer}/.well-known/jwks`), { timeoutDuration: 3000 });
Deno.serve(createBankGateway({ env: name => Deno.env.get(name), verify: async token => {
  const { payload } = await jwtVerify(token, jwks, { algorithms: ['RS256'], issuer: BANK_TRUST.issuer,
    audience: BANK_TRUST.audience, subject: BANK_TRUST.subject, requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'], maxTokenAge: '2h', clockTolerance: 5 });
  return payload;
} }));
