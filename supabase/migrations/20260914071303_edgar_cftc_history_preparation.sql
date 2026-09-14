-- Dedicated disposable history capacity and resumable, initially disabled CFTC preparation.
-- No existing cache entries, canonical evidence, or scheduler definitions are changed.
-- Compressed payload budget remains 512 MiB; physical database overhead is additional.
alter table edgar_private.cache_families drop constraint cache_families_family_check;
alter table edgar_private.cache_families add constraint cache_families_family_check
  check(family in ('snapshot','checkpoint','research','document','reference','history','cftc-history'));
update edgar_private.cache_families set max_bytes=167772160 where namespace='production' and family='research';
insert into edgar_private.cache_families(namespace,family,max_bytes,max_rows,max_ttl_seconds,evict_live)
  values('production','cftc-history',100663296,10000,1382400,true);

create table edgar_private.cftc_history_control (
  namespace text primary key check(namespace='production'),
  enabled boolean not null default false,
  enabled_at timestamptz,
  initial_sec_cycle date,
  check(not enabled or (enabled_at is not null and initial_sec_cycle is not null))
);
insert into edgar_private.cftc_history_control(namespace) values('production');
alter table edgar_private.cftc_history_control enable row level security;
revoke all on edgar_private.cftc_history_control from public,anon,authenticated,service_role;
grant select on edgar_private.cftc_history_control to service_role;

-- Legacy history-family mirror writes remain valid during deployment drain.
-- New raw claims bind one exact contract/family/report-date destination only.
create or replace function edgar_private.cache_fence_target(p_dataset text,p_key text,p_family text,p_type text,p_id text)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare scope text[]; raw_scope text[]; pilot_ticker text; group_name text;
begin
  if p_dataset is null or p_family is null or p_type is null or p_key is null or length(p_key)>512
    or p_id is null or p_id<>upper(p_id) then return false; end if;
  if p_dataset='cftc' and p_family in ('history','cftc-history') and p_type='edgar.cftc-positioning.v1:production' then
    scope:=regexp_match(p_key,'^raw-history-v1:futures-only:(tff|disaggregated):([A-Z0-9+]{3,12}):([0-9]{4}-[0-9]{2}-[0-9]{2})$');
    if scope is not null then
      return p_family='cftc-history' and p_id=upper('raw-history:'||scope[1]||':'||scope[2]||':'||scope[3]);
    end if;
    scope:=regexp_match(p_key,'^markets:(tff|disaggregated):(latest|[0-9]{4}-[0-9]{2}-[0-9]{2})$');
    if scope is not null then
      if p_id=upper(p_key) or p_id=upper(regexp_replace(p_key,'^markets:','markets-last-good:')) then return p_family='history'; end if;
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

create or replace function public.edgar_reserve_cache_generation(p_namespace text,p_dataset text,p_key text,p_claim jsonb)
returns boolean language plpgsql security invoker set search_path='' set lock_timeout='500ms' as $$
declare h public.edgar_dataset_heads;
begin
  if p_namespace is distinct from 'production' or p_dataset is null or p_dataset not in ('sec','financial','cftc')
    or p_key is null or length(p_key) not between 1 and 512 or not edgar_private.cache_claim_valid(p_claim)
    then raise exception 'invalid_cache_claim' using errcode='22023'; end if;
  if (p_dataset='cftc' and not (edgar_private.cache_fence_target(p_dataset,p_key,'history','edgar.cftc-positioning.v1:production',upper(p_key))
      or edgar_private.cache_fence_target(p_dataset,p_key,'cftc-history','edgar.cftc-positioning.v1:production',upper(regexp_replace(p_key,'^raw-history-v1:futures-only:','raw-history:')))))
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

