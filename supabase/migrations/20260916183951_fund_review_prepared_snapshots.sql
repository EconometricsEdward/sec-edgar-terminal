-- Prepared read surfaces and bounded cached-result batches. Existing job,
-- source, retry, lease, daily execution and payload allowances remain unchanged.
alter table edgar_private.fund_review_jobs
  add column display_metadata jsonb not null default '{}'::jsonb,
  add column publication jsonb,
  add column publication_version bigint not null default 0 check(publication_version>=0),
  add column published_at timestamptz,
  add constraint fund_review_publication_bytes check(publication is null or octet_length(publication::text)<=4194304);

create function edgar_private.fund_review_display_metadata(p_report jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('manager',p_report->'manager','coverage',p_report->'coverage',
    'portfolioComplete',p_report#>'{portfolio,complete}',
    'denominatorUsd',case when p_report#>>'{portfolio,complete}'='true' and p_report#>>'{coverage,selectedPeriodComplete}'='true' then p_report#>'{portfolio,totalValueUsd}' else 'null'::jsonb end,
    'latestFiled',(select max(f->>'filingDate') from jsonb_array_elements(coalesce(p_report#>'{portfolio,filings}','[]'::jsonb)) f),
    'report',jsonb_build_object('cik',p_report#>'{manager,cik}','period',p_report->'selectedPeriod',
      'managerName',p_report#>'{manager,name}','totalValueUsd',p_report#>'{portfolio,totalValueUsd}',
      'complete',p_report#>>'{portfolio,complete}'='true' and p_report#>>'{coverage,selectedPeriodComplete}'='true'
        and coalesce((p_report#>>'{portfolio,totalValueUsd}')::numeric,0)>0,
      'observedAt',p_report->'observedAt','filings',(select coalesce(jsonb_agg(jsonb_build_object(
        'accession',f->'accession','form',f->'form','filingDate',f->'filingDate','reportDate',f->'reportDate',
        'primaryUrl',f->'primaryUrl','indexUrl',f->'indexUrl') order by f->>'filingDate' desc),'[]'::jsonb)
        from (select value f from jsonb_array_elements(coalesce(p_report#>'{portfolio,filings}','[]'::jsonb)) order by value->>'filingDate' desc limit 8) filings)));
$$;
revoke all on function edgar_private.fund_review_display_metadata(jsonb) from public,anon,authenticated;
grant execute on function edgar_private.fund_review_display_metadata(jsonb) to service_role;
-- One bounded metadata backfill for existing jobs; GET never downloads frozen
-- holdings to obtain progress. Legacy publications are populated on next release.
update edgar_private.fund_review_jobs set display_metadata=edgar_private.fund_review_display_metadata(report);


create view edgar_private.fund_review_progress with (security_invoker=true) as
select j.id,j.namespace,j.cik,j.period,j.display_metadata->'latestFiled' latest_filed,
  j.publication_version::text publication_version,j.published_at,
  jsonb_build_object('id',j.id,'cik',j.cik,'period',j.period,'reportHash',j.report_hash,
    'manager',j.display_metadata->'manager','total',j.total,'state',j.state,'status',case when j.state='working' and j.lease_until>clock_timestamp() then 'running'
      when j.state='capacity' then 'capacity_paused'
      when j.state not in ('complete','complete_with_gaps') and exists(select 1 from edgar_private.fund_review_daily_budget d where d.namespace=j.namespace and d.day=(clock_timestamp() at time zone 'UTC')::date and (d.attempts>=6000 or d.reserved_seconds>14310)) then 'budget_paused'
      when j.state in ('working','retry') then 'queued' else j.state end,'cycle',j.cycle,'reviewed',j.terminal,'attempted',j.reviewed,'terminal',j.terminal,
    'createdAt',j.created_at,'updatedAt',j.updated_at,'reportCheckedAt',j.report_checked_at,
    'completedAt',j.completed_at,'nextCheckAt',j.next_check_at,'nextAttemptAt',case when exists(select 1 from edgar_private.fund_review_daily_budget d where d.namespace=j.namespace and d.day=(clock_timestamp() at time zone 'UTC')::date and (d.attempts>=6000 or d.reserved_seconds>14310)) then date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'+interval '1 day' else j.next_attempt_at end,
    'denominatorUsd',j.display_metadata->'denominatorUsd',
    'coverage',j.display_metadata->'coverage','portfolioComplete',j.display_metadata->'portfolioComplete') job
from edgar_private.fund_review_jobs j;
revoke all on edgar_private.fund_review_progress from public,anon,authenticated;
grant select on edgar_private.fund_review_progress to service_role;


create or replace function public.edgar_fund_review_read(p_namespace text,p_cik text,p_period date,p_report_hash text default null,
  p_market text default null,p_status text default null,p_query text default null,p_offset integer default 0,p_limit integer default 25)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='8s' as $$
declare j edgar_private.fund_review_jobs%rowtype; coverage_json jsonb; markets_json jsonb; rows_json jsonb; filtered_count integer; denominator numeric;
begin
  if p_namespace is distinct from 'production' or coalesce(p_cik,'') !~ '^[0-9]{10}$' or p_cik='0000000000'
    or p_offset not between 0 and 20000 or p_limit not between 1 and 50 or coalesce(length(p_query),0)>100
    or (p_status is not null and p_status not in ('all','unchecked','linked','partial','disclosure_only','no_matches','no_filing','unresolved','unavailable'))
    or coalesce(length(p_market),0)>120 then raise exception 'invalid_fund_review_query' using errcode='22023'; end if;
  select * into j from edgar_private.fund_review_jobs where namespace=p_namespace and cik=p_cik and period=p_period;
  if j.id is null then return null; end if;
  if p_report_hash is not null and p_report_hash<>j.report_hash then raise exception 'stale_fund_review_report' using errcode='PT409'; end if;
  if j.report#>>'{portfolio,complete}'='true' and j.report#>>'{coverage,selectedPeriodComplete}'='true' then
    denominator:=nullif((j.report#>>'{portfolio,totalValueUsd}')::numeric,0);
  end if;
  select jsonb_build_object('total',j.total,'reviewed',count(*) filter(where cycle=j.cycle and terminal),
    'attempted',count(*) filter(where cycle=j.cycle),'available',count(*),'checked',count(*) filter(where summary->>'checked'='true'),
    'linked',count(*) filter(where jsonb_array_length(summary->'markets')>0),
    'disclosureOnly',count(*) filter(where summary->>'disclosureOnly'='true'),
    'unresolved',count(*) filter(where summary->>'status'='unresolved'),'unavailable',count(*) filter(where outcome='unavailable'),
    'partial',count(*) filter(where outcome='partial'),'noMatches',count(*) filter(where summary->>'status'='no_matches'),
    'noFiling',count(*) filter(where summary->>'status'='no_filing'),'unchecked',j.total-count(*),
    'stale',count(*) filter(where cycle<>j.cycle or summary->>'stale'='true'),
    'checkedSharePct',case when denominator>0 then coalesce(sum((summary#>>'{holding,valueUsd}')::numeric) filter(where summary->>'checked'='true'),0)/denominator*100 else null end,
    'linkedSharePct',case when denominator>0 then coalesce(sum((summary#>>'{holding,valueUsd}')::numeric) filter(where jsonb_array_length(summary->'markets')>0),0)/denominator*100 else null end)
    into coverage_json from edgar_private.fund_review_results where job_id=j.id;
  select coalesce(jsonb_agg(market||jsonb_build_object('holdingCount',holding_count,'count',holding_count,'valueUsd',value_usd,
    'sharePct',case when denominator>0 then value_usd/denominator*100 else null end) order by value_usd desc nulls last,market->>'key'),'[]'::jsonb)
    into markets_json from (
      select (jsonb_agg(m.value order by r.ordinal)->0) market,count(*) holding_count,sum((r.summary#>>'{holding,valueUsd}')::numeric) value_usd
      from edgar_private.fund_review_results r cross join lateral jsonb_array_elements(r.summary->'markets') m(value)
      where r.job_id=j.id group by m.value->>'key'
    ) groups;
  with holdings as (
    select h.ordinality::integer ordinal,h.value holding,r.summary,r.attempts,r.terminal,r.cycle,r.updated_at,r.outcome
    from jsonb_array_elements(j.report#>'{portfolio,holdings}') with ordinality h(value,ordinality)
    left join edgar_private.fund_review_results r on r.job_id=j.id and r.ordinal=h.ordinality
  ), filtered as (
    select * from holdings where (p_market is null or p_market='' or exists(select 1 from jsonb_array_elements(coalesce(summary->'markets','[]'::jsonb)) m where m->>'key'=p_market))
      and (p_status is null or p_status='all' or coalesce(outcome,'unchecked')=p_status)
      and (p_query is null or p_query='' or strpos(lower(concat(holding->>'issuer',' ',holding->>'cusip',' ',summary#>>'{issuer,name}',' ',coalesce(summary#>'{issuer,tickers}','[]'::jsonb)::text)),lower(p_query))>0)
  ), paged as (select * from filtered order by ordinal offset p_offset limit p_limit)
  select (select count(*) from filtered),coalesce(jsonb_agg(
    coalesce(summary,jsonb_build_object('holding',holding,'status','unchecked','issuer',null,'message','This holding is queued for review.',
      'checkedAt',null,'markets','[]'::jsonb,'checked',false,'partial',false,'disclosureOnly',false,'retryable',false))
    ||jsonb_build_object('ordinal',ordinal,'key',holding->>'key','attempts',case when cycle=j.cycle then attempts else 0 end,
      'terminal',coalesce(terminal and cycle=j.cycle,false),'cycle',coalesce(cycle,j.cycle),'updatedAt',updated_at,
      'preservedPrevious',coalesce(summary->>'preservedPrevious'='true',false),'stale',coalesce(cycle<>j.cycle or summary->>'stale'='true',false))
    order by ordinal),'[]'::jsonb) into filtered_count,rows_json from paged;
  return jsonb_build_object('job',edgar_private.fund_review_job_json(j),'coverage',coverage_json,'markets',markets_json,'rows',rows_json,
    'report',j.display_metadata->'report','publicationVersion',j.publication_version::text,'publishedAt',j.published_at,
    'page',jsonb_build_object('offset',p_offset,'limit',p_limit,'total',filtered_count));
end; $$;

create function edgar_private.fund_review_publish(p_id uuid)
returns void language plpgsql security invoker set search_path='' set statement_timeout='8s' as $$
declare j edgar_private.fund_review_jobs%rowtype; prepared jsonb;
begin
  update edgar_private.fund_review_jobs set publication_version=publication_version+1,published_at=clock_timestamp()
    where id=p_id returning * into j;
  if j.id is null then return; end if;
  prepared:=public.edgar_fund_review_read(j.namespace,j.cik,j.period,j.report_hash,null,null,null,0,50);
  update edgar_private.fund_review_jobs set publication=prepared where id=j.id;
end; $$;
revoke all on function edgar_private.fund_review_publish(uuid) from public,anon,authenticated;
grant execute on function edgar_private.fund_review_publish(uuid) to service_role;


create or replace function public.edgar_fund_review_enqueue(p_namespace text,p_report jsonb,p_report_hash text)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='1s' set statement_timeout='8s' as $$
declare j edgar_private.fund_review_jobs%rowtype; n integer; h jsonb; checked timestamptz; period_date date; manager_cik text;
begin
  if p_namespace is distinct from 'production' or jsonb_typeof(p_report) is distinct from 'object'
    or coalesce(p_report_hash,'') !~ '^[A-Fa-f0-9]{64}$' or octet_length(p_report::text)>8388608
    or jsonb_typeof(p_report#>'{portfolio,holdings}') is distinct from 'array'
    then raise exception 'invalid_fund_review_report' using errcode='22023'; end if;
  manager_cik:=p_report#>>'{manager,cik}'; period_date:=(p_report->>'selectedPeriod')::date;
  checked:=(p_report#>>'{cache,checkedAt}')::timestamptz;
  n:=jsonb_array_length(p_report#>'{portfolio,holdings}');
  if coalesce(manager_cik,'') !~ '^[0-9]{10}$' or manager_cik='0000000000' or period_date is null
    or to_char(period_date,'MM-DD') not in ('03-31','06-30','09-30','12-31') or period_date>current_date
    or p_report#>>'{portfolio,cik}' is distinct from manager_cik or p_report#>>'{portfolio,period}' is distinct from period_date::text
    or checked is null or checked>clock_timestamp()+interval '1 minute' or n not between 1 and 20000
    or coalesce(p_report#>>'{portfolio,positionCount}','') !~ '^[0-9]{1,5}$' or (p_report#>>'{portfolio,positionCount}')::integer<>n
    or jsonb_typeof(p_report#>'{portfolio,complete}') is distinct from 'boolean'
    or jsonb_typeof(p_report#>'{coverage,selectedPeriodComplete}') is distinct from 'boolean'
    or coalesce(jsonb_typeof(p_report#>'{portfolio,totalValueUsd}'),'missing') not in ('number','null')
    or (p_report#>>'{portfolio,totalValueUsd}')::numeric<0
    then raise exception 'invalid_fund_review_report' using errcode='22023'; end if;
  for h in select value from jsonb_array_elements(p_report#>'{portfolio,holdings}') loop
    if jsonb_typeof(h) is distinct from 'object' or coalesce(h->>'key','') !~ '^[A-Z0-9*@#]{9}\|(SECURITY|PUT|CALL)\|(SH|PRN)$'
      or h->>'key' is distinct from concat(h->>'cusip','|',coalesce(nullif(h->>'putCall',''),'SECURITY'),'|',h->>'quantityType')
      or coalesce(length(h->>'issuer'),0) not between 1 and 500 or coalesce(length(h->>'classTitle'),0)>500
      or coalesce(jsonb_typeof(h->'valueUsd'),'missing') not in ('number','null') or coalesce(jsonb_typeof(h->'quantity'),'missing') not in ('number','null')
      or (h->>'valueUsd')::numeric<0 or (h->>'quantity')::numeric<0
      then raise exception 'invalid_fund_review_holding' using errcode='22023'; end if;
  end loop;
  if (select count(distinct value->>'key') from jsonb_array_elements(p_report#>'{portfolio,holdings}'))<>n then
    raise exception 'duplicate_fund_review_holding' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(164812305,1);
  select * into j from edgar_private.fund_review_jobs where namespace=p_namespace and cik=manager_cik and period=period_date for update;
  if j.id is not null then
    if j.report_hash=p_report_hash then
      update edgar_private.fund_review_jobs set report_checked_at=greatest(report_checked_at,checked),last_requested_at=clock_timestamp() where id=j.id returning * into j;
      if j.publication is null then perform edgar_private.fund_review_publish(j.id); end if;
      return edgar_private.fund_review_job_json(j)||jsonb_build_object('joined',true);
    end if;
    if checked<=j.report_checked_at then raise exception 'stale_fund_review_report' using errcode='PT409'; end if;
    delete from edgar_private.fund_review_results where job_id=j.id;
    update edgar_private.fund_review_jobs set report=p_report,report_hash=p_report_hash,report_checked_at=checked,total=n,
      state='queued',generation=generation+1,owner=null,lease_until=null,cycle=cycle+1,reviewed=0,terminal=0,result_bytes=0,
      updated_at=clock_timestamp(),last_requested_at=clock_timestamp(),completed_at=null,next_check_at=null,next_attempt_at=clock_timestamp() where id=j.id returning * into j;
  else
    delete from edgar_private.fund_review_jobs where id=(select id from edgar_private.fund_review_jobs where namespace=p_namespace and state in ('complete','complete_with_gaps') and last_requested_at<clock_timestamp()-interval '30 days' and (lease_until is null or lease_until<=clock_timestamp()) order by last_requested_at,id limit 1) and (select count(*) from edgar_private.fund_review_jobs where namespace=p_namespace)>=20;
    if (select count(*) from edgar_private.fund_review_jobs where namespace=p_namespace)>=20 then
      raise exception 'fund_review_capacity' using errcode='54000'; end if;
    insert into edgar_private.fund_review_jobs(namespace,cik,period,report_hash,report,report_checked_at,total)
      values(p_namespace,manager_cik,period_date,p_report_hash,p_report,checked,n) returning * into j;
  end if;
  update edgar_private.fund_review_jobs set display_metadata=edgar_private.fund_review_display_metadata(p_report),publication=null where id=j.id;
  perform edgar_private.fund_review_publish(j.id);
  return edgar_private.fund_review_job_json(j)||jsonb_build_object('joined',false);
end; $$;

create or replace function public.edgar_fund_review_release(p_namespace text,p_claim jsonb)
returns boolean language plpgsql security invoker set search_path='' set lock_timeout='1s' set statement_timeout='5s' as $$
declare j edgar_private.fund_review_jobs%rowtype; reviewed_count integer; terminal_count integer; gaps integer; due timestamptz; refund integer;
begin
  if p_namespace is distinct from 'production' then raise exception 'invalid_namespace' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(164812305,1);
  select * into j from edgar_private.fund_review_jobs where namespace=p_namespace and id=(p_claim->>'id')::uuid for update;
  if j.id is null or j.report_hash is distinct from p_claim->>'reportHash' or j.generation is distinct from (p_claim->>'generation')::bigint
    or j.owner is distinct from (p_claim->>'owner')::uuid or j.cycle is distinct from (p_claim->>'cycle')::integer
    or j.lease_until is null or j.lease_until<=clock_timestamp() then return false; end if;
  select count(*),count(*) filter(where terminal),count(*) filter(where outcome in ('unavailable','partial')),
    min(next_attempt_at) filter(where not terminal) into reviewed_count,terminal_count,gaps,due
    from edgar_private.fund_review_results where job_id=j.id and cycle=j.cycle;
  update edgar_private.fund_review_jobs set owner=null,lease_until=null,reviewed=reviewed_count,terminal=terminal_count,
    state=case when terminal_count=j.total then case when gaps>0 then 'complete_with_gaps' else 'complete' end
      when reviewed_count<j.total then 'queued' else 'retry' end,
    completed_at=case when terminal_count=j.total then clock_timestamp() else completed_at end,
    next_check_at=case when terminal_count=j.total then clock_timestamp()+interval '24 hours' else next_check_at end,
    next_attempt_at=case when reviewed_count<j.total then clock_timestamp() else coalesce(due,clock_timestamp()+interval '24 hours') end,
    updated_at=clock_timestamp() where id=j.id;
  perform edgar_private.fund_review_publish(j.id);
  refund:=greatest(0,coalesce(j.lease_reserved_seconds,0)-greatest(1,ceil(extract(epoch from (clock_timestamp()-j.lease_started_at)))::integer));
  update edgar_private.fund_review_daily_budget set reserved_seconds=greatest(0,reserved_seconds-refund) where namespace=p_namespace and day=j.lease_budget_day;
  return true;
end; $$;

create or replace function public.edgar_fund_review_work(p_namespace text,p_claim jsonb,p_limit integer)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare j edgar_private.fund_review_jobs%rowtype; answer jsonb; remaining integer;
begin
  if p_namespace is distinct from 'production' or p_limit not between 1 and 100 then raise exception 'invalid_fund_review_work' using errcode='22023'; end if;
  select * into j from edgar_private.fund_review_jobs where namespace=p_namespace and id=(p_claim->>'id')::uuid
    and report_hash=p_claim->>'reportHash' and generation=(p_claim->>'generation')::bigint and owner=(p_claim->>'owner')::uuid
    and cycle=(p_claim->>'cycle')::integer and lease_until>clock_timestamp();
  if j.id is null then return '[]'::jsonb; end if;
  select greatest(0,6000-attempts) into remaining from edgar_private.fund_review_daily_budget where namespace=p_namespace and day=(clock_timestamp() at time zone 'UTC')::date;
  remaining:=coalesce(remaining,6000);
  select coalesce(jsonb_agg(jsonb_build_object('ordinal',ordinal,'holding',holding,'attempts',attempts) order by ordinal),'[]'::jsonb) into answer from (
    select h.ordinality::integer ordinal,h.value holding,case when r.cycle=j.cycle then r.attempts else 0 end attempts
    from jsonb_array_elements(j.report#>'{portfolio,holdings}') with ordinality h(value,ordinality)
    left join edgar_private.fund_review_results r on r.job_id=j.id and r.ordinal=h.ordinality
    where r.job_id is null or r.cycle<>j.cycle or (not r.terminal and r.next_attempt_at<=clock_timestamp() and r.generation<>j.generation)
    order by h.ordinality limit least(p_limit,remaining)
  ) pending;
  return answer;
end; $$;

create or replace function public.edgar_fund_review_work(p_namespace text,p_claim jsonb,p_limit integer,p_after_ordinal integer)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='5s' as $$
declare j edgar_private.fund_review_jobs%rowtype; answer jsonb; remaining integer;
begin
  if p_namespace is distinct from 'production' or p_limit not between 1 and 100 or p_after_ordinal not between 0 and 20000 then raise exception 'invalid_fund_review_work' using errcode='22023'; end if;
  select * into j from edgar_private.fund_review_jobs where namespace=p_namespace and id=(p_claim->>'id')::uuid
    and report_hash=p_claim->>'reportHash' and generation=(p_claim->>'generation')::bigint and owner=(p_claim->>'owner')::uuid
    and cycle=(p_claim->>'cycle')::integer and lease_until>clock_timestamp();
  if j.id is null then return '[]'::jsonb; end if;
  select greatest(0,6000-attempts) into remaining from edgar_private.fund_review_daily_budget where namespace=p_namespace and day=(clock_timestamp() at time zone 'UTC')::date;
  remaining:=coalesce(remaining,6000);
  select coalesce(jsonb_agg(jsonb_build_object('ordinal',ordinal,'holding',holding,'attempts',attempts) order by ordinal),'[]'::jsonb) into answer from (
    select h.ordinality::integer ordinal,h.value holding,case when r.cycle=j.cycle then r.attempts else 0 end attempts
    from jsonb_array_elements(j.report#>'{portfolio,holdings}') with ordinality h(value,ordinality)
    left join edgar_private.fund_review_results r on r.job_id=j.id and r.ordinal=h.ordinality
    where h.ordinality>p_after_ordinal and (r.job_id is null or r.cycle<>j.cycle or (not r.terminal and r.next_attempt_at<=clock_timestamp() and r.generation<>j.generation))
    order by h.ordinality limit least(p_limit,remaining)
  ) pending;
  return answer;
end; $$;

create or replace function public.edgar_fund_review_save(p_namespace text,p_claim jsonb,p_ordinal integer,p_result jsonb,p_summary jsonb,p_retry_seconds integer)
returns boolean language plpgsql security invoker set search_path='' set lock_timeout='1s' set statement_timeout='8s' as $$
declare j edgar_private.fund_review_jobs%rowtype; prior edgar_private.fund_review_results%rowtype;
  h jsonb; binding text; attempt integer; final boolean; result_json jsonb:=p_result; summary_json jsonb:=p_summary;
  bytes integer; old_bytes integer:=0; used_bytes bigint; input_hash text; daily_day date:=(clock_timestamp() at time zone 'UTC')::date;
begin
  if p_namespace is distinct from 'production' or p_ordinal not between 1 and 20000
    or (p_retry_seconds<>0 and p_retry_seconds not between 60 and 86400)
    or jsonb_typeof(p_result) is distinct from 'object' or jsonb_typeof(p_summary) is distinct from 'object'
    or octet_length(p_result::text)>1048576 or octet_length(p_summary::text)>65536
    then raise exception 'invalid_fund_review_result' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(164812305,1);
  select * into j from edgar_private.fund_review_jobs where namespace=p_namespace and id=(p_claim->>'id')::uuid for update;
  if j.id is null or j.report_hash is distinct from p_claim->>'reportHash' or j.generation is distinct from (p_claim->>'generation')::bigint
    or j.owner is distinct from (p_claim->>'owner')::uuid or j.cycle is distinct from (p_claim->>'cycle')::integer
    or j.lease_until is null or j.lease_until<=clock_timestamp() then return false; end if;
  h:=j.report#>array['portfolio','holdings',(p_ordinal-1)::text];
  if h is null then raise exception 'invalid_fund_review_holding' using errcode='22023'; end if;
  foreach binding in array array['key','cusip','issuer','classTitle','putCall','quantity','quantityType','valueUsd','weightPct'] loop
    if coalesce(p_result->'holding'->binding,'null'::jsonb) is distinct from coalesce(h->binding,'null'::jsonb)
      or coalesce(p_summary->'holding'->binding,'null'::jsonb) is distinct from coalesce(h->binding,'null'::jsonb) then
      raise exception 'fund_review_identity_mismatch' using errcode='22023'; end if;
  end loop;
  if exists(select 1 from jsonb_object_keys(p_summary) k where k not in ('holding','status','issuer','message','checkedAt','markets','checked','partial','disclosureOnly','retryable','sources'))
    or p_summary->>'status' not in ('linked','partial','disclosure_only','no_matches','no_filing','unresolved','unavailable')
    or p_summary->>'status' is null or jsonb_typeof(p_summary->'markets') is distinct from 'array'
    or jsonb_array_length(p_summary->'markets')>40
    or exists(select 1 from jsonb_array_elements(p_summary->'markets') m where jsonb_typeof(m) is distinct from 'object'
      or coalesce(m->>'family','') not in ('tff','disaggregated')
      or coalesce(m->>'contract','') !~ '^[A-Z0-9+]{3,12}$'
      or m->>'group' is distinct from case when m->>'family'='tff' then 'leveraged-funds' else 'managed-money' end
      or m->>'key' is distinct from concat(m->>'family',':',m->>'contract',':',m->>'group')
      or coalesce(length(m->>'label'),0)>200 or coalesce(length(m->>'basisLimit'),0)>1200
      or coalesce(m->>'category','') not in ('rates','currencies','energy','metals','agriculture','other'))
    or jsonb_typeof(p_summary->'checked') is distinct from 'boolean' or jsonb_typeof(p_summary->'partial') is distinct from 'boolean'
    or jsonb_typeof(p_summary->'disclosureOnly') is distinct from 'boolean' or jsonb_typeof(p_summary->'retryable') is distinct from 'boolean'
    or coalesce(length(p_summary->>'message'),0)>2000 or (p_summary->>'checkedAt')::timestamptz is null
    or (p_summary->>'checkedAt')::timestamptz>clock_timestamp()+interval '1 minute'
    or (select count(distinct value->>'key') from jsonb_array_elements(p_summary->'markets'))<>jsonb_array_length(p_summary->'markets')
    then raise exception 'invalid_fund_review_summary' using errcode='22023'; end if;
  if p_summary ? 'sources' then
    if jsonb_typeof(p_summary->'sources') is distinct from 'array' or jsonb_array_length(p_summary->'sources')>3
      or exists(select 1 from jsonb_array_elements(p_summary->'sources') src where jsonb_typeof(src) is distinct from 'object'
        or coalesce(src->>'accession','') !~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'
        or coalesce(src->>'form','') not in ('10-K','10-Q','20-F','40-F')
        or coalesce(p_summary#>>'{issuer,cik}','') !~ '^[0-9]{10}$'
        or coalesce(src->>'url','') !~* ('^https://www\.sec\.gov/Archives/edgar/data/'||((p_summary#>>'{issuer,cik}')::bigint)::text||'/'||replace(src->>'accession','-','')||'/[A-Za-z0-9][A-Za-z0-9._-]*\.(htm|html|txt)$')
        or coalesce(src->>'filed','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or coalesce(src->>'reportDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
      raise exception 'invalid_fund_review_sources' using errcode='22023'; end if;
  end if;
  if p_result#>>'{manager,cik}' is distinct from j.cik or p_result->>'selectedPeriod' is distinct from j.period::text then
    raise exception 'fund_review_identity_mismatch' using errcode='22023'; end if;
  select * into prior from edgar_private.fund_review_results where job_id=j.id and ordinal=p_ordinal;
  input_hash:=encode(sha256(convert_to(p_result::text||p_summary::text||p_retry_seconds::text,'UTF8')),'hex');
  if prior.generation=j.generation and prior.cycle=j.cycle then return prior.attempt_hash=input_hash; end if;
  if prior.cycle=j.cycle and prior.terminal then return false; end if;
  attempt:=case when prior.cycle=j.cycle then prior.attempts+1 else 1 end;
  if attempt>3 then return false; end if;
  final:=p_retry_seconds=0 or attempt>=3;
  -- Preserve previous verified evidence when a later refresh fails. The status
  -- and attempt metadata still disclose the latest failure and original dates.
  if prior.job_id is not null and prior.payload->>'status'='ready' and prior.summary->>'partial'='false' and p_summary->>'status' in ('unavailable','partial') then
    result_json:=prior.payload;
    summary_json:=prior.summary||jsonb_build_object('preservedPrevious',true,'latestAttemptAt',p_summary->'checkedAt',
      'lastError',p_summary->'message','retryable',p_summary->'retryable','stale',true);
  end if;
  bytes:=octet_length(result_json::text)+octet_length(summary_json::text); old_bytes:=coalesce(prior.payload_bytes,0);
  select coalesce(sum(result_bytes),0) into used_bytes from edgar_private.fund_review_jobs where namespace=p_namespace;
  if used_bytes-old_bytes+bytes>536870912 then
    update edgar_private.fund_review_jobs set state='capacity',owner=null,lease_until=null,updated_at=clock_timestamp() where id=j.id;
    return false;
  end if;
  insert into edgar_private.fund_review_daily_budget(namespace,day) values(p_namespace,daily_day) on conflict do nothing;
  if (select attempts from edgar_private.fund_review_daily_budget where namespace=p_namespace and day=daily_day)>=6000 then return false; end if;
  insert into edgar_private.fund_review_results(job_id,ordinal,holding_key,cycle,generation,attempt_hash,attempts,terminal,outcome,next_attempt_at,payload,summary,payload_bytes)
    values(j.id,p_ordinal,h->>'key',j.cycle,j.generation,input_hash,attempt,final,p_summary->>'status',
      case when final then null else clock_timestamp()+make_interval(secs=>p_retry_seconds) end,result_json,summary_json,bytes)
    on conflict(job_id,ordinal) do update set cycle=excluded.cycle,generation=excluded.generation,attempt_hash=excluded.attempt_hash,attempts=excluded.attempts,
      terminal=excluded.terminal,outcome=excluded.outcome,next_attempt_at=excluded.next_attempt_at,payload=excluded.payload,
      summary=excluded.summary,payload_bytes=excluded.payload_bytes,updated_at=clock_timestamp();
  update edgar_private.fund_review_daily_budget set attempts=attempts+1 where namespace=p_namespace and day=daily_day;
  update edgar_private.fund_review_jobs set result_bytes=result_bytes-old_bytes+bytes,
    reviewed=reviewed+case when prior.cycle=j.cycle then 0 else 1 end,
    terminal=terminal+case when final then 1 else 0 end-case when prior.cycle=j.cycle and prior.terminal then 1 else 0 end,
    updated_at=clock_timestamp() where id=j.id;
  if j.lease_until<=clock_timestamp() then raise exception 'fund_review_lease_expired' using errcode='40001'; end if;
  return true;
end; $$;

create function public.edgar_fund_review_save_batch(p_namespace text,p_claim jsonb,p_results jsonb)
returns boolean language plpgsql security invoker set search_path='' set lock_timeout='1s' set statement_timeout='8s' as $$
declare entry jsonb; capacity_blocked boolean:=false; j edgar_private.fund_review_jobs%rowtype;
begin
  if p_namespace is distinct from 'production' or jsonb_typeof(p_results) is distinct from 'array'
    or jsonb_array_length(p_results) not between 1 and 50 or octet_length(p_results::text)>9437184
    or exists(select 1 from jsonb_array_elements(p_results) e where jsonb_typeof(e) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(e) k where k not in ('ordinal','result','summary','retrySeconds'))
      or coalesce(e->>'ordinal','') !~ '^[0-9]{1,5}$')
    or (select count(distinct e->>'ordinal') from jsonb_array_elements(p_results) e)<>jsonb_array_length(p_results)
    then raise exception 'invalid_fund_review_batch' using errcode='22023'; end if;
  -- Each existing save enforces the same report identity, lease generation,
  -- per-holding retry limit and shared accounting. A subtransaction prevents a
  -- partial acknowledgement if even one entry cannot be written.
  begin
    for entry in select value from jsonb_array_elements(p_results) loop
      if not public.edgar_fund_review_save(p_namespace,p_claim,(entry->>'ordinal')::integer,
        entry->'result',entry->'summary',(entry->>'retrySeconds')::integer) then
        select state='capacity' into capacity_blocked from edgar_private.fund_review_jobs
          where namespace=p_namespace and id=(p_claim->>'id')::uuid;
        raise exception 'fund_review_batch_rejected' using errcode='PFR01';
      end if;
    end loop;
  exception when sqlstate 'PFR01' then
    if capacity_blocked then
      -- Preserve the existing visible capacity pause after rolling back the
      -- batch's bytes, attempt counters and earlier provisional result writes.
      perform pg_advisory_xact_lock(164812305,1);
      select * into j from edgar_private.fund_review_jobs where namespace=p_namespace and id=(p_claim->>'id')::uuid for update;
      if j.report_hash=p_claim->>'reportHash' and j.generation=(p_claim->>'generation')::bigint
        and j.owner=(p_claim->>'owner')::uuid and j.cycle=(p_claim->>'cycle')::integer and j.lease_until>clock_timestamp() then
        update edgar_private.fund_review_jobs set state='capacity',owner=null,lease_until=null,updated_at=clock_timestamp() where id=j.id;
      end if;
    end if;
    return false;
  end;
  return true;
end; $$;

create function public.edgar_fund_review_progress(p_namespace text,p_cik text,p_period date default null)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='2s' as $$
declare answer jsonb;
begin
  if p_namespace is distinct from 'production' or coalesce(p_cik,'') !~ '^[0-9]{10}$' or p_cik='0000000000'
    or (p_period is not null and to_char(p_period,'MM-DD') not in ('03-31','06-30','09-30','12-31')) then
    raise exception 'invalid_fund_review_query' using errcode='22023'; end if;
  select jsonb_build_object('job',p.job,'publicationVersion',p.publication_version,'publishedAt',p.published_at) into answer
    from edgar_private.fund_review_progress p where p.namespace=p_namespace and p.cik=p_cik and (p_period is null or p.period=p_period)
    order by p.period desc limit 1;
  return answer;
end; $$;

create function public.edgar_fund_review_snapshot(p_namespace text,p_cik text,p_period date default null)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='8s' as $$
declare progress jsonb; prepared jsonb; reports jsonb; selected date;
begin
  progress:=public.edgar_fund_review_progress(p_namespace,p_cik,p_period);
  if progress is null then return null; end if;
  selected:=(progress#>>'{job,period}')::date;
  select publication into prepared from edgar_private.fund_review_jobs where namespace=p_namespace and cik=p_cik and period=selected;
  -- Legacy jobs stay usable before their first worker release. This fallback
  -- reads stored rows only and never starts work or contacts an upstream source.
  if prepared is null then prepared:=public.edgar_fund_review_read(p_namespace,p_cik,selected,progress#>>'{job,reportHash}',null,null,null,0,50); end if;
  select coalesce(jsonb_agg(jsonb_build_object('period',period,'latestFiled',latest_filed) order by period desc),'[]'::jsonb) into reports
    from edgar_private.fund_review_progress where namespace=p_namespace and cik=p_cik;
  return prepared||progress||jsonb_build_object('reports',reports);
end; $$;

revoke all on function public.edgar_fund_review_work(text,jsonb,integer,integer),
  public.edgar_fund_review_save_batch(text,jsonb,jsonb),public.edgar_fund_review_snapshot(text,text,date),
  public.edgar_fund_review_progress(text,text,date) from public,anon,authenticated;
grant execute on function public.edgar_fund_review_work(text,jsonb,integer,integer),
  public.edgar_fund_review_save_batch(text,jsonb,jsonb),public.edgar_fund_review_snapshot(text,text,date),
  public.edgar_fund_review_progress(text,text,date) to service_role;

create or replace function public.edgar_fund_review_claim(p_namespace text,p_owner uuid,p_lease_seconds integer)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='1s' set statement_timeout='8s' as $$
declare j edgar_private.fund_review_jobs%rowtype; d edgar_private.fund_review_daily_budget%rowtype; now_at timestamptz:=clock_timestamp();
begin
  if p_namespace is distinct from 'production' or p_owner is null or p_lease_seconds not between 5 and 90 then
    raise exception 'invalid_fund_review_claim' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(164812305,1);
  if exists(select 1 from edgar_private.fund_review_jobs where namespace=p_namespace and lease_until>clock_timestamp()) then return null; end if;
  insert into edgar_private.fund_review_daily_budget(namespace,day) values(p_namespace,(now_at at time zone 'UTC')::date) on conflict do nothing;
  select * into d from edgar_private.fund_review_daily_budget where namespace=p_namespace and day=(now_at at time zone 'UTC')::date for update;
  if d.reserved_seconds+p_lease_seconds>14400 or d.attempts>=6000 then return null; end if;
  while exists(select 1 from edgar_private.fund_review_jobs where namespace=p_namespace and state='capacity') and (select coalesce(sum(result_bytes),0) from edgar_private.fund_review_jobs where namespace=p_namespace)>535756800 loop
    delete from edgar_private.fund_review_jobs where id=(select id from edgar_private.fund_review_jobs where namespace=p_namespace and state in ('complete','complete_with_gaps') and last_requested_at<clock_timestamp()-interval '30 days' and (lease_until is null or lease_until<=clock_timestamp()) order by last_requested_at,id limit 1);
    exit when not found;
  end loop;
  update edgar_private.fund_review_jobs set state='queued',next_attempt_at=clock_timestamp() where namespace=p_namespace and state='capacity' and (select coalesce(sum(result_bytes),0) from edgar_private.fund_review_jobs where namespace=p_namespace)<=535756800;
  select * into j from edgar_private.fund_review_jobs where namespace=p_namespace and (lease_until is null or lease_until<=now_at)
    and ((state in ('queued','retry','working') and next_attempt_at<=now_at) or (state in ('complete','complete_with_gaps') and next_check_at<=now_at))
    order by last_served_at nulls first,created_at,id limit 1 for update;
  if j.id is null then return null; end if;
  update edgar_private.fund_review_daily_budget set reserved_seconds=reserved_seconds+p_lease_seconds where namespace=p_namespace and day=d.day;
  delete from edgar_private.fund_review_daily_budget where namespace=p_namespace and day<d.day-8;
  update edgar_private.fund_review_jobs set cycle=case when state in ('complete','complete_with_gaps') then cycle+1 else cycle end,
    reviewed=case when state in ('complete','complete_with_gaps') then 0 else reviewed end,
    terminal=case when state in ('complete','complete_with_gaps') then 0 else terminal end,
    state='working',generation=generation+1,owner=p_owner,lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    lease_started_at=clock_timestamp(),lease_reserved_seconds=p_lease_seconds,lease_budget_day=d.day,
    last_served_at=clock_timestamp(),updated_at=clock_timestamp() where id=j.id returning * into j;
  return edgar_private.fund_review_job_json(j)||jsonb_build_object('generation',j.generation::text,'owner',j.owner,
    'leaseUntil',j.lease_until,'attemptsRemaining',6000-d.attempts,'report',j.report);
end; $$;
