-- Additive serving and coordination RPCs. Existing data, grants and publication
-- fences remain intact. No schedule, deletion or privileged browser access.
create function public.edgar_get_manifests(p_namespace text,p_dataset text,p_keys text[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$'
    or p_dataset is null or p_dataset not in ('sec','financial','cftc')
    or p_keys is null or coalesce(array_ndims(p_keys),1)<>1 or cardinality(p_keys)>100
    or exists(select 1 from unnest(p_keys) k where k is null or length(k) not between 1 and 512)
  then raise exception 'invalid_manifest_batch' using errcode='22023'; end if;
  select coalesce(jsonb_agg(case when v.id is null then null else
    jsonb_build_object('key',requested.resource_key,'id',v.id,'generation',v.publication_generation,
      'contentHash',v.content_hash,'identityHash',v.identity_hash,'objectPath',v.object_path,
      'rawBytes',v.raw_bytes,'storedBytes',v.stored_bytes,
      'revalidatedAt',h.revalidated_at,'expiresAt',h.expires_at,
      -- Selected bounded provenance only: 100 full metadata blobs could exceed
      -- the gateway response cap even though no payload was downloaded.
      'metadata',jsonb_strip_nulls(jsonb_build_object(
        'versionId',v.id,'generation',v.publication_generation,'contentHash',v.content_hash,'identityHash',v.identity_hash,
        'fetchedAt',v.fetched_at,'publishedAt',v.published_at,'revalidatedAt',h.revalidated_at,'expiresAt',h.expires_at,
        'documentContentHash',left(v.metadata->>'documentContentHash',64),
        'financialInputHash',left(v.metadata->>'financialInputHash',64),
        'metricProjectionVersion',left(v.metadata->>'metricProjectionVersion',64),
        'entityId',left(v.metadata->>'entityId',32),'resource',left(v.metadata->>'resource',64),
        'parserVersion',left(v.metadata->>'parserVersion',128),'calculationVersion',left(v.metadata->>'calculationVersion',128),
        'basis',left(v.metadata->>'basis',16),'reportPeriod',left(v.metadata->>'reportPeriod',64)
      ))) end order by requested.ordinal),'[]'::jsonb) into result
  from unnest(p_keys) with ordinality requested(resource_key,ordinal)
  left join public.edgar_dataset_heads h on h.namespace=p_namespace and h.dataset=p_dataset and h.resource_key=requested.resource_key
  left join public.edgar_dataset_versions v on v.id=h.current_version and v.namespace=h.namespace and v.dataset=h.dataset and v.resource_key=h.resource_key;
  return result;
end $$;

create function public.edgar_get_compact_batch(p_namespace text,p_dataset text,p_keys text[])
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$'
    or p_dataset is null or p_dataset not in ('sec','financial','cftc')
    or p_keys is null or coalesce(array_ndims(p_keys),1)<>1 or cardinality(p_keys)>5
    or exists(select 1 from unnest(p_keys) k where k is null or length(k) not between 1 and 512)
  then raise exception 'invalid_compact_batch' using errcode='22023'; end if;
  -- Five rows fit the existing 512 KiB response cap: each stored compact JSON
  -- is <=64 KiB and its metadata <=32 KiB. No Storage object is fetched here.
  select coalesce(jsonb_agg(case when v.payload is not null then
      public.edgar_get_version(p_namespace,p_dataset,requested.resource_key)
      else null end order by requested.ordinal),'[]'::jsonb) into result
  from unnest(p_keys) with ordinality requested(resource_key,ordinal)
  left join public.edgar_dataset_heads h on h.namespace=p_namespace and h.dataset=p_dataset and h.resource_key=requested.resource_key
  left join public.edgar_dataset_versions v on v.id=h.current_version and v.namespace=h.namespace and v.dataset=h.dataset and v.resource_key=h.resource_key;
  if octet_length(result::text)>524288 then raise exception 'compact_batch_response_too_large' using errcode='22023'; end if;
  return result;
end $$;

create function public.edgar_claim_job_prefix(p_namespace text,p_dataset text,p_owner uuid,p_prefix text,p_lease_seconds integer default 120)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.edgar_ingestion_jobs;
begin
  if p_dataset is distinct from 'sec' or p_prefix is null or p_prefix not in ('sec-coverage-v1:','sec-financial-cohort-v1:')
    or p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$' or p_owner is null
    or p_lease_seconds is null or p_lease_seconds not between 10 and 900
  then raise exception 'invalid_job_prefix' using errcode='22023'; end if;
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

create function public.edgar_yield_job(p_namespace text,p_claim jsonb,p_checkpoint jsonb,p_delay_seconds integer default 1)
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
  where namespace=p_namespace and dataset='sec' and id=(p_claim->>'id')::uuid
    and generation=(p_claim->>'generation')::bigint and owner=(p_claim->>'owner')::uuid
    and state='running' and lease_until>clock_timestamp();
  get diagnostics n=row_count; return n=1;
end $$;

create function public.edgar_coverage_status(p_namespace text)
returns jsonb language sql stable security invoker set search_path='' as $$
select public.edgar_store_status(p_namespace) || jsonb_build_object(
  'coverageGroups',(select coalesce(jsonb_agg(to_jsonb(summary)),'[]'::jsonb) from (
    select h.dataset,
      case when h.dataset='sec' then 'sec-document'
        when h.resource_key like 'financial-analysis-v1:%' then 'analysis'
        when h.resource_key like 'research-compare-v1:%' then 'compare'
        when h.resource_key like 'research-portfolio-v1:%' then 'portfolio'
        when h.resource_key='research-market-overview-v1:latest' then 'market-overview'
        when h.resource_key like 'research-company-v1:%' then 'company-summary'
        else 'other' end as family,
      case when h.dataset='sec' then case when split_part(h.resource_key,':',3) in ('submissions','companyfacts') then split_part(h.resource_key,':',3) else 'other' end
        when v.metadata->>'basis' in ('annual','quarter','ytd','ttm') then v.metadata->>'basis'
        else 'all' end as basis,
      count(*) as prepared,
      count(*) filter(where h.expires_at>now()) as fresh,
      count(*) filter(where h.expires_at<=now() or h.expires_at is null) as stale,
      min(h.revalidated_at) as earliest_revalidated_at,max(h.revalidated_at) as latest_revalidated_at,
      min(h.expires_at) as earliest_expires_at,
      sum(v.raw_bytes) as current_raw_bytes,sum(v.stored_bytes) as current_stored_bytes
    from public.edgar_dataset_heads h join public.edgar_dataset_versions v on v.id=h.current_version
      and v.namespace=h.namespace and v.dataset=h.dataset and v.resource_key=h.resource_key
    where h.namespace=p_namespace and h.dataset in ('sec','financial')
    group by 1,2,3 order by 1,2,3
  ) summary),
  'coverageJobs',(select coalesce(jsonb_object_agg(state,n),'{}'::jsonb) from (
    select state,count(*) as n from public.edgar_ingestion_jobs where namespace=p_namespace and dataset='sec'
      and left(job_key,16)='sec-coverage-v1:' group by state
  ) states),
  'oldestCoverageWork',(select min(created_at) from public.edgar_ingestion_jobs where namespace=p_namespace and dataset='sec'
      and left(job_key,16)='sec-coverage-v1:' and state in ('queued','running','retry')),
  'observedAt',now()
)
$$;

create function public.edgar_enqueue_coverage_jobs(p_namespace text,p_cycle text,p_version text,p_shards integer[] default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare shards integer[]; shard integer; id uuid; job_key text; result jsonb:='[]'::jsonb;
begin
  if p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$' or p_cycle is null
    or p_cycle !~ '^\d{4}-\d{2}-\d{2}$' or to_char(p_cycle::date,'YYYY-MM-DD')<>p_cycle
    or p_version is null or p_version !~ '^[a-f0-9]{16}$'
  then raise exception 'invalid_coverage_cycle' using errcode='22023'; end if;
  if p_shards is null then select array_agg(n) into shards from generate_series(0,31) n;
  else shards:=p_shards; end if;
  if coalesce(array_ndims(shards),1)<>1 or cardinality(shards) not between 1 and 32
    or exists(select 1 from unnest(shards) n where n is null or n not between 0 and 31)
    or cardinality(shards)<>(select count(distinct n) from unnest(shards) n)
  then raise exception 'invalid_coverage_shards' using errcode='22023'; end if;
  foreach shard in array shards loop
    job_key:='sec-coverage-v1:'||p_cycle||':'||lpad(shard::text,2,'0')||':'||p_version;
    id:=public.edgar_enqueue_job(p_namespace,'sec','sec-coverage-v1:shard:'||lpad(shard::text,2,'0'),job_key,
      jsonb_build_object('schema',1,'universeVersion',p_version,'shard',shard,'cycle',p_cycle,
        'cursor',0,'succeeded',0,'workCount',0,'retries','[]'::jsonb,'failures','[]'::jsonb),10);
    result:=result||jsonb_build_array(jsonb_build_object('shard',shard,'id',id,'jobKey',job_key));
  end loop;
  return result;
end $$;

revoke all on function public.edgar_get_manifests(text,text,text[]) from public,anon,authenticated;
revoke all on function public.edgar_get_compact_batch(text,text,text[]) from public,anon,authenticated;
revoke all on function public.edgar_claim_job_prefix(text,text,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.edgar_yield_job(text,jsonb,jsonb,integer) from public,anon,authenticated;
revoke all on function public.edgar_coverage_status(text) from public,anon,authenticated;
revoke all on function public.edgar_enqueue_coverage_jobs(text,text,text,integer[]) from public,anon,authenticated;
grant execute on function public.edgar_get_manifests(text,text,text[]) to service_role;
grant execute on function public.edgar_get_compact_batch(text,text,text[]) to service_role;
grant execute on function public.edgar_claim_job_prefix(text,text,uuid,text,integer) to service_role;
grant execute on function public.edgar_yield_job(text,jsonb,jsonb,integer) to service_role;
grant execute on function public.edgar_coverage_status(text) to service_role;
grant execute on function public.edgar_enqueue_coverage_jobs(text,text,text,integer[]) to service_role;