create or replace function public.edgar_claim_job_prefix(p_namespace text,p_dataset text,p_owner uuid,p_prefix text,p_lease_seconds integer default 120)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.edgar_ingestion_jobs;
begin
  if not coalesce((p_dataset='sec' and p_prefix in ('sec-coverage-v1:','sec-financial-cohort-v1:'))
    or (p_dataset='cftc' and p_prefix='cftc-history-v1:'),false)
    or p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$' or p_owner is null
    or p_lease_seconds is null or p_lease_seconds not between 10 and 900
  then raise exception 'invalid_job_prefix' using errcode='22023'; end if;
  if p_dataset='cftc' and not exists(select 1 from edgar_private.cftc_history_control where namespace=p_namespace and enabled) then return null; end if;
  update public.edgar_ingestion_jobs set state='dead',owner=null,lease_until=null,error_code='lease_expired',updated_at=clock_timestamp()
    where namespace=p_namespace and dataset=p_dataset and left(job_key,length(p_prefix))=p_prefix
      and state='running' and lease_until<=clock_timestamp() and attempts>=max_attempts;
  select * into j from public.edgar_ingestion_jobs where namespace=p_namespace and dataset=p_dataset
    and left(job_key,length(p_prefix))=p_prefix and attempts<max_attempts and available_at<=clock_timestamp()
    and (state in ('queued','retry') or (state='running' and lease_until<=clock_timestamp()))
    order by available_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.edgar_ingestion_jobs set state='running',generation=generation+1,owner=p_owner,
    lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=attempts+1,updated_at=clock_timestamp()
    where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'dataset',j.dataset,'key',j.resource_key,'jobKey',j.job_key,'owner',j.owner,
    'generation',j.generation,'attempts',j.attempts,'checkpoint',j.checkpoint,'expiresAt',j.lease_until);
end $$;

create or replace function public.edgar_yield_job(p_namespace text,p_claim jsonb,p_checkpoint jsonb,p_delay_seconds integer default 1)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  if p_checkpoint is null or jsonb_typeof(p_checkpoint)<>'object' or octet_length(p_checkpoint::text)>16384
    or p_delay_seconds is null or p_delay_seconds not between 1 and 86400
  then raise exception 'invalid_job_yield' using errcode='22023'; end if;
  -- A successful continuation (or a bounded busy wait) is not a failed attempt.
  -- The worker decides yield versus retry; expired/stale owners cannot reset it.
  update public.edgar_ingestion_jobs set state='queued',checkpoint=p_checkpoint,
    attempts=greatest(0,attempts-1),owner=null,lease_until=null,error_code=null,
    available_at=clock_timestamp()+make_interval(secs=>p_delay_seconds),updated_at=clock_timestamp()
  where namespace=p_namespace and (dataset='sec' or (dataset='cftc' and left(job_key,length('cftc-history-v1:'))='cftc-history-v1:')) and id=(p_claim->>'id')::uuid
    and generation=(p_claim->>'generation')::bigint and owner=(p_claim->>'owner')::uuid
    and state='running' and lease_until>clock_timestamp();
  get diagnostics n=row_count; return n=1;
end $$;

create or replace function public.edgar_claim_job(p_namespace text,p_dataset text,p_owner uuid,p_lease_seconds integer default 120,p_job_key text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.edgar_ingestion_jobs;
begin
  -- A final-attempt worker killed before finishing is explicitly dead-lettered.
  update public.edgar_ingestion_jobs set state='dead',owner=null,lease_until=null,error_code='lease_expired',updated_at=clock_timestamp()
    where namespace=p_namespace and dataset=p_dataset
    and (dataset<>'cftc' or left(job_key,length('cftc-history-v1:'))<>'cftc-history-v1:'
      or exists(select 1 from edgar_private.cftc_history_control where namespace=p_namespace and enabled)) and state='running' and lease_until<=clock_timestamp() and attempts>=max_attempts;
  select * into j from public.edgar_ingestion_jobs where namespace=p_namespace and dataset=p_dataset
    and (dataset<>'cftc' or left(job_key,length('cftc-history-v1:'))<>'cftc-history-v1:'
      or exists(select 1 from edgar_private.cftc_history_control where namespace=p_namespace and enabled))
    and (p_job_key is null or job_key=p_job_key) and attempts<max_attempts and available_at<=clock_timestamp()
    and (state in ('queued','retry') or (state='running' and lease_until<=clock_timestamp()))
    order by available_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.edgar_ingestion_jobs set state='running',generation=generation+1,owner=p_owner,
    lease_until=clock_timestamp()+make_interval(secs=>greatest(10,least(p_lease_seconds,900))),attempts=attempts+1,updated_at=clock_timestamp()
    where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'dataset',j.dataset,'key',j.resource_key,'jobKey',j.job_key,'owner',j.owner,'generation',j.generation,'attempts',j.attempts,'checkpoint',j.checkpoint,'expiresAt',j.lease_until);
