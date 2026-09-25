export const TRUST={issuer:'https://oidc.vercel.com/econometricsedwards-projects',audience:'https://vercel.com/econometricsedwards-projects',
  ownerId:'team_EEZpsSbH41QqVl83n2OJmLob',projectId:'prj_tjTGC2omKa1JOT7il31bFZ8ilk8f'};
const PROJECT='https://vvkihuduqqnxqahhbphs.supabase.co';
const OPS=new Set(['status','search','read','source','lineage','request','begin','reserve','cooldown','periods','catalog','claim','publish','job_error','finish','peer_status','peer_universe','peer_history','peer_start','peer_batch','peer_complete','ubpr_read','ubpr_source','ubpr_claim','ubpr_save','ubpr_error']);
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export function validScopeClaims(p,now=Date.now()) {
  return ['production','preview'].includes(p?.environment)&&p.iss===TRUST.issuer&&p.aud===TRUST.audience
    &&p.sub===`owner:econometricsedwards-projects:project:sec-edgar-terminal:environment:${p.environment}`
    &&p.owner_id===TRUST.ownerId&&p.project_id===TRUST.projectId&&Number.isInteger(p.iat)&&Number.isInteger(p.exp)
    &&p.iat<=now/1000+5&&p.exp>now/1000-5&&p.exp>p.iat&&p.exp-p.iat<=7205&&now/1000-p.iat<=7205;
}
export function createScopeGateway({verify,env,fetchImpl=fetch}) {
  return async request=>{
    try {
      if(request.method!=='POST')return reply({code:'method_not_allowed'},405);
      const auth=request.headers.get('authorization')||'';
      if(!/^Bearer [A-Za-z0-9_.-]{20,16384}$/.test(auth))return reply({code:'unauthorized'},401);
      let claims;try{claims=await verify(auth.slice(7));}catch{return reply({code:'unauthorized'},401);}
      if(!validScopeClaims(claims))return reply({code:'unauthorized'},401);
      const reader=request.body?.getReader();if(!reader)return reply({code:'invalid_payload'},400);
      let size=0;const chunks=[];
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>12000000)return reply({code:'body_too_large'},413);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return reply({code:'invalid_payload'},400);}
      if(!OPS.has(body.operation)||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload)||Object.keys(body).some(k=>!['operation','payload'].includes(k)))return reply({code:'invalid_operation'},400);
      if(env('SUPABASE_URL')?.replace(/\/$/,'')!==PROJECT)return reply({code:'gateway_unavailable'},503);
      const key=env('SUPABASE_SERVICE_ROLE_KEY');if(!key)return reply({code:'gateway_unavailable'},503);
      const r=await fetchImpl(`${PROJECT}/rest/v1/rpc/bank_scope_operation`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
        body:JSON.stringify({p_operation:body.operation,p_payload:body.payload}),redirect:'error',signal:AbortSignal.timeout(22000)});
      if(!r.ok)return reply({code:'database_failure'},503);return reply(await r.json());
    }catch{return reply({code:'database_failure'},503);}
  };
}
