-- Additive only. No schedule is created and no legacy data is modified.
-- The HTTP runtime calls SECURITY INVOKER functions as a trusted server role.
create table public.edgar_dataset_heads (
  namespace text not null check (namespace ~ '^[a-z0-9_-]{1,48}$'),
  dataset text not null check (dataset in ('cftc','sec','financial')),
  resource_key text not null check (length(resource_key) between 1 and 512),
  generation bigint not null default 0 check (generation >= 0),
  owner uuid, lease_until timestamptz,
  current_version uuid, last_good_version uuid, rollback_version uuid,
  revalidated_at timestamptz, expires_at timestamptz,
  validation_metadata jsonb not null default '{}' check (octet_length(validation_metadata::text) <= 32768),
  primary key (namespace,dataset,resource_key)
);
create table public.edgar_source_assets (
  id uuid primary key default gen_random_uuid(),
  namespace text not null, dataset text not null check (dataset in ('cftc','sec','financial')),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  bucket text not null check (bucket = 'edgar-durable-private'),
  object_path text not null unique check (length(object_path) < 512),
  raw_bytes bigint not null check (raw_bytes between 1 and 25165824),
  stored_bytes bigint not null check (stored_bytes between 1 and 6291456),
  source_url text not null, source_id text, entity_id text, report_period text,
  fetched_at timestamptz not null, published_at timestamptz,
  content_type text not null, encoding text not null check (encoding='gzip'),
  created_at timestamptz not null default now(),
  unique(namespace,dataset,content_hash)
);
create table public.edgar_dataset_versions (
  id uuid primary key default gen_random_uuid(),
  namespace text not null, dataset text not null check (dataset in ('cftc','sec','financial')),
  resource_key text not null check (length(resource_key) between 1 and 512),
  identity_hash text not null check (identity_hash ~ '^[a-f0-9]{64}$'),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  schema_version text not null, parser_version text, calculation_version text,
  publication_generation bigint not null,
  payload jsonb check (payload is null or octet_length(payload::text) <= 65536),
  object_path text,
  raw_bytes bigint not null check (raw_bytes between 1 and 25165824),
  stored_bytes bigint not null check (stored_bytes between 1 and 6291456),
  source_asset_id uuid references public.edgar_source_assets(id),
  metadata jsonb not null check (octet_length(metadata::text) <= 32768),
  fetched_at timestamptz not null, published_at timestamptz,
  created_at timestamptz not null default now(),
  check ((payload is null) <> (object_path is null)),
  unique(namespace,dataset,resource_key,identity_hash)
);
alter table public.edgar_dataset_heads
  add foreign key (current_version) references public.edgar_dataset_versions(id),
  add foreign key (last_good_version) references public.edgar_dataset_versions(id),
  add foreign key (rollback_version) references public.edgar_dataset_versions(id);
create index edgar_versions_resource_created on public.edgar_dataset_versions(namespace,dataset,resource_key,created_at desc);
create index edgar_versions_source on public.edgar_dataset_versions(source_asset_id) where source_asset_id is not null;
-- Only metrics actually used by the initial company analysis consumer are materialized.
-- Numeric stores exact decimal values; context carries existing input lineage, not fabricated dimensions.
create table public.edgar_financial_metrics (
  version_id uuid not null references public.edgar_dataset_versions(id),
  metric text not null, ordinal integer not null,
  value numeric, unit text, period_start date, period_end date,
  taxonomy text, concept text, accession text, form text, filed date,
  fiscal_year integer, fiscal_period text,
  context jsonb not null default '{}' check (octet_length(context::text) <= 8192),
  primary key(version_id,metric,ordinal)
);
create table public.edgar_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  namespace text not null, dataset text not null check (dataset in ('cftc','sec','financial')),
  resource_key text not null check (length(resource_key) between 1 and 512),
  job_key text not null check (length(job_key) between 1 and 512),
  state text not null default 'queued' check (state in ('queued','running','retry','done','dead')),
  generation bigint not null default 0, owner uuid, lease_until timestamptz,
  attempts integer not null default 0, max_attempts integer not null check (max_attempts between 1 and 10),
  available_at timestamptz not null default now(),
  checkpoint jsonb not null default '{}' check (octet_length(checkpoint::text) <= 16384),
  error_code text check (length(error_code) <= 100),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(namespace,dataset,job_key)
);
create index edgar_jobs_ready on public.edgar_ingestion_jobs(namespace,dataset,available_at) where state in ('queued','retry','running');

