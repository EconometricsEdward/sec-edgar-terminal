-- Keep automatic UBPR refresh and queue admission within the retained report window.
create or replace function public.bank_scope_operation(p_operation text,p_payload jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path=pg_catalog,edgar_private as $$
declare c edgar_private.bank_pilot_control%rowtype; s edgar_private.bank_peer_snapshots%rowtype;
  j edgar_private.bank_ubpr_jobs%rowtype; u edgar_private.bank_ubpr_reports%rowtype;
  t timestamptz:=clock_timestamp(); requested_owner uuid; result jsonb; added integer; inserted integer; target_date date; target_id bigint;
begin
  if jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>12000000 then raise exception 'invalid_payload'; end if;
  if p_operation='peer_status' then
    return jsonb_build_object('snapshots',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
      select distinct on(report_date) report_date,completed_at,matched_count,source_index,source_updated_at from edgar_private.bank_peer_snapshots
      where completed_at is not null order by report_date,completed_at desc)x),
      'ubprQueued',(select count(*) from edgar_private.bank_ubpr_jobs where status in ('queued','retry','running')),
      'ubprReports',(select count(*) from edgar_private.bank_ubpr_reports));
  elsif p_operation='peer_universe' then
    target_date:=(p_payload->>'period')::date;
    select * into s from edgar_private.bank_peer_snapshots where report_date=target_date and completed_at is not null order by completed_at desc limit 1;
    if not found then return jsonb_build_object('profiles','[]'::jsonb); end if;
    return jsonb_build_object('snapshot',to_jsonb(s)-'owner','profiles',(select coalesce(jsonb_agg(p.profile||jsonb_build_object(
      'name',b.legal_name,'city',b.city,'state',b.state,'form',e.form_type)),'[]')
      from edgar_private.bank_peer_profiles p join edgar_private.bank_institutions b on b.id_rssd=p.id_rssd
      join edgar_private.bank_panel_entries e on e.id_rssd=p.id_rssd and e.report_date=s.report_date where p.snapshot_id=s.id));
  elsif p_operation in ('ubpr_read','ubpr_source') then
    target_id:=(p_payload->>'rssd')::bigint; target_date:=(p_payload->>'period')::date;
    select * into u from edgar_private.bank_ubpr_reports where id_rssd=target_id and report_date=target_date
      and (not(p_payload ? 'hash') or source_sha256=p_payload->>'hash') order by retrieved_at desc limit 1;
    if p_operation='ubpr_source' then return case when u.id_rssd is null then null else jsonb_build_object('rawXbrl',u.raw_xbrl,'sha256',u.source_sha256,'retrievedAt',u.retrieved_at) end; end if;
    return jsonb_build_object('report',case when u.id_rssd is null then null else to_jsonb(u)-'raw_xbrl' end,
      'status',(select status from edgar_private.bank_ubpr_jobs where id_rssd=target_id and report_date=target_date));
  elsif p_operation='request' then
    result:=public.bank_scope_call_operation(p_operation,p_payload);
    if result ? 'code' then return result; end if;
    -- Admission to the Call Report queue has already authenticated and bounded this bank request.
    if (select count(*) from edgar_private.bank_ubpr_jobs where status in ('queued','retry','running'))<800 then
      insert into edgar_private.bank_ubpr_jobs(id_rssd,report_date)
        select e.id_rssd,e.report_date from edgar_private.bank_panel_entries e,edgar_private.bank_pilot_control pc
        where pc.id and e.id_rssd=(p_payload->>'rssd')::bigint and e.has_filed and pc.catalog->'periods' ? e.report_date::text
        on conflict(id_rssd,report_date) do nothing;
      get diagnostics added=row_count;
      result:=result||jsonb_build_object('queued',coalesce((result->>'queued')::integer,0)+added);
    end if;
    return result;
  elsif p_operation='begin' then
    result:=public.bank_scope_call_operation(p_operation,p_payload);
    if result->>'allowed'='true' then
      update edgar_private.bank_ubpr_jobs set status='retry',owner=null,next_attempt_at=t where status='running';
      update edgar_private.bank_ubpr_jobs j2 set status='unavailable',owner=null,last_error='outside_retained_history',updated_at=t
        where j2.status in ('queued','retry','running') and not exists(select 1 from edgar_private.bank_pilot_control pc where pc.id and pc.catalog->'periods' ? j2.report_date::text);
      update edgar_private.bank_ubpr_jobs j2 set status='queued',attempts=0,next_attempt_at=t
        where j2.status in ('ready','unavailable') and j2.updated_at<t-interval '7 days'
        and exists(select 1 from edgar_private.bank_pilot_control pc where pc.id and pc.catalog->'periods' ? j2.report_date::text)
        and exists(select 1 from edgar_private.bank_institutions b where b.id_rssd=j2.id_rssd and b.last_requested_at>t-interval '30 days');
    end if;
    return result;
  end if;
  if p_operation not in ('peer_start','peer_batch','peer_complete','ubpr_claim','ubpr_save','ubpr_error','finish')
      and not(p_operation='reserve' and p_payload->>'method' in ('RetrieveUBPRReportingPeriods','RetrieveUBPRXBRLFacsimile')) then
    return public.bank_scope_call_operation(p_operation,p_payload);
  end if;
  select * into c from edgar_private.bank_pilot_control where id for update;
  requested_owner:=(p_payload->>'owner')::uuid;
  if requested_owner is null or c.owner is distinct from requested_owner or c.lease_until<=t then raise exception 'lease_expired' using errcode='40001'; end if;
  if p_operation='reserve' then
    if c.hour_started_at<date_trunc('hour',t) then c.hour_started_at:=date_trunc('hour',t); c.hour_requests:=0; end if;
    if c.day_started_at<date_trunc('day',t) then c.day_started_at:=date_trunc('day',t); c.day_requests:=0; end if;
    if c.day_requests>=2400 then return jsonb_build_object('allowed',false,'code','daily_budget','retryAt',c.day_started_at+interval '1 day'); end if;
    if c.hour_requests>=600 then return jsonb_build_object('allowed',false,'code','hourly_budget','retryAt',c.hour_started_at+interval '1 hour'); end if;
    if greatest(c.next_request_at,c.cooldown_until)>t then return jsonb_build_object('allowed',false,'code','upstream_cooldown','retryAt',greatest(c.next_request_at,c.cooldown_until)); end if;
    update edgar_private.bank_pilot_control set next_request_at=t+interval '5 seconds',request_count=request_count+1,
      hour_started_at=c.hour_started_at,hour_requests=c.hour_requests+1,day_started_at=c.day_started_at,day_requests=c.day_requests+1,
      request_methods=jsonb_set(request_methods,array[p_payload->>'method'],to_jsonb(coalesce((request_methods->>(p_payload->>'method'))::integer,0)+1)) where id;
    return jsonb_build_object('allowed',true);
  elsif p_operation='peer_start' then
    target_date:=(p_payload->>'period')::date;
    if not(c.catalog->'periods' ? target_date::text) or p_payload->>'url' not like 'https://api.fdic.gov/banks/financials?%' then raise exception 'invalid_peer_source'; end if;
    insert into edgar_private.bank_peer_snapshots(id,report_date,owner,expected_count,source_url,source_sha256,source_index,source_updated_at,model_version)
      values((p_payload->>'snapshotId')::uuid,target_date,requested_owner,(p_payload->>'count')::integer,p_payload->>'url',p_payload->>'sha256',
      p_payload->>'sourceIndex',(p_payload->>'sourceUpdatedAt')::timestamptz,p_payload->>'modelVersion');
  elsif p_operation in ('peer_batch','peer_complete') then
    select * into s from edgar_private.bank_peer_snapshots where id=(p_payload->>'snapshotId')::uuid and owner=requested_owner and completed_at is null for update;
    if not found then raise exception 'peer_snapshot_mismatch'; end if;
    if p_operation='peer_batch' then
      if jsonb_array_length(p_payload->'rows') not between 1 and 500 then raise exception 'invalid_peer_batch'; end if;
      if exists(select 1 from jsonb_array_elements(p_payload->'rows') x where
        x->'profile'->>'rssd' is distinct from x->'raw'->>'RSSDID' or x->'profile'->>'cert' is distinct from x->'raw'->>'CERT'
        or x->'raw'->>'REPDTE' is distinct from to_char(s.report_date,'YYYYMMDD')) then raise exception 'peer_identity_mismatch'; end if;
      insert into edgar_private.bank_peer_profiles(snapshot_id,id_rssd,profile,raw_source)
        select s.id,b.id_rssd,x->'profile',x->'raw' from jsonb_array_elements(p_payload->'rows') x
        join edgar_private.bank_panel_entries e on e.id_rssd=(x->'profile'->>'rssd')::bigint and e.report_date=s.report_date
        join edgar_private.bank_institutions b on b.id_rssd=e.id_rssd
        where (e.identity_source->>'FDICCertNumber')::bigint=(x->'profile'->>'cert')::bigint;
      get diagnostics inserted=row_count;
      update edgar_private.bank_peer_snapshots set received_count=received_count+jsonb_array_length(p_payload->'rows'),matched_count=matched_count+inserted where id=s.id;
    else
      if s.received_count<>s.expected_count or s.matched_count<1000 then raise exception 'peer_snapshot_incomplete'; end if;
      update edgar_private.bank_peer_snapshots set completed_at=t where id=s.id;
      -- Keep two completed versions per date, plus recent staging work, to bound storage.
      delete from edgar_private.bank_peer_profiles p where p.snapshot_id in (select z.id from edgar_private.bank_peer_snapshots z
        where z.report_date=s.report_date and z.created_at<t-interval '2 days' and z.id not in
        (select z2.id from edgar_private.bank_peer_snapshots z2 where z2.report_date=s.report_date and z2.completed_at is not null order by z2.completed_at desc limit 2));
      delete from edgar_private.bank_peer_snapshots z where z.report_date=s.report_date and z.created_at<t-interval '2 days'
        and not exists(select 1 from edgar_private.bank_peer_profiles p where p.snapshot_id=z.id);
    end if;
  elsif p_operation='ubpr_claim' then
    select * into j from edgar_private.bank_ubpr_jobs where status in ('queued','retry') and next_attempt_at<=t and c.catalog->'periods' ? report_date::text
      order by report_date desc,requested_at,id_rssd limit 1 for update skip locked;
    if not found then return null; end if;
    update edgar_private.bank_ubpr_jobs set status='running',owner=requested_owner,attempts=attempts+1,updated_at=t where id_rssd=j.id_rssd and report_date=j.report_date;
    return to_jsonb(j);
  elsif p_operation in ('ubpr_save','ubpr_error') then
    select * into j from edgar_private.bank_ubpr_jobs where id_rssd=(p_payload->>'rssd')::bigint and report_date=(p_payload->>'period')::date and owner=requested_owner and status='running';
    if not found then raise exception 'ubpr_job_mismatch'; end if;
    if p_operation='ubpr_save' then
      insert into edgar_private.bank_ubpr_reports(id_rssd,report_date,source_sha256,raw_xbrl,retrieved_at,data)
        values(j.id_rssd,j.report_date,p_payload->>'sha256',p_payload->>'rawXbrl',(p_payload->>'retrievedAt')::timestamptz,coalesce(p_payload->'data','{}'))
        on conflict(id_rssd,report_date,source_sha256) do update set data=excluded.data,retrieved_at=excluded.retrieved_at;
      if p_payload->>'complete'='true' then update edgar_private.bank_ubpr_jobs set status='ready',owner=null,updated_at=t,last_error=null where id_rssd=j.id_rssd and report_date=j.report_date; end if;
    else
      update edgar_private.bank_ubpr_jobs set status=case when p_payload->>'code' in ('call_report_not_filed','reporting_period_unavailable') then 'unavailable'
        when attempts<3 then 'retry' else 'review' end,owner=null,next_attempt_at=greatest(t+interval '10 minutes',coalesce((p_payload->>'retryAt')::timestamptz,t)),updated_at=t,last_error=left(p_payload->>'code',80)
        where id_rssd=j.id_rssd and report_date=j.report_date;
    end if;
  elsif p_operation='finish' then
    update edgar_private.bank_ubpr_jobs set status='retry',owner=null,next_attempt_at=t+interval '30 seconds' where owner=requested_owner and status='running';
    return public.bank_scope_call_operation(p_operation,p_payload);
  end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.bank_scope_operation(text,jsonb) from public,anon,authenticated;
grant execute on function public.bank_scope_operation(text,jsonb) to service_role;
