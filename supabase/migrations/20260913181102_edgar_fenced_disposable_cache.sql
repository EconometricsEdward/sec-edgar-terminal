-- Reuse canonical claim identity for the small existing set of generation-
-- fenced cache mirrors. No coordination table or archive rewrite is introduced.
-- A publication clears the active owner, but its captured cache claim remains
-- usable until the original deadline or the next canonical generation begins.
alter table public.edgar_dataset_heads add column cache_claim jsonb
  check(cache_claim is null or (jsonb_typeof(cache_claim)='object' and octet_length(cache_claim::text)<=512));
alter table edgar_private.cache_entries add column cache_guard jsonb
  check(cache_guard is null or coalesce((jsonb_typeof(cache_guard)='object' and octet_length(cache_guard::text)<=768
    and cache_guard-'dataset'-'key'='{}'::jsonb
    and cache_guard->>'dataset' in ('sec','financial','cftc') and length(cache_guard->>'key') between 1 and 512),false));

-- Move the original implementation intact. Public callers must use one of the
-- explicit wrappers; no transaction setting can bypass guard checks.
alter function public.edgar_cache_put(text,text,text,text,text,text,text,integer,integer,text,timestamptz) set schema edgar_private;
alter function edgar_private.edgar_cache_put(text,text,text,text,text,text,text,integer,integer,text,timestamptz) rename to cache_put_payload;
revoke all on function edgar_private.cache_put_payload(text,text,text,text,text,text,text,integer,integer,text,timestamptz)
  from public,anon,authenticated;
grant execute on function edgar_private.cache_put_payload(text,text,text,text,text,text,text,integer,integer,text,timestamptz) to service_role;

create function edgar_private.cache_claim_valid(p_claim jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_typeof(p_claim)='object' and p_claim-'generation'-'owner'='{}'::jsonb
    and p_claim->>'owner' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and p_claim->>'owner'<>'00000000-0000-0000-0000-000000000000'
    and p_claim->>'generation' ~ '^[1-9][0-9]{0,18}$'
    and (length(p_claim->>'generation')<19 or p_claim->>'generation'<='9223372036854775807'),false)
$$;

-- Exact existing mirror mappings, including the four original SEC pilot CIKs.
-- The gateway applies the same mapping and existing canonical admission rules.
create function edgar_private.cache_fence_target(p_dataset text,p_key text,p_family text,p_type text,p_id text)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare scope text[]; raw_scope text[]; pilot_ticker text; group_name text;
begin
  if p_dataset is null or p_family is null or p_type is null or p_key is null or length(p_key)>512
    or p_id is null or p_id<>upper(p_id) then return false; end if;
  if p_dataset='cftc' and p_family='history' and p_type='edgar.cftc-positioning.v1:production' then
    scope:=regexp_match(p_key,'^markets:(tff|disaggregated):(latest|[0-9]{4}-[0-9]{2}-[0-9]{2})$');
    if scope is not null then
      if p_id=upper(p_key) or p_id=upper(regexp_replace(p_key,'^markets:','markets-last-good:')) then return true; end if;
      raw_scope:=regexp_match(p_id,'^RAW-HISTORY:(TFF|DISAGGREGATED):[A-Z0-9+]{3,12}:([0-9]{4}-[0-9]{2}-[0-9]{2})$');
      return coalesce(raw_scope[1]=upper(scope[1]) and (scope[2]='latest' or raw_scope[2]=scope[2]),false);
    end if;
    scope:=regexp_match(p_key,'^history:(tff|disaggregated):([A-Z0-9+]{3,12}):([a-z-]{3,32}):([0-9]{4}-[0-9]{2}-[0-9]{2}):(1y|3y|5y)$');
    if scope is null then return false; end if;
    group_name:=scope[3];
    if not((scope[1]='tff' and group_name in ('dealer','asset-manager','leveraged-funds','other-reportables','non-reportables'))
      or(scope[1]='disaggregated' and group_name in ('producer-merchant','swap-dealers','managed-money','other-reportables','non-reportables')))
      then return false; end if;
    if p_id=upper(p_key) or p_id=upper(regexp_replace(p_key,'^history:','history-last-good:')) then return true; end if;
    return p_id=upper('raw-history:'||scope[1]||':'||scope[2]||':'||scope[4]);
  end if;
  if p_family<>'research' then return false; end if;
  if p_dataset='sec' then
    scope:=regexp_match(p_key,'^sec-documents-v1:CIK(0000320193|0000789019|0000019617|0000002098):(submissions|companyfacts)$');
    if scope is null then return false; end if;
    if p_type='submissions-cik' then return scope[2]='submissions' and p_id=scope[1]; end if;
    return p_type='research-sec-v1' and p_id=upper(case when scope[2]='submissions' then '/submissions/CIK'||scope[1]||'.json'
      else '/api/xbrl/companyfacts/CIK'||scope[1]||'.json' end);
  end if;
  if p_dataset<>'financial' then return false; end if;
  if p_type='analysis-research' then
    scope:=regexp_match(p_key,'^financial-analysis-v1:analysis-v1\.4:context-v3:CIK(0000320193|0000789019|0000019617|0000002098):(annual|quarter|ytd|ttm):latest$');
    if scope is null then return false; end if;
    pilot_ticker:=case scope[1] when '0000320193' then 'AAPL' when '0000789019' then 'MSFT' when '0000019617' then 'JPM' else 'ACU' end;
    return p_id='ANALYSIS-V1.4:CONTEXT-V3:'||pilot_ticker||':'||upper(scope[2])||':';
  end if;
  if p_type='research-serving-v1' then
    return p_id=upper(p_key) and (
      p_key ~ '^research-compare-v1:compare-v2:context-v3:CIK(0000320193|0000789019|0000019617|0000002098):(annual|quarter|ttm):latest$'
      or p_key ~ '^research-portfolio-v1:analysis-v1\.4:context-v3:CIK(0000320193|0000789019|0000019617|0000002098):(annual|quarter|ytd|ttm):latest$');
  end if;
  return false;