create function public.edgar_begin_write(p_namespace text,p_dataset text,p_key text,p_owner uuid,p_lease_seconds integer default 120)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare h public.edgar_dataset_heads;
begin
  insert into public.edgar_dataset_heads(namespace,dataset,resource_key) values(p_namespace,p_dataset,p_key) on conflict do nothing;
  select * into h from public.edgar_dataset_heads where namespace=p_namespace and dataset=p_dataset and resource_key=p_key for update;
  if h.owner is not null and h.lease_until > clock_timestamp() then return null; end if;
  update public.edgar_dataset_heads set generation=generation+1, owner=p_owner,
    lease_until=clock_timestamp()+make_interval(secs=>greatest(10,least(p_lease_seconds,900)))
    where namespace=p_namespace and dataset=p_dataset and resource_key=p_key returning * into h;
  return jsonb_build_object('dataset',p_dataset,'key',p_key,'owner',h.owner,'generation',h.generation,'expiresAt',h.lease_until);
end $$;

create function public.edgar_get_version(p_namespace text,p_dataset text,p_key text,p_identity text default null,p_pointer text default 'current')
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',v.id,'identityHash',v.identity_hash,'contentHash',v.content_hash,
    'payload',v.payload,'objectPath',v.object_path,'rawBytes',v.raw_bytes,'storedBytes',v.stored_bytes,
    'metadata',v.metadata || case when h.current_version=v.id then h.validation_metadata else '{}'::jsonb end,
    'generation',v.publication_generation,'expiresAt',case when h.current_version=v.id then h.expires_at else (v.metadata->>'expiresAt')::timestamptz end,
    'revalidatedAt',case when h.current_version=v.id then h.revalidated_at else null end,
    'source',case when a.id is not null then jsonb_build_object('id',a.id,'objectPath',a.object_path,'contentHash',a.content_hash,
      'rawBytes',a.raw_bytes,'storedBytes',a.stored_bytes,'url',a.source_url,'fetchedAt',a.fetched_at,'publishedAt',a.published_at) else null end)
  from public.edgar_dataset_heads h
  join public.edgar_dataset_versions v on v.namespace=h.namespace and v.dataset=h.dataset and v.resource_key=h.resource_key
    and ((p_identity is not null and v.identity_hash=p_identity) or (p_identity is null and v.id=case p_pointer when 'last-good' then h.last_good_version when 'rollback' then h.rollback_version else h.current_version end))
  left join public.edgar_source_assets a on a.id=v.source_asset_id
  where h.namespace=p_namespace and h.dataset=p_dataset and h.resource_key=p_key limit 1
$$;

