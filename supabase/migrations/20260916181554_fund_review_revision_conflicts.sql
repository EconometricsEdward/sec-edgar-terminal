-- A changed report revision is a permanent HTTP conflict, not a retryable
-- PostgreSQL serialization failure. Keep lease-expiry rollback fencing unchanged.

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
  return edgar_private.fund_review_job_json(j)||jsonb_build_object('joined',false);
end; $$;

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
    'report',jsonb_build_object('cik',j.cik,'period',j.period,'managerName',j.report#>>'{manager,name}','totalValueUsd',j.report#>'{portfolio,totalValueUsd}',
      'complete',denominator is not null,'observedAt',j.report->'observedAt'),
    'page',jsonb_build_object('offset',p_offset,'limit',p_limit,'total',filtered_count));
end; $$;

create or replace function public.edgar_fund_review_result(p_namespace text,p_cik text,p_period date,p_report_hash text,p_key text)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='3s' as $$
declare j edgar_private.fund_review_jobs%rowtype; answer jsonb;
begin
  if p_namespace is distinct from 'production' then raise exception 'invalid_namespace' using errcode='22023'; end if;
  select * into j from edgar_private.fund_review_jobs where namespace=p_namespace and cik=p_cik and period=p_period;
  if j.id is null then return null; end if;
  if j.report_hash is distinct from p_report_hash then raise exception 'stale_fund_review_report' using errcode='PT409'; end if;
  select payload into answer from edgar_private.fund_review_results where job_id=j.id and holding_key=p_key;
  return answer;
end; $$;