end $$;

create function public.edgar_reserve_cache_generation(p_namespace text,p_dataset text,p_key text,p_claim jsonb)
returns boolean language plpgsql security invoker set search_path='' set lock_timeout='500ms' as $$
declare h public.edgar_dataset_heads;
begin
  if p_namespace is distinct from 'production' or p_dataset is null or p_dataset not in ('sec','financial','cftc')
    or p_key is null or length(p_key) not between 1 and 512 or not edgar_private.cache_claim_valid(p_claim)
    then raise exception 'invalid_cache_claim' using errcode='22023'; end if;
  if (p_dataset='cftc' and not edgar_private.cache_fence_target(p_dataset,p_key,'history','edgar.cftc-positioning.v1:production',upper(p_key)))
    or (p_dataset='sec' and p_key !~ '^sec-documents-v1:CIK(0000320193|0000789019|0000019617|0000002098):(submissions|companyfacts)$')
    or (p_dataset='financial' and not(
      p_key ~ '^financial-analysis-v1:analysis-v1\.4:context-v3:CIK(0000320193|0000789019|0000019617|0000002098):(annual|quarter|ytd|ttm):latest$'
      or p_key ~ '^research-compare-v1:compare-v2:context-v3:CIK(0000320193|0000789019|0000019617|0000002098):(annual|quarter|ttm):latest$'
      or p_key ~ '^research-portfolio-v1:analysis-v1\.4:context-v3:CIK(0000320193|0000789019|0000019617|0000002098):(annual|quarter|ytd|ttm):latest$'))
    then raise exception 'invalid_cache_claim' using errcode='22023'; end if;
  select * into h from public.edgar_dataset_heads where namespace=p_namespace and dataset=p_dataset and resource_key=p_key for update;
  if not found or not coalesce(h.generation=(p_claim->>'generation')::bigint and h.owner=(p_claim->>'owner')::uuid
    and h.lease_until>clock_timestamp(),false) then return false; end if;
  -- Save the database's original deadline, never one supplied by a caller.
  -- Repeated reservation does not renew either canonical or captured lease.
  update public.edgar_dataset_heads set cache_claim=jsonb_build_object('generation',h.generation::text,'owner',h.owner,'expiresAt',h.lease_until)
    where namespace=p_namespace and dataset=p_dataset and resource_key=p_key;
  return true;
end $$;

create function public.edgar_cache_put(p_namespace text,p_family text,p_type text,p_id text,
  p_gzip_base64 text,p_raw_sha256 text,p_gzip_sha256 text,p_raw_bytes integer,p_ttl_seconds integer,p_if_hash text default null,
  p_expires_at timestamptz default null)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='500ms' as $$