create function public.edgar_publish(p_namespace text,p_dataset text,p_key text,p_claim jsonb,p_record jsonb,p_promote_good boolean default true)
returns uuid language plpgsql security invoker set search_path='' as $$
declare h public.edgar_dataset_heads; v_id uuid; a_id uuid; src jsonb; item jsonb; n integer:=0;
begin
  select * into h from public.edgar_dataset_heads where namespace=p_namespace and dataset=p_dataset and resource_key=p_key for update;
  if not found or not coalesce(h.generation=(p_claim->>'generation')::bigint and h.owner=(p_claim->>'owner')::uuid and h.lease_until>clock_timestamp(),false) then
    raise exception 'stale_generation' using errcode='40001'; end if;
  select id into v_id from public.edgar_dataset_versions where namespace=p_namespace and dataset=p_dataset and resource_key=p_key and identity_hash=p_record->>'identityHash';
  if v_id is null then
    src:=p_record->'source';
    if src is not null and src<>'null'::jsonb then
      if not exists(select 1 from storage.objects where bucket_id='edgar-durable-private' and name=src->>'objectPath') then raise exception 'source_object_missing'; end if;
      insert into public.edgar_source_assets(namespace,dataset,content_hash,bucket,object_path,raw_bytes,stored_bytes,source_url,source_id,entity_id,report_period,fetched_at,published_at,content_type,encoding)
      values(p_namespace,p_dataset,src->>'contentHash','edgar-durable-private',src->>'objectPath',(src->>'rawBytes')::bigint,(src->>'storedBytes')::bigint,src->>'url',p_record->'metadata'->>'sourceId',p_record->'metadata'->>'entityId',p_record->'metadata'->>'reportPeriod',(src->>'fetchedAt')::timestamptz,(src->>'publishedAt')::timestamptz,coalesce(src->>'contentType','application/json'),'gzip')
      on conflict(namespace,dataset,content_hash) do nothing;
      select id into a_id from public.edgar_source_assets where namespace=p_namespace and dataset=p_dataset and content_hash=src->>'contentHash';
    end if;
    if p_record->>'objectPath' is not null and not exists(select 1 from storage.objects where bucket_id='edgar-durable-private' and name=p_record->>'objectPath') then raise exception 'snapshot_object_missing'; end if;
    insert into public.edgar_dataset_versions(namespace,dataset,resource_key,identity_hash,content_hash,schema_version,parser_version,calculation_version,publication_generation,payload,object_path,raw_bytes,stored_bytes,source_asset_id,metadata,fetched_at,published_at)
    values(p_namespace,p_dataset,p_key,p_record->>'identityHash',p_record->>'contentHash',p_record->>'schemaVersion',p_record->'metadata'->>'parserVersion',p_record->'metadata'->>'calculationVersion',(p_claim->>'generation')::bigint,nullif(p_record->'payload','null'::jsonb),p_record->>'objectPath',(p_record->>'rawBytes')::bigint,(p_record->>'storedBytes')::bigint,a_id,p_record->'metadata',(p_record->'metadata'->>'fetchedAt')::timestamptz,(p_record->'metadata'->>'publishedAt')::timestamptz)
    returning id into v_id;
    if p_dataset='financial' then
      if jsonb_array_length(coalesce(p_record->'observations','[]'::jsonb))>512 then raise exception 'too_many_metrics'; end if;
      for item in select value from jsonb_array_elements(coalesce(p_record->'observations','[]'::jsonb)) loop
        n:=n+1;
        insert into public.edgar_financial_metrics(version_id,metric,ordinal,value,unit,period_start,period_end,taxonomy,concept,accession,form,filed,fiscal_year,fiscal_period,context)
        values(v_id,item->>'metric',n,(item->>'value')::numeric,item->>'unit',(item->>'periodStart')::date,(item->>'periodEnd')::date,item->>'taxonomy',item->>'concept',item->>'accession',item->>'form',(item->>'filed')::date,(item->>'fiscalYear')::integer,item->>'fiscalPeriod',coalesce(item->'context','{}'::jsonb));
      end loop;
    end if;
  end if;
  update public.edgar_dataset_heads set current_version=v_id,
    last_good_version=case when p_promote_good then v_id else last_good_version end,
    rollback_version=case when current_version is distinct from v_id then current_version else rollback_version end,
    revalidated_at=coalesce((p_record->'metadata'->>'revalidatedAt')::timestamptz,(p_record->'metadata'->>'fetchedAt')::timestamptz),
    expires_at=(p_record->'metadata'->>'expiresAt')::timestamptz,
    validation_metadata=jsonb_build_object('revalidatedAt',coalesce(p_record->'metadata'->>'revalidatedAt',p_record->'metadata'->>'fetchedAt'),'expiresAt',p_record->'metadata'->>'expiresAt'),
    owner=null,lease_until=null where namespace=p_namespace and dataset=p_dataset and resource_key=p_key;
  return v_id;
end $$;