end $$;

create function public.edgar_cftc_history_status(p_namespace text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('enabled',coalesce(c.enabled,false),'enabledAt',c.enabled_at,'initialSecCycle',c.initial_sec_cycle,
    'jobs',(select coalesce(jsonb_agg(summary order by summary."reportDate" desc,summary."lastProgressAt" desc),'[]'::jsonb) from (
      select split_part(j.job_key,':',3) family,split_part(j.job_key,':',2) "reportDate",
        case when j.checkpoint->>'catalogHash' ~ '^[a-f0-9]{64}$' then j.checkpoint->>'catalogHash' else null end "catalogHash",
        count(*) shards,jsonb_agg((split_part(j.job_key,':',4))::integer order by (split_part(j.job_key,':',4))::integer) "shardIndexes",
        count(*) filter(where j.state='done') done,count(*) filter(where j.state='running') running,
        count(*) filter(where j.state='queued') queued,count(*) filter(where j.state='retry') retry,count(*) filter(where j.state='dead') dead,
        jsonb_build_object(
          'contracts',sum(case when jsonb_typeof(j.checkpoint->'contracts')='array' then jsonb_array_length(j.checkpoint->'contracts') else 0 end),
          'visited',sum(case when j.state='dead' and jsonb_typeof(j.checkpoint->'contracts')='array' then jsonb_array_length(j.checkpoint->'contracts')
            when j.checkpoint->>'cursor' ~ '^[0-9]{1,6}$' then (j.checkpoint->>'cursor')::integer else 0 end),
          'prepared',sum(case when j.checkpoint->>'prepared' ~ '^[0-9]{1,6}$' then (j.checkpoint->>'prepared')::integer else 0 end),
          'limited',sum(case when j.checkpoint->>'limited' ~ '^[0-9]{1,6}$' then (j.checkpoint->>'limited')::integer else 0 end),
          'failed',sum(case when j.state='dead' and jsonb_typeof(j.checkpoint->'contracts')='array' then greatest(0,jsonb_array_length(j.checkpoint->'contracts')
            -case when j.checkpoint->>'prepared' ~ '^[0-9]{1,6}$' then (j.checkpoint->>'prepared')::integer else 0 end)
            when jsonb_typeof(j.checkpoint->'failures')='array' then jsonb_array_length(j.checkpoint->'failures') else 0 end)) counters,
        max(j.updated_at) "lastProgressAt"
      from public.edgar_ingestion_jobs j where j.namespace=p_namespace and j.dataset='cftc'
        and j.job_key ~ '^cftc-history-v1:[0-9]{4}-[0-9]{2}-[0-9]{2}:(tff|disaggregated):([0-2][0-9]|3[01]):[a-f0-9]{16}$'
      group by split_part(j.job_key,':',3),split_part(j.job_key,':',2),
        case when j.checkpoint->>'catalogHash' ~ '^[a-f0-9]{64}$' then j.checkpoint->>'catalogHash' else null end
      order by "reportDate" desc,"lastProgressAt" desc limit 64
    ) summary)) from edgar_private.cftc_history_control c where c.namespace=p_namespace
$$;

revoke all on function public.edgar_cftc_history_status(text) from public,anon,authenticated;
grant execute on function public.edgar_cftc_history_status(text) to service_role;
-- CREATE OR REPLACE preserves the existing invoker-only functions and grants.