begin
  if p_namespace is distinct from 'production' then raise exception 'invalid_cache_put' using errcode='22023'; end if;
  -- Family lock is the same lock used by every payload writer and expiry prune.
  -- A guard cannot appear between this check and the original implementation.
  perform 1 from edgar_private.cache_families where namespace=p_namespace and family=p_family for update;
  if exists(select 1 from edgar_private.cache_entries where namespace=p_namespace and family=p_family
    and cache_type=p_type and cache_id=p_id and cache_guard is not null) then
    return jsonb_build_object('stored',false,'reason','fenced');
  end if;
  return edgar_private.cache_put_payload(p_namespace,p_family,p_type,p_id,p_gzip_base64,p_raw_sha256,p_gzip_sha256,
    p_raw_bytes,p_ttl_seconds,p_if_hash,p_expires_at);
end $$;

create function public.edgar_cache_put_fenced(p_namespace text,p_dataset text,p_key text,p_claim jsonb,
  p_family text,p_type text,p_id text,p_gzip_base64 text,p_raw_sha256 text,p_gzip_sha256 text,
  p_raw_bytes integer,p_ttl_seconds integer,p_if_hash text default null,p_expires_at timestamptz default null)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='500ms' as $$
declare h public.edgar_dataset_heads; result jsonb; claim_deadline timestamptz;
begin
  if p_namespace is distinct from 'production' or not edgar_private.cache_claim_valid(p_claim)
    or not coalesce(edgar_private.cache_fence_target(p_dataset,p_key,p_family,p_type,p_id),false)
    then raise exception 'invalid_cache_fence_target' using errcode='22023'; end if;
  -- Indexed canonical head first, then family quota, then cache entry. Existing
  -- begin/publish/revalidate operations also lock this head, so an older worker
  -- cannot cross a newer reservation while the cache payload is being written.
  select * into h from public.edgar_dataset_heads where namespace=p_namespace and dataset=p_dataset and resource_key=p_key for update;
  if not found or not coalesce(h.generation=(p_claim->>'generation')::bigint
    and h.cache_claim->>'generation'=h.generation::text
    and (h.cache_claim->>'owner')::uuid=(p_claim->>'owner')::uuid,false)
    then raise exception 'stale_generation' using errcode='40001'; end if;
  claim_deadline:=(h.cache_claim->>'expiresAt')::timestamptz;
  if claim_deadline is null or claim_deadline<=clock_timestamp() then raise exception 'stale_generation' using errcode='40001'; end if;
  result:=edgar_private.cache_put_payload(p_namespace,p_family,p_type,p_id,p_gzip_base64,p_raw_sha256,p_gzip_sha256,
    p_raw_bytes,p_ttl_seconds,p_if_hash,p_expires_at);
  if result->'stored'='true'::jsonb then
    -- Raw history can legitimately be supplied by multiple independently claimed
    -- parent resources. Each must satisfy its own exact target mapping above;
    -- cache_guard blocks unfenced overwrites, not these valid alternate parents.
    update edgar_private.cache_entries set cache_guard=jsonb_build_object('dataset',p_dataset,'key',p_key)
      where namespace=p_namespace and family=p_family and cache_type=p_type and cache_id=p_id;
  end if;
  -- The payload helper can wait on a family lock. Expiry after that wait must
  -- roll back the complete operation, including evictions and quota counters.
  if claim_deadline<=clock_timestamp() then raise exception 'stale_generation' using errcode='40001'; end if;
  return result;
end $$;

revoke all on function edgar_private.cache_claim_valid(jsonb) from public,anon,authenticated;
revoke all on function edgar_private.cache_fence_target(text,text,text,text,text) from public,anon,authenticated;
grant execute on function edgar_private.cache_claim_valid(jsonb) to service_role;
grant execute on function edgar_private.cache_fence_target(text,text,text,text,text) to service_role;
revoke all on function public.edgar_reserve_cache_generation(text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.edgar_cache_put(text,text,text,text,text,text,text,integer,integer,text,timestamptz) from public,anon,authenticated;
revoke all on function public.edgar_cache_put_fenced(text,text,text,jsonb,text,text,text,text,text,text,integer,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function public.edgar_reserve_cache_generation(text,text,text,jsonb) to service_role;
grant execute on function public.edgar_cache_put(text,text,text,text,text,text,text,integer,integer,text,timestamptz) to service_role;
grant execute on function public.edgar_cache_put_fenced(text,text,text,jsonb,text,text,text,text,text,text,integer,integer,text,timestamptz) to service_role;