create function public.edgar_revalidate(p_namespace text,p_dataset text,p_key text,p_claim jsonb,p_metadata jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  update public.edgar_dataset_heads set revalidated_at=(p_metadata->>'revalidatedAt')::timestamptz,
    expires_at=(p_metadata->>'expiresAt')::timestamptz,
    validation_metadata=validation_metadata||jsonb_strip_nulls(jsonb_build_object('revalidatedAt',p_metadata->'revalidatedAt','expiresAt',p_metadata->'expiresAt','etag',p_metadata->'etag','lastModified',p_metadata->'lastModified')),owner=null,lease_until=null
  where namespace=p_namespace and dataset=p_dataset and resource_key=p_key and current_version is not null
    and generation=(p_claim->>'generation')::bigint and owner=(p_claim->>'owner')::uuid and lease_until>clock_timestamp();
  get diagnostics n=row_count; return n=1;
end $$;

create function public.edgar_enqueue_job(p_namespace text,p_dataset text,p_key text,p_job_key text,p_checkpoint jsonb default '{}',p_max_attempts integer default 4)
returns uuid language plpgsql security invoker set search_path='' as $$
declare j_id uuid;
begin
  insert into public.edgar_ingestion_jobs(namespace,dataset,resource_key,job_key,checkpoint,max_attempts)
  values(p_namespace,p_dataset,p_key,p_job_key,p_checkpoint,greatest(1,least(p_max_attempts,10))) on conflict(namespace,dataset,job_key) do nothing;
  select id into j_id from public.edgar_ingestion_jobs where namespace=p_namespace and dataset=p_dataset and job_key=p_job_key;
  return j_id;
end $$;
create function public.edgar_claim_job(p_namespace text,p_dataset text,p_owner uuid,p_lease_seconds integer default 120,p_job_key text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.edgar_ingestion_jobs;
begin
  -- A final-attempt worker killed before finishing is explicitly dead-lettered.
  update public.edgar_ingestion_jobs set state='dead',owner=null,lease_until=null,error_code='lease_expired',updated_at=clock_timestamp()
    where namespace=p_namespace and dataset=p_dataset and state='running' and lease_until<=clock_timestamp() and attempts>=max_attempts;
  select * into j from public.edgar_ingestion_jobs where namespace=p_namespace and dataset=p_dataset
    and (p_job_key is null or job_key=p_job_key) and attempts<max_attempts and available_at<=clock_timestamp()
    and (state in ('queued','retry') or (state='running' and lease_until<=clock_timestamp()))
    order by available_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.edgar_ingestion_jobs set state='running',generation=generation+1,owner=p_owner,
    lease_until=clock_timestamp()+make_interval(secs=>greatest(10,least(p_lease_seconds,900))),attempts=attempts+1,updated_at=clock_timestamp()
    where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'dataset',j.dataset,'key',j.resource_key,'jobKey',j.job_key,'owner',j.owner,'generation',j.generation,'attempts',j.attempts,'checkpoint',j.checkpoint,'expiresAt',j.lease_until);
end $$;
create function public.edgar_finish_job(p_namespace text,p_claim jsonb,p_status text,p_checkpoint jsonb,p_error text default null,p_delay_seconds integer default 30)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  if p_status not in ('done','retry','dead') then raise exception 'invalid_job_status'; end if;
  update public.edgar_ingestion_jobs set state=case when p_status='retry' and attempts>=max_attempts then 'dead' else p_status end,
    checkpoint=p_checkpoint,error_code=left(p_error,100),owner=null,lease_until=null,
    available_at=clock_timestamp()+make_interval(secs=>greatest(1,p_delay_seconds)),updated_at=clock_timestamp()
    where namespace=p_namespace and id=(p_claim->>'id')::uuid and generation=(p_claim->>'generation')::bigint
      and owner=(p_claim->>'owner')::uuid and state='running' and lease_until>clock_timestamp();
  get diagnostics n=row_count; return n=1;
end $$;
create function public.edgar_checkpoint_job(p_namespace text,p_claim jsonb,p_checkpoint jsonb,p_lease_seconds integer default 120)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer; begin
 update public.edgar_ingestion_jobs set checkpoint=p_checkpoint,updated_at=clock_timestamp(),
   lease_until=clock_timestamp()+make_interval(secs=>greatest(10,least(p_lease_seconds,900)))
 where namespace=p_namespace and id=(p_claim->>'id')::uuid and generation=(p_claim->>'generation')::bigint
   and owner=(p_claim->>'owner')::uuid and state='running' and lease_until>clock_timestamp();
 get diagnostics n=row_count; return n=1;
end $$;
create function public.edgar_store_status(p_namespace text)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object(
 'heads',(select count(*) from public.edgar_dataset_heads where namespace=p_namespace),
 'versions',(select count(*) from public.edgar_dataset_versions where namespace=p_namespace),
 'sourceAssets',(select count(*) from public.edgar_source_assets where namespace=p_namespace),
 'sourceStoredBytes',(select coalesce(sum(stored_bytes),0) from public.edgar_source_assets where namespace=p_namespace),
 'snapshotStoredBytes',(select coalesce(sum(stored_bytes),0) from public.edgar_dataset_versions where namespace=p_namespace and object_path is not null and not exists(select 1 from public.edgar_source_assets a where a.object_path=edgar_dataset_versions.object_path)),
 'preparedBytes',(select coalesce(sum(raw_bytes),0) from public.edgar_dataset_versions where namespace=p_namespace and payload is not null),
 'databaseBytes',pg_total_relation_size('public.edgar_dataset_heads')+pg_total_relation_size('public.edgar_dataset_versions')+pg_total_relation_size('public.edgar_source_assets')+pg_total_relation_size('public.edgar_financial_metrics')+pg_total_relation_size('public.edgar_ingestion_jobs'),
 'jobs',(select coalesce(jsonb_object_agg(state,n),'{}') from(select state,count(*) n from public.edgar_ingestion_jobs where namespace=p_namespace group by state)s),
 'latestRevalidation',(select max(revalidated_at) from public.edgar_dataset_heads where namespace=p_namespace))
$$;
-- A bounded manifest export is also the portable recovery inventory; payloads are
-- fetched explicitly per record/object, never SELECT * on normal serving paths.
create function public.edgar_export_manifests(p_namespace text,p_after uuid default null,p_limit integer default 100)
returns jsonb language sql stable security invoker set search_path='' as $$
select coalesce(jsonb_agg(to_jsonb(s)),'[]') from (
 select v.id,v.dataset,v.resource_key,v.identity_hash,v.content_hash,v.object_path,v.raw_bytes,v.stored_bytes,v.source_asset_id,v.metadata,v.created_at,
   v.id=h.current_version as is_current,v.id=h.last_good_version as is_last_good,v.id=h.rollback_version as is_rollback,
   a.object_path as source_object_path,a.content_hash as source_content_hash
 from public.edgar_dataset_versions v join public.edgar_dataset_heads h using(namespace,dataset,resource_key)
 left join public.edgar_source_assets a on a.id=v.source_asset_id
 where v.namespace=p_namespace and (p_after is null or v.id>p_after) order by v.id limit greatest(1,least(p_limit,100))
)s
$$;
create function public.edgar_retention_dry_run(p_namespace text,p_before timestamptz,p_limit integer default 100)
returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('dryRun',true,'deletionEnabled',false,
 'derivedSnapshotCandidates',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from(
  select v.id,v.dataset,v.resource_key,v.object_path,v.stored_bytes,v.created_at
  from public.edgar_dataset_versions v join public.edgar_dataset_heads h using(namespace,dataset,resource_key)
  where v.namespace=p_namespace and v.dataset<>'sec' and v.created_at<p_before and v.object_path is not null
    and v.id is distinct from h.current_version and v.id is distinct from h.last_good_version and v.id is distinct from h.rollback_version
    and not(h.owner is not null and h.lease_until>now()) order by v.created_at limit greatest(1,least(p_limit,100)))s),
 'terminalJobCandidates',(select count(*) from public.edgar_ingestion_jobs where namespace=p_namespace and state in('done','dead') and updated_at<p_before),
 'sourceEvidenceDeletion',false)
