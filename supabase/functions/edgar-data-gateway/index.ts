/* global Deno */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createGateway, createJwtVerifier, TRUST } from './handler.js';

// The issuer and JWKS destination are deployment configuration, never derived
// from an unverified token. Cache public verification keys, never bearer tokens.
const jwks = createRemoteJWKSet(new URL(`${TRUST.issuer}/.well-known/jwks`), {
  timeoutDuration: 2500,
  cooldownDuration: 30000,
  cacheMaxAge: 600000,
});

Deno.serve(createGateway({
  env: (name: string) => Deno.env.get(name),
  verifyToken: createJwtVerifier(jwtVerify, jwks),
}));
