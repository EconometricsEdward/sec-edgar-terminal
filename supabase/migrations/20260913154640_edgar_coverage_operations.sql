-- Hourly aggregate evidence for the existing production project. No source,
-- financial, membership, or ingestion-history records are deleted by this job.
create schema if not exists edgar_private;
revoke all on schema edgar_private from public,anon,authenticated;
grant usage on schema edgar_private to service_role;

create table edgar_private.coverage_operations_snapshots (
  namespace text not null check (namespace='production'),
  hour_bucket timestamptz not null check (hour_bucket=date_trunc('hour',hour_bucket,'UTC')),
  observed_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=65536),
  primary key(namespace,hour_bucket)
);
alter table edgar_private.coverage_operations_snapshots enable row level security;
revoke all on edgar_private.coverage_operations_snapshots from public,anon,authenticated;
grant select,insert,delete on edgar_private.coverage_operations_snapshots to service_role;

create function public.edgar_capture_coverage_operations(p_namespace text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  observed timestamptz:=clock_timestamp();
  bucket timestamptz:=date_trunc('hour',observed,'UTC');
  result jsonb;
  coverage jsonb;
  cycles jsonb;
  work jsonb;
  database_stats jsonb;
  storage_stats jsonb;
  availability jsonb;
  maintenance jsonb;
  active_snapshot jsonb;
  job_health jsonb;
  membership_health jsonb;
begin
  if p_namespace is distinct from 'production' then raise exception 'invalid_operations_namespace' using errcode='22023'; end if;
  -- Capture at most once per hour, including retries and operator invocations.
  select payload into result from edgar_private.coverage_operations_snapshots
    where namespace=p_namespace and hour_bucket=bucket;
  if found then return result; end if;

  coverage:=public.edgar_coverage_status(p_namespace);
  select s.snapshot into active_snapshot from edgar_private.membership_control c
    join edgar_private.membership_snapshots s on s.namespace=c.namespace and s.id=c.active_id
    where c.namespace=p_namespace;
  if active_snapshot is null then raise exception 'membership_registry_missing'; end if;
  select jsonb_build_object('activeId',c.active_id,'activeSourceAsOf',active_snapshot#>>'{reference,asOf}',
    'activeIssuers',jsonb_array_length(active_snapshot->'issuers'),'activeSecurities',active_snapshot->'securityCount',
    'candidateId',c.candidate_id,'candidateSourceAsOf',candidate.source_as_of,'candidateSince',candidate.created_at,
    'lastCheckedAt',c.last_checked_at,'lastError',c.last_error,'errorCount',c.error_count,'nextCheckAt',c.next_check_at)
    into membership_health from edgar_private.membership_control c
    left join edgar_private.membership_snapshots candidate on candidate.namespace=c.namespace and candidate.id=c.candidate_id
    where c.namespace=p_namespace;
  -- Exact current calculator keys define maintenance. Retired constituents,
  -- pending candidates and old calculator versions remain in inventory only.
  with issuers as (
    select i->>'cik' cik from jsonb_array_elements(active_snapshot->'issuers') i union select '0000002098'
  ), source_issuers as (
    select cik from issuers union select '0000034088' where exists(select 1 from issuers where cik='0002115436')
  ), expected as (
    select 'sec' dataset,'sec-document' family,resource basis,'sec-documents-v1:CIK'||cik||':'||resource resource_key
      from source_issuers cross join unnest(array['submissions','companyfacts']) resource
    union all select 'financial','analysis',basis,'financial-analysis-v1:analysis-v1.4:context-v3:CIK'||cik||':'||basis||':latest'
      from issuers cross join unnest(array['annual','quarter','ytd','ttm']) basis
    union all select 'financial','compare',basis,'research-compare-v1:compare-v2:context-v3:CIK'||cik||':'||basis||':latest'
      from issuers cross join unnest(array['annual','quarter','ttm']) basis
    union all select 'financial','portfolio',basis,'research-portfolio-v1:analysis-v1.4:context-v3:CIK'||cik||':'||basis||':latest'
      from issuers cross join unnest(array['annual','quarter','ytd','ttm']) basis
  ), checked as (
    select e.*,case when v.id is null then 'missing'
      when h.expires_at is null or h.expires_at<=observed or h.revalidated_at is null or h.revalidated_at>observed+interval '60 seconds' then 'stale'
      else 'fresh' end status
    from expected e left join public.edgar_dataset_heads h on h.namespace=p_namespace and h.dataset=e.dataset and h.resource_key=e.resource_key
      left join public.edgar_dataset_versions v on v.id=h.current_version and v.namespace=h.namespace and v.dataset=h.dataset and v.resource_key=h.resource_key
  ), groups as (
    select dataset,family,basis,count(*) expected,count(*) filter(where status<>'missing') prepared,
      count(*) filter(where status='fresh') fresh,count(*) filter(where status='stale') stale,count(*) filter(where status='missing') missing
    from checked group by 1,2,3
  ) select jsonb_build_object('membershipId',active_snapshot->>'id','sourceAsOf',active_snapshot#>>'{reference,asOf}',
    'issuers',(select count(*) from issuers),'sourceIssuers',(select count(*) from source_issuers),
    'expected',(select count(*) from checked),'prepared',(select count(*) from checked where status<>'missing'),
    'fresh',(select count(*) from checked where status='fresh'),'stale',(select count(*) from checked where status='stale'),
    'missing',(select count(*) from checked where status='missing'),
    'retainedIssuerCount',(select count(*) from edgar_private.membership_retained r where r.namespace=p_namespace and not exists(select 1 from issuers where cik=r.cik)),
    'groups',(select jsonb_agg(to_jsonb(g) order by dataset,family,basis) from groups g)) into maintenance;
  select jsonb_build_object(
    'pending',count(*) filter(where state in ('queued','running','retry')),
    'running',count(*) filter(where state='running'),
    'retryJobs',count(*) filter(where state='retry'),
    'deadJobs',count(*) filter(where state='dead'),
    'expiredLeases',count(*) filter(where state='running' and lease_until<=observed),
    'oldestPendingAt',min(created_at) filter(where state in ('queued','running','retry')),
    'oldestPendingAgeSeconds',greatest(0,extract(epoch from observed-min(created_at) filter(where state in ('queued','running','retry')))),
    'latestProgressAt',max(updated_at),
    'todayJobs',count(*) filter(where split_part(job_key,':',2)=to_char(observed at time zone 'UTC','YYYY-MM-DD'))
  ) into work from public.edgar_ingestion_jobs
    where namespace=p_namespace and dataset='sec' and left(job_key,16)='sec-coverage-v1:';

  select coalesce(jsonb_agg(to_jsonb(c) order by c.cycle desc,c.version),'[]'::jsonb) into cycles from (
    select split_part(job_key,':',2) cycle,split_part(job_key,':',4) version,
      count(*) jobs,count(*) filter(where state='done') done,
      count(*) filter(where state in ('queued','running','retry')) pending,
      count(*) filter(where state='dead') dead,
      count(*) filter(where error_code='SEC_COVERAGE_SUPERSEDED') superseded,
      coalesce(sum(case when checkpoint->>'cursor' ~ '^\d{1,6}$' then (checkpoint->>'cursor')::integer else 0 end),0) visited,
      coalesce(sum(case when checkpoint->>'succeeded' ~ '^\d{1,6}$' then (checkpoint->>'succeeded')::integer else 0 end),0) succeeded,
      coalesce(sum(case when checkpoint->>'workCount' ~ '^\d{1,6}$' then (checkpoint->>'workCount')::integer else 0 end),0) work_count,
      coalesce(sum(case when jsonb_typeof(checkpoint->'retries')='array' then jsonb_array_length(checkpoint->'retries') else 0 end),0) retries,
      coalesce(sum(case when jsonb_typeof(checkpoint->'failures')='array' then jsonb_array_length(checkpoint->'failures') else 0 end),0) failures,
      min(created_at) started_at,max(updated_at) last_progress_at,
      case when count(*)=32 and bool_and(state='done') and count(*) filter(where error_code='SEC_COVERAGE_SUPERSEDED')=0
        then max(updated_at) else null end completed_at,
      greatest(0,extract(epoch from (case when count(*)=32 and bool_and(state='done') then max(updated_at) else observed end)-min(created_at))) elapsed_seconds
    from public.edgar_ingestion_jobs j where j.namespace=p_namespace and j.dataset='sec'
      and job_key ~ '^sec-coverage-v1:\d{4}-\d{2}-\d{2}:\d{2}:[a-f0-9]{16}$'
      and split_part(job_key,':',2)>=to_char((observed-interval '8 days') at time zone 'UTC','YYYY-MM-DD')
      -- Once a date has a frozen registry cohort, legacy duplicate versions are
      -- historical inventory rather than evidence of that day's current health.
      and not exists(select 1 from edgar_private.coverage_cycles cc where cc.namespace=p_namespace
        and to_char(cc.cycle,'YYYY-MM-DD')=split_part(j.job_key,':',2) and cc.universe_version<>split_part(j.job_key,':',4))
    group by 1,2 order by 1 desc,2 limit 7
  ) c;
  -- Display only seven recent cycles, but resolve failures using the complete
  -- job history. A quiet week must not silently erase an unresolved old failure.
  with canonical as materialized (
    select j.* from public.edgar_ingestion_jobs j where j.namespace=p_namespace and j.dataset='sec'
      and j.job_key ~ '^sec-coverage-v1:\d{4}-\d{2}-\d{2}:\d{2}:[a-f0-9]{16}$'
      and not exists(select 1 from edgar_private.coverage_cycles cc where cc.namespace=p_namespace
        and to_char(cc.cycle,'YYYY-MM-DD')=split_part(j.job_key,':',2) and cc.universe_version<>split_part(j.job_key,':',4))
  ), successful as (
    select split_part(job_key,':',2) cycle from canonical group by 1,split_part(job_key,':',4)
      having count(*)=32 and bool_and(state='done') and count(*) filter(where error_code='SEC_COVERAGE_SUPERSEDED')=0
      and sum(case when jsonb_typeof(checkpoint->'failures')='array' then jsonb_array_length(checkpoint->'failures') else 0 end)=0
  ), latest_success as (select max(cycle) cycle from successful)
  select jsonb_build_object('lastSuccessfulCycle',(select cycle from latest_success),
    'unresolvedDeadJobs',count(*) filter(where state='dead'),
    'unresolvedIssuerFailures',coalesce(sum(case when jsonb_typeof(checkpoint->'failures')='array' then jsonb_array_length(checkpoint->'failures') else 0 end),0))
    into job_health from canonical where split_part(job_key,':',2)>coalesce((select cycle from latest_success),'0000-00-00')
      and error_code is distinct from 'SEC_COVERAGE_SUPERSEDED';
  work:=work||job_health||jsonb_build_object(
    'historicalDeadJobs',work->'deadJobs',
    'historicalIssuerFailures',(select coalesce(sum(case when jsonb_typeof(checkpoint->'failures')='array' then jsonb_array_length(checkpoint->'failures') else 0 end),0)
      from public.edgar_ingestion_jobs where namespace=p_namespace and dataset='sec' and left(job_key,16)='sec-coverage-v1:'));

  -- Database-wide cumulative counters, not a count of site visits. No session,
  -- query text, connection string, user identity, or credential is collected.
  select jsonb_build_object(
    'databaseBytes',pg_database_size(current_database()),
    'applicationRelationBytes',coverage->'databaseBytes',
    'connections',numbackends,'transactionsCommitted',xact_commit,'transactionsRolledBack',xact_rollback,
    'blocksRead',blks_read,'blocksHit',blks_hit,'temporaryBytes',temp_bytes,'temporaryFiles',temp_files,
    'deadlocks',deadlocks,'statsResetAt',stats_reset,
    'cacheHitRatioCumulative',case when blks_hit+blks_read>0 then round(blks_hit::numeric/(blks_hit+blks_read),6) else null end
  ) into database_stats from pg_catalog.pg_stat_database where datname=current_database();
  select jsonb_build_object('objects',count(*),
    'bytes',coalesce(sum(case when metadata->>'size' ~ '^\d{1,18}$' then (metadata->>'size')::bigint else 0 end),0),
    'objectsWithoutSize',count(*) filter(where metadata->>'size' is null or metadata->>'size' !~ '^\d{1,18}$')
  ) into storage_stats from storage.objects where bucket_id='edgar-durable-private';
  select jsonb_build_object('observations',count(*),'available',count(*) filter(where m.value is not null),
    'unavailable',count(*) filter(where m.value is null),
    'reported',count(*) filter(where m.context->>'classification'='reported'),
    'calculated',count(*) filter(where m.context->>'classification'='calculated'))
    into availability from public.edgar_financial_metrics m
    join public.edgar_dataset_heads h on h.current_version=m.version_id
    where h.namespace=p_namespace and h.dataset='financial';

  result:=jsonb_build_object('schema',1,'observedAt',observed,
    'policy',jsonb_build_object('captureIntervalSeconds',3600,'retentionDays',90,'sourceFreshnessSeconds',90000,
      'dailySweepWarningSeconds',43200,'dailySweepEstimateSeconds',30000),
    'coverageGroups',coverage->'coverageGroups','maintenance',maintenance,'membership',membership_health,'heads',coverage->'heads','versions',coverage->'versions',
    'work',work,'cycles',cycles,'database',database_stats,'privateStorage',storage_stats,
    'metricAvailability',availability,
    'unmeasured',jsonb_build_object('cpuPercent',null,'memoryBytes',null,'billingMonthEgressBytes',null,
      'billingMonthEdgeInvocations',null,'computeSize',null,'spendCapEnabled',null,'concurrentVisitorCapacity',null),
    'interpretation',jsonb_build_object('freshness','Maintenance uses exact active membership keys plus ACU and required predecessor sources. Coverage groups are all retained inventory; unavailable financial history is not a refresh error.',
      'databaseBytes','pg_database_size; excludes WAL and provisioned disk overhead.',
      'privateStorage','Current private bucket object metadata; not billing-period average storage.',
      'counters','Database-wide cumulative totals since statsResetAt; not application request or visitor counts.',
      'cycles','Completion records do not identify whether an invocation was scheduled or manual. A later fully successful daily cycle resolves earlier failure alerts; their historical counts remain.'));
  insert into edgar_private.coverage_operations_snapshots(namespace,hour_bucket,observed_at,payload)
    values(p_namespace,bucket,observed,result) on conflict(namespace,hour_bucket) do nothing;
  -- Only this operational table has DELETE granted or used by this function.
  delete from edgar_private.coverage_operations_snapshots where namespace=p_namespace and hour_bucket<bucket-interval '90 days';
  select payload into result from edgar_private.coverage_operations_snapshots where namespace=p_namespace and hour_bucket=bucket;
  return result;
end $$;

create function public.edgar_coverage_operations(p_namespace text,p_hours integer default 24)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_namespace is distinct from 'production' or p_hours is null or p_hours not between 1 and 168
    then raise exception 'invalid_operations_window' using errcode='22023'; end if;
  select jsonb_build_object('schema',1,'observedAt',now(),'hours',p_hours,
    'latest',(select payload from edgar_private.coverage_operations_snapshots where namespace=p_namespace order by hour_bucket desc limit 1),
    'history',(select coalesce(jsonb_agg(jsonb_build_object('observedAt',s.observed_at,
      'fresh',s.payload->'maintenance'->'fresh','stale',s.payload->'maintenance'->'stale','missing',s.payload->'maintenance'->'missing',
      'inventoryFresh',(select coalesce(sum((g->>'fresh')::bigint),0) from jsonb_array_elements(s.payload->'coverageGroups') g),
      'inventoryStale',(select coalesce(sum((g->>'stale')::bigint),0) from jsonb_array_elements(s.payload->'coverageGroups') g),
      'pending',s.payload->'work'->'pending','unresolvedDeadJobs',s.payload->'work'->'unresolvedDeadJobs',
      'oldestPendingAgeSeconds',s.payload->'work'->'oldestPendingAgeSeconds',
      'database',s.payload->'database','privateStorage',s.payload->'privateStorage') order by s.hour_bucket),'[]'::jsonb)
      from (select * from edgar_private.coverage_operations_snapshots where namespace=p_namespace
        and hour_bucket>=date_trunc('hour',now(),'UTC')-make_interval(hours=>p_hours) order by hour_bucket desc limit 169) s)) into result;
  if octet_length(result::text)>262144 then raise exception 'operations_response_too_large' using errcode='22023'; end if;
  return result;
end $$;

revoke all on function public.edgar_capture_coverage_operations(text) from public,anon,authenticated;
revoke all on function public.edgar_coverage_operations(text,integer) from public,anon,authenticated;
grant execute on function public.edgar_capture_coverage_operations(text) to service_role;
grant execute on function public.edgar_coverage_operations(text,integer) to service_role;

-- SQL-only collection consumes no web request or Edge Function invocation.
select cron.schedule('edgar-coverage-operations-v1','7 * * * *',
  $$select public.edgar_capture_coverage_operations('production');$$);
select public.edgar_capture_coverage_operations('production');