$$;

create function public.edgar_release_write(p_namespace text,p_dataset text,p_key text,p_claim jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare n integer; begin
 update public.edgar_dataset_heads set owner=null,lease_until=null where namespace=p_namespace and dataset=p_dataset and resource_key=p_key
   and generation=(p_claim->>'generation')::bigint and owner=(p_claim->>'owner')::uuid;
 get diagnostics n=row_count; return n=1;
end $$;
create function public.edgar_read_financial_metrics(p_namespace text,p_version uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(s)),'[]') from (
  select m.metric,m.value::text as value,m.unit,m.period_start,m.period_end,m.taxonomy,m.concept,m.accession,m.form,m.filed,m.fiscal_year,m.fiscal_period,m.context
  from public.edgar_financial_metrics m join public.edgar_dataset_versions v on v.id=m.version_id
  where v.namespace=p_namespace and v.dataset='financial' and v.id=p_version order by m.ordinal limit 512)s
$$;
create function public.edgar_orphan_dry_run(p_namespace text,p_before timestamptz,p_limit integer default 100)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('dryRun',true,'deletionEnabled',false,'objects',coalesce(jsonb_agg(to_jsonb(s)),'[]')) from (
  select o.name,o.created_at,o.metadata->>'size' as stored_bytes from storage.objects o
  where o.bucket_id='edgar-durable-private' and left(o.name,length(p_namespace)+1)=p_namespace||'/'
    and o.created_at<least(p_before,now()-interval '24 hours')
    and not exists(select 1 from public.edgar_source_assets a where a.object_path=o.name)
    and not exists(select 1 from public.edgar_dataset_versions v where v.object_path=o.name)
    and not exists(select 1 from public.edgar_dataset_heads h where h.namespace=p_namespace and h.owner is not null and h.lease_until>now())
  order by o.created_at limit greatest(1,least(p_limit,100)))s
$$;
-- Private bucket only. Existing bucket definitions are not overwritten.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('edgar-durable-private','edgar-durable-private',false,6291456,array['application/gzip']) on conflict(id) do nothing;
do $$ declare t text; f record; begin
  foreach t in array array['edgar_dataset_heads','edgar_source_assets','edgar_dataset_versions','edgar_financial_metrics','edgar_ingestion_jobs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated',t);
    execute format('grant select,insert,update on table public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('edgar_begin_write','edgar_get_version','edgar_publish','edgar_revalidate','edgar_enqueue_job','edgar_claim_job','edgar_finish_job','edgar_store_status','edgar_export_manifests','edgar_retention_dry_run','edgar_release_write','edgar_read_financial_metrics','edgar_orphan_dry_run','edgar_checkpoint_job') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
