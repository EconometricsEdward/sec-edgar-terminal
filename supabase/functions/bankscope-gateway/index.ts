/* global Deno */
import { createRemoteJWKSet,jwtVerify } from 'jose';
import { TRUST,createScopeGateway } from './handler.js';
const jwks=createRemoteJWKSet(new URL(`${TRUST.issuer}/.well-known/jwks`),{timeoutDuration:3000});
Deno.serve(createScopeGateway({env:name=>Deno.env.get(name),verify:async token=>{
  const {payload}=await jwtVerify(token,jwks,{algorithms:['RS256'],issuer:TRUST.issuer,audience:TRUST.audience,
    requiredClaims:['iss','aud','sub','iat','exp'],maxTokenAge:'2h',clockTolerance:5});return payload;
}}));
