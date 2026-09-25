-- Bound full-directory writes; publish freshness only when the final batch commits.
create or replace function public.bank_scope_operation(p_operation text,p_payload jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path=pg_catalog,edgar_private as $$
declare c edgar_private.bank_pilot_control%rowtype; b edgar_private.bank_institutions%rowtype;
  j edgar_private.bank_preparation_jobs%rowtype; r edgar_private.bank_call_reports%rowtype;
  t timestamptz:=clock_timestamp(); requested_owner uuid; target_date date; target_id bigint;
  ids bigint[]; q text; banks jsonb; reports jsonb; jobs jsonb; m jsonb; record_id uuid;
  result jsonb; count_new integer:=0; request_total integer; v_hour_start timestamptz:=date_trunc('hour',clock_timestamp());
begin
  if jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>12000000 then raise exception 'invalid_payload' using errcode='22023'; end if;
  if p_operation in ('status','search','read','source','lineage') then
    select * into c from edgar_private.bank_pilot_control where id;
    if p_operation='status' then
      return jsonb_build_object('periods',coalesce(c.catalog->'periods','[]'),'catalog',c.catalog,
        'directoryPeriods',(select coalesce(jsonb_agg(to_jsonb(x) order by x.report_date desc),'[]') from edgar_private.bank_reporting_periods x),
        'bankCount',(select count(*) from edgar_private.bank_institutions),'reportCount',(select count(*) from edgar_private.bank_call_reports),
        'requestCount',c.request_count,'requestMethods',c.request_methods,'hourRequests',c.hour_requests,'dayRequests',c.day_requests,
        'queued',(select count(*) from edgar_private.bank_preparation_jobs where status in ('queued','retry','running')),
        'running',coalesce(c.lease_until>t,false),'cooldownUntil',case when c.cooldown_until>t then c.cooldown_until else null end,
        'lastError',c.last_error,'lastRunResult',c.last_run_result);
    elsif p_operation='search' then
      q:=trim(regexp_replace(lower(coalesce(p_payload->>'query','')),'[^a-z0-9 ]',' ','g'));
      if length(q)>100 then raise exception 'invalid_query'; end if;
      select coalesce(jsonb_agg(to_jsonb(x)),'[]') into banks from (
        select z.id_rssd,z.legal_name,z.fdic_certificate,z.city,z.state,z.form_type,z.directory_report_date,
          (select count(distinct a.report_date) from edgar_private.bank_call_reports a where a.id_rssd=z.id_rssd and a.validation->>'passed'='true'
            and c.catalog->'periods' ? a.report_date::text) as prepared_quarters
        from edgar_private.bank_institutions z where
          (q='' and exists(select 1 from edgar_private.bank_call_reports a where a.id_rssd=z.id_rssd and a.validation->>'passed'='true'))
          or (length(q)>=2 and (z.id_rssd::text=q or z.fdic_certificate::text=q or not exists(
            select 1 from unnest(regexp_split_to_array(q,'\s+')) term where lower(z.legal_name||' '||z.city||' '||z.state) not like '%'||term||'%')))
        order by case when z.id_rssd::text=q or lower(z.legal_name)=q then 0 when lower(z.legal_name) like q||'%' then 1 else 2 end,z.legal_name,z.id_rssd limit 25
      ) x;
      return jsonb_build_object('banks',banks,'bankCount',(select count(*) from edgar_private.bank_institutions),
        'periods',coalesce(c.catalog->'periods','[]'),'directoryAt',c.catalog->'checkedAt');
    elsif p_operation='read' then
      if jsonb_typeof(p_payload->'rssds')<>'array' or jsonb_array_length(p_payload->'rssds') not between 1 and 4 then raise exception 'invalid_selection'; end if;
      ids:=array(select jsonb_array_elements_text(p_payload->'rssds')::bigint);
      select coalesce(jsonb_agg(to_jsonb(x) order by array_position(ids,x.id_rssd)),'[]') into banks from(
        select z.id_rssd,z.legal_name,z.fdic_certificate,z.charter_identifier,z.city,z.state,z.form_type,z.directory_report_date,z.last_verified_at,
          (select coalesce(jsonb_agg(p.report_date::text order by p.report_date desc),'[]') from edgar_private.bank_panel_entries p
            where p.id_rssd=z.id_rssd and c.catalog->'periods' ? p.report_date::text) as available_periods
        from edgar_private.bank_institutions z where z.id_rssd=any(ids))x;
      select coalesce(jsonb_agg(to_jsonb(x) order by x.report_date desc,x.id_rssd),'[]') into reports from(
        select distinct on(z.id_rssd,z.report_date) z.id,z.id_rssd,z.report_date,z.submission_date_raw,z.retrieved_at,z.source_sha256,z.form_type,z.validation,z.source_metadata,
          (select coalesce(jsonb_agg(a.metric-'lineage'-'frameworkLineage'-'sourceHash'-'ingestedAt'-'formSource' order by a.metric_name),'[]') from edgar_private.bank_call_report_metrics a where a.report_id=z.id) as metrics
        from edgar_private.bank_call_reports z where z.id_rssd=any(ids) and c.catalog->'periods' ? z.report_date::text
        order by z.id_rssd,z.report_date,(z.validation->>'passed'='true') desc,z.retrieved_at desc,z.id
      )x;
      select coalesce(jsonb_agg(to_jsonb(x)),'[]') into jobs from(
        select id_rssd,report_date,status,next_attempt_at,last_error from edgar_private.bank_preparation_jobs where id_rssd=any(ids) and c.catalog->'periods' ? report_date::text)x;
      return jsonb_build_object('banks',banks,'reports',reports,'jobs',jobs,'periods',coalesce(c.catalog->'periods','[]'),
        'directoryAt',c.catalog->'checkedAt','cooldownUntil',case when c.cooldown_until>t then c.cooldown_until else null end);
    else
      select * into r from edgar_private.bank_call_reports where id_rssd=(p_payload->>'rssd')::bigint and report_date=(p_payload->>'period')::date
        and (not(p_payload ? 'hash') or source_sha256=p_payload->>'hash')
        and (not(p_payload ? 'submission') or submission_date_raw is not distinct from p_payload->>'submission')
        order by retrieved_at desc limit 1;
      if not found then return null; end if;
      if p_operation='lineage' then
        return (select metric from edgar_private.bank_call_report_metrics where report_id=r.id and metric_name=p_payload->>'metric');
      end if;
      return jsonb_build_object('rawXbrl',r.raw_xbrl,'sha256',r.source_sha256,'rssd',r.id_rssd,'reportDate',r.report_date,
        'retrievedAt',r.retrieved_at,'validation',r.validation,'parserVersion',r.parser_version,'submission',r.submission_date_raw);
    end if;
  end if;
  select * into c from edgar_private.bank_pilot_control where id for update;
  if p_operation='request' then
    target_id:=(p_payload->>'rssd')::bigint;
    select * into b from edgar_private.bank_institutions where id_rssd=target_id;
    if not found then return jsonb_build_object('code','institution_not_found'); end if;
    if coalesce(p_payload->>'clientHash','') !~ '^[a-f0-9]{64}$' then raise exception 'invalid_request_identity'; end if;
    -- Cached/current jobs do not spend admission budget or reset a retry clock.
    if not exists(select 1 from edgar_private.bank_panel_entries p where p.id_rssd=target_id and c.catalog->'periods' ? p.report_date::text
      and not exists(select 1 from edgar_private.bank_preparation_jobs z where z.id_rssd=p.id_rssd and z.report_date=p.report_date)) then
      update edgar_private.bank_institutions set last_requested_at=t where id_rssd=target_id;
      return jsonb_build_object('accepted',true,'queued',0);
    end if;
    select requests into request_total from edgar_private.bank_request_limits where client_hash=p_payload->>'clientHash' and bank_request_limits.hour_start=v_hour_start;
    if coalesce(request_total,0)>=12 then return jsonb_build_object('code','request_limit','retryAt',v_hour_start+interval '1 hour'); end if;
    if (select count(distinct id_rssd) from edgar_private.bank_preparation_jobs where status in ('queued','retry','running'))>=200 then return jsonb_build_object('code','queue_full'); end if;
    insert into edgar_private.bank_request_limits values(p_payload->>'clientHash',v_hour_start,1)
      on conflict(client_hash,hour_start) do update set requests=bank_request_limits.requests+1;
    delete from edgar_private.bank_request_limits where bank_request_limits.hour_start<t-interval '2 days';
    update edgar_private.bank_institutions set last_requested_at=t where id_rssd=target_id;
    insert into edgar_private.bank_preparation_jobs(id_rssd,report_date,desired_submission,status)
      select p.id_rssd,p.report_date,p.submission_date_raw,case when p.has_filed then 'queued' else 'unavailable' end
      from edgar_private.bank_panel_entries p where p.id_rssd=target_id and c.catalog->'periods' ? p.report_date::text
      on conflict(id_rssd,report_date) do nothing;
    get diagnostics count_new=row_count;
    return jsonb_build_object('accepted',true,'queued',count_new);
  end if;
  requested_owner:=(p_payload->>'owner')::uuid;
  if p_operation='begin' then
    if requested_owner is null then raise exception 'invalid_owner'; end if;
    if c.lease_until>t then return jsonb_build_object('allowed',false,'code','ingestion_running'); end if;
    if c.cooldown_until>t then return jsonb_build_object('allowed',false,'code','upstream_cooldown','retryAt',c.cooldown_until); end if;
    update edgar_private.bank_pilot_control set owner=requested_owner,lease_until=t+interval '240 seconds',last_run_at=t,last_error=null where id;
    update edgar_private.bank_preparation_jobs set status='retry',owner=null,next_attempt_at=t where status='running';
    return jsonb_build_object('allowed',true);
  end if;
  if requested_owner is null or c.owner is distinct from requested_owner or c.lease_until<=t then raise exception 'lease_expired' using errcode='40001'; end if;
  if p_operation='reserve' then
    if p_payload->>'method' not in ('RetrieveReportingPeriods','RetrievePanelOfReporters','RetrieveFilersSubmissionDateTime','RetrieveFacsimile') then raise exception 'invalid_method'; end if;
    if c.hour_started_at<date_trunc('hour',t) then c.hour_started_at:=date_trunc('hour',t); c.hour_requests:=0; end if;
    if c.day_started_at<date_trunc('day',t) then c.day_started_at:=date_trunc('day',t); c.day_requests:=0; end if;
    if c.day_requests>=2400 then return jsonb_build_object('allowed',false,'code','daily_budget','retryAt',c.day_started_at+interval '1 day'); end if;
    if c.hour_requests>=600 then return jsonb_build_object('allowed',false,'code','hourly_budget','retryAt',c.hour_started_at+interval '1 hour'); end if;
    if greatest(c.next_request_at,c.cooldown_until)>t then return jsonb_build_object('allowed',false,'code','upstream_cooldown','retryAt',greatest(c.next_request_at,c.cooldown_until)); end if;
    update edgar_private.bank_pilot_control set next_request_at=t+interval '5 seconds',request_count=request_count+1,
      hour_started_at=c.hour_started_at,hour_requests=c.hour_requests+1,day_started_at=c.day_started_at,day_requests=c.day_requests+1,
      request_methods=jsonb_set(request_methods,array[p_payload->>'method'],to_jsonb(coalesce((request_methods->>(p_payload->>'method'))::integer,0)+1)) where id;
    return jsonb_build_object('allowed',true);
  elsif p_operation='cooldown' then
    update edgar_private.bank_pilot_control set cooldown_until=greatest(cooldown_until,(p_payload->>'retryAt')::timestamptz),last_error=left(p_payload->>'code',80) where id;
  elsif p_operation='periods' then
    if jsonb_array_length(p_payload->'periods') not between 1 and 4 or exists(select 1 from jsonb_array_elements_text(p_payload->'periods') x
      where x !~ '^\d{4}-(03-31|06-30|09-30|12-31)$' or x::date>current_date) then raise exception 'invalid_periods'; end if;
    update edgar_private.bank_pilot_control set catalog=jsonb_build_object('periods',p_payload->'periods','checkedAt',t) where id;
  elsif p_operation='catalog' then
    target_date:=(p_payload->>'period')::date;
    if not(c.catalog->'periods' ? target_date::text) or jsonb_array_length(p_payload->'banks') not between 1 and 10000 then raise exception 'invalid_catalog'; end if;
    if exists(select 1 from jsonb_to_recordset(p_payload->'banks') as x(rssd bigint,name text,form text,source jsonb)
      where x.rssd<=0 or x.name is null or x.name='' or x.form not in ('031','041','051') or x.source->>'ID_RSSD' is distinct from x.rssd::text or trim(x.source->>'Name') is distinct from x.name)
      then raise exception 'identity_source_mismatch'; end if;
    insert into edgar_private.bank_institutions(id_rssd,legal_name,fdic_certificate,charter_identifier,institution_status,last_verified_at,identity_source,city,state,form_type,directory_report_date)
      select rssd,name,fdic,charter,'listed_in_call_report_panel',t,source,city,state,form,target_date
      from jsonb_to_recordset(p_payload->'banks') as x(rssd bigint,name text,fdic bigint,charter bigint,source jsonb,city text,state text,form text)
      on conflict(id_rssd) do update set legal_name=excluded.legal_name,fdic_certificate=excluded.fdic_certificate,charter_identifier=excluded.charter_identifier,
        last_verified_at=t,identity_source=excluded.identity_source,city=excluded.city,state=excluded.state,form_type=excluded.form_type,directory_report_date=excluded.directory_report_date
        where bank_institutions.directory_report_date is null or bank_institutions.directory_report_date<=excluded.directory_report_date;
    insert into edgar_private.bank_panel_entries(id_rssd,report_date,form_type,has_filed,submission_date_raw,identity_source)
      select rssd,target_date,form,filed,submission,source from jsonb_to_recordset(p_payload->'banks') as x(rssd bigint,form text,filed boolean,submission text,source jsonb)
      on conflict(id_rssd,report_date) do update set form_type=excluded.form_type,has_filed=excluded.has_filed,submission_date_raw=excluded.submission_date_raw,identity_source=excluded.identity_source;
    if coalesce((p_payload->>'complete')::boolean,true) then
      if coalesce((p_payload->>'reporterCount')::integer,jsonb_array_length(p_payload->'banks')) not between 1 and 10000 then raise exception 'invalid_reporter_count'; end if;
      insert into edgar_private.bank_reporting_periods values(target_date,t,coalesce((p_payload->>'reporterCount')::integer,jsonb_array_length(p_payload->'banks')))
        on conflict(report_date) do update set checked_at=t,reporter_count=excluded.reporter_count;
    end if;
    insert into edgar_private.bank_preparation_jobs(id_rssd,report_date,desired_submission,status)
      select p.id_rssd,p.report_date,p.submission_date_raw,case when p.has_filed then 'queued' else 'unavailable' end
      from edgar_private.bank_panel_entries p join edgar_private.bank_institutions z using(id_rssd)
      where p.report_date=target_date and z.last_requested_at>t-interval '30 days'
      on conflict(id_rssd,report_date) do update set desired_submission=excluded.desired_submission,status=excluded.status,attempts=0,next_attempt_at=t,last_error=null,updated_at=t
      where bank_preparation_jobs.desired_submission is distinct from excluded.desired_submission or (bank_preparation_jobs.status='unavailable' and excluded.status='queued');
  elsif p_operation='claim' then
    select * into j from edgar_private.bank_preparation_jobs where status in ('queued','retry') and next_attempt_at<=t
      and c.catalog->'periods' ? report_date::text order by report_date desc,requested_at,id_rssd limit 1 for update skip locked;
    if not found then return null; end if;
    update edgar_private.bank_preparation_jobs set status='running',owner=requested_owner,attempts=attempts+1,updated_at=t where id=j.id returning * into j;
    return to_jsonb(j)||jsonb_build_object('form',(select form_type from edgar_private.bank_panel_entries where id_rssd=j.id_rssd and report_date=j.report_date));
  elsif p_operation='publish' then
    select * into j from edgar_private.bank_preparation_jobs where id=(p_payload->>'jobId')::uuid and status='running' and owner=requested_owner;
    if not found then raise exception 'job_lease_mismatch'; end if;
    if j.id_rssd<>(p_payload->>'rssd')::bigint or j.report_date<>(p_payload->>'reportDate')::date or j.desired_submission is distinct from p_payload->>'submissionDate'
      or (select form_type from edgar_private.bank_panel_entries where id_rssd=j.id_rssd and report_date=j.report_date) is distinct from p_payload->>'form'
      or jsonb_array_length(p_payload->'metrics') not between 0 and 60 then raise exception 'source_identity_mismatch'; end if;
    select * into b from edgar_private.bank_institutions where id_rssd=j.id_rssd;
    insert into edgar_private.bank_call_reports(institution_id,id_rssd,report_date,submission_date_raw,retrieved_at,source_sha256,form_type,raw_xbrl,parser_version,validation,source_metadata)
      values(b.id,j.id_rssd,j.report_date,j.desired_submission,(p_payload->>'retrievedAt')::timestamptz,p_payload->>'sha256',p_payload->>'form',p_payload->>'rawXbrl',p_payload->>'parserVersion',p_payload->'validation',p_payload->'metadata')
      on conflict(id_rssd,report_date,source_sha256) do update set parser_version=excluded.parser_version,validation=excluded.validation,
        source_metadata=excluded.source_metadata,submission_date_raw=excluded.submission_date_raw
        where jsonb_array_length(p_payload->'metrics')>0 or bank_call_reports.validation->>'passed' is distinct from 'true'
      returning id into record_id;
    if record_id is not null and jsonb_array_length(p_payload->'metrics')>0 then
      for m in select value from jsonb_array_elements(p_payload->'metrics') loop
        if m->>'rssd' is distinct from j.id_rssd::text or m->>'reportDate' is distinct from j.report_date::text or m->>'sourceHash' is distinct from p_payload->>'sha256' then raise exception 'metric_lineage_mismatch'; end if;
        insert into edgar_private.bank_call_report_metrics values(record_id,m->>'key',m->>'schedule',array(select jsonb_array_elements_text(m->'codes')),m->'lineage',(m->>'value')::numeric,m->>'unit',j.report_date,j.id_rssd,m)
          on conflict(report_id,metric_name) do update set schedule=excluded.schedule,item_codes=excluded.item_codes,reported_values=excluded.reported_values,normalized_value=excluded.normalized_value,normalized_unit=excluded.normalized_unit,metric=excluded.metric;
      end loop;
      update edgar_private.bank_preparation_jobs set status=case when p_payload->'validation'->>'passed'='true' then 'ready' else 'review' end,
        owner=null,updated_at=t,last_error=case when p_payload->'validation'->>'passed'='true' then null else 'financial_validation' end where id=j.id;
    end if;
    return jsonb_build_object('stored',record_id is not null);
  elsif p_operation='job_error' then
    update edgar_private.bank_preparation_jobs set status=case when p_payload->>'code'='call_report_not_filed' then 'unavailable'
        when coalesce((p_payload->>'retryable')::boolean,false) and attempts<3 then 'retry' else 'review' end,
      next_attempt_at=greatest(t+interval '5 minutes',coalesce((p_payload->>'retryAt')::timestamptz,t)),last_error=left(p_payload->>'code',80),owner=null,updated_at=t
      where id=(p_payload->>'jobId')::uuid and owner=requested_owner;
  elsif p_operation='finish' then
    update edgar_private.bank_preparation_jobs set status='retry',owner=null,next_attempt_at=t+interval '30 seconds' where owner=requested_owner and status='running';
    update edgar_private.bank_pilot_control set owner=null,lease_until=null,last_finished_at=t,last_error=p_payload->>'code',last_run_result=p_payload->'result' where id;
  else raise exception 'unsupported_operation' using errcode='22023';
  end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.bank_scope_operation(text,jsonb) from public,anon,authenticated;
grant execute on function public.bank_scope_operation(text,jsonb) to service_role;
