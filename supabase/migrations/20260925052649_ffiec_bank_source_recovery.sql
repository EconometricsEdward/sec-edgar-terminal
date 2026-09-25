-- Retain successful source downloads before parsing; permit audited reprocessing without redownload.
create or replace function public.bank_pilot_operation(p_operation text, p_payload jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = pg_catalog,edgar_private as $$
declare c edgar_private.bank_pilot_control%rowtype; b edgar_private.bank_institutions%rowtype;
  r edgar_private.bank_call_reports%rowtype; t timestamptz:=clock_timestamp(); m jsonb;
  requested_owner uuid; record_id uuid; fresh boolean; banks jsonb; reports jsonb; target_date date;
begin
  if octet_length(p_payload::text)>12000000 or jsonb_typeof(p_payload)<>'object' then raise exception 'invalid_payload' using errcode='22023'; end if;
  if p_operation='read' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.pilot_key),'[]') into banks from edgar_private.bank_institutions x;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.report_date desc,x.id_rssd),'[]') into reports from (
      select distinct on (z.id_rssd,z.report_date) z.id,z.id_rssd,z.report_date,z.submission_date_raw,z.submission_timezone,z.retrieved_at,z.source_sha256,z.validation,z.source_metadata,
        (select coalesce(jsonb_agg(a.metric order by a.metric_name),'[]') from edgar_private.bank_call_report_metrics a where a.report_id=z.id) as metrics
      from edgar_private.bank_call_reports z order by z.id_rssd,z.report_date,z.retrieved_at desc
    ) x;
    select * into c from edgar_private.bank_pilot_control where id;
    return jsonb_build_object('banks',banks,'reports',reports,'requestCount',c.request_count,'requestMethods',c.request_methods,
      'discovery',c.discovery,'lastError',c.last_error,'lastRunResult',c.last_run_result,
      'running',coalesce(c.lease_until>t,false),'cooldownUntil',case when c.cooldown_until>t then c.cooldown_until else null end);
  end if;
  if p_operation='source' then
    select * into r from edgar_private.bank_call_reports where id_rssd=(p_payload->>'rssd')::bigint and report_date=(p_payload->>'reportDate')::date order by retrieved_at desc limit 1;
    if not found then return null; end if;
    return jsonb_build_object('rawXbrl',r.raw_xbrl,'sha256',r.source_sha256,'rssd',r.id_rssd,'reportDate',r.report_date);
  end if;
  select * into c from edgar_private.bank_pilot_control where id for update;
  requested_owner := (p_payload->>'owner')::uuid;
  if p_operation='begin' then
    if c.lease_until>t then return jsonb_build_object('allowed',false,'code','ingestion_running'); end if;
    if c.cooldown_until>t then return jsonb_build_object('allowed',false,'code','upstream_cooldown','retryAt',c.cooldown_until); end if;
    update edgar_private.bank_pilot_control set owner=requested_owner,lease_until=t+interval '240 seconds',last_run_at=t,last_error=null where id;
    return jsonb_build_object('allowed',true);
  end if;
  if requested_owner is null or c.owner is distinct from requested_owner or c.lease_until<=t then raise exception 'lease_expired' using errcode='40001'; end if;
  if p_operation='reserve' then
    if p_payload->>'method' not in ('RetrieveReportingPeriods','RetrievePanelOfReporters','RetrieveFilersSubmissionDateTime','RetrieveFacsimile') then raise exception 'invalid_method'; end if;
    if c.request_count>=80 then return jsonb_build_object('allowed',false,'code','pilot_request_budget_exhausted'); end if;
    if greatest(c.next_request_at,c.cooldown_until)>t then return jsonb_build_object('allowed',false,'code','upstream_cooldown','retryAt',greatest(c.next_request_at,c.cooldown_until)); end if;
    update edgar_private.bank_pilot_control set next_request_at=t+interval '5 seconds',request_count=request_count+1,
      request_methods=jsonb_set(request_methods,array[p_payload->>'method'],to_jsonb(coalesce((request_methods->>(p_payload->>'method'))::integer,0)+1)) where id;
    return jsonb_build_object('allowed',true);
  elsif p_operation='cooldown' then
    update edgar_private.bank_pilot_control set cooldown_until=greatest(cooldown_until,(p_payload->>'retryAt')::timestamptz),last_error=left(p_payload->>'code',80) where id;
  elsif p_operation='finish' then
    update edgar_private.bank_pilot_control set owner=null,lease_until=null,last_finished_at=t,last_error=left(p_payload->>'code',80),last_run_result=p_payload->'result' where id;
  elsif p_operation='discovery' then
    if (c.discovery ? 'periods') and c.discovery->'periods' is distinct from p_payload->'value'->'periods' then raise exception 'pilot_periods_frozen'; end if;
    if jsonb_array_length(p_payload->'value'->'periods') not between 1 and 4 then raise exception 'pilot_period_cap'; end if;
    update edgar_private.bank_pilot_control set discovery=p_payload->'value' where id;
  elsif p_operation='institution' then
    if p_payload->>'key' not in ('jpmorgan','bank-of-america','wells-fargo') then raise exception 'pilot_institution_cap'; end if;
    if p_payload->'source'->>'ID_RSSD' is distinct from p_payload->>'rssd' or p_payload->'source'->>'Name' is distinct from p_payload->>'legalName' then raise exception 'identity_source_mismatch'; end if;
    select * into b from edgar_private.bank_institutions where pilot_key=p_payload->>'key';
    if found and b.id_rssd<>(p_payload->>'rssd')::bigint then raise exception 'identity_changed'; end if;
    insert into edgar_private.bank_institutions(pilot_key,id_rssd,legal_name,fdic_certificate,charter_identifier,institution_status,last_verified_at,identity_source)
      values(p_payload->>'key',(p_payload->>'rssd')::bigint,p_payload->>'legalName',(p_payload->>'fdicCertificate')::bigint,(p_payload->>'charter')::bigint,p_payload->>'status',(p_payload->>'verifiedAt')::timestamptz,p_payload->'source')
      on conflict(pilot_key) do update set last_verified_at=excluded.last_verified_at,identity_source=excluded.identity_source;
  elsif p_operation='publish' then
    target_date:=(p_payload->>'reportDate')::date;
    if not (c.discovery->'periods' ? target_date::text) then raise exception 'pilot_period_cap'; end if;
    select * into b from edgar_private.bank_institutions where id_rssd=(p_payload->>'rssd')::bigint;
    if not found then raise exception 'institution_not_found'; end if;
    if jsonb_array_length(p_payload->'metrics') not between 0 and 60 then raise exception 'invalid_metrics'; end if;
    insert into edgar_private.bank_call_reports(institution_id,id_rssd,report_date,submission_date_raw,submission_timezone,retrieved_at,source_sha256,form_type,raw_xbrl,parser_version,validation,source_metadata)
    values(b.id,b.id_rssd,target_date,p_payload->>'submissionDate',null,(p_payload->>'retrievedAt')::timestamptz,p_payload->>'sha256','031',p_payload->>'rawXbrl',p_payload->>'parserVersion',p_payload->'validation',p_payload->'metadata')
    on conflict(id_rssd,report_date,source_sha256) do update set parser_version=excluded.parser_version,validation=excluded.validation,source_metadata=excluded.source_metadata
      where not coalesce((bank_call_reports.validation->>'passed')::boolean,false) or bank_call_reports.parser_version<>excluded.parser_version
      returning id into record_id;
    fresh:=record_id is not null;
    if fresh then
      for m in select value from jsonb_array_elements(p_payload->'metrics') loop
        if m->>'rssd' is distinct from p_payload->>'rssd' or m->>'reportDate' is distinct from p_payload->>'reportDate' or m->>'sourceHash' is distinct from p_payload->>'sha256' then raise exception 'metric_lineage_mismatch'; end if;
        insert into edgar_private.bank_call_report_metrics values(record_id,m->>'key',m->>'schedule',array(select jsonb_array_elements_text(m->'codes')),m->'lineage',(m->>'value')::numeric,m->>'unit',target_date,b.id_rssd,m) on conflict(report_id,metric_name) do update set schedule=excluded.schedule,item_codes=excluded.item_codes,reported_values=excluded.reported_values,normalized_value=excluded.normalized_value,normalized_unit=excluded.normalized_unit,metric=excluded.metric;
      end loop;
    end if;
    return jsonb_build_object('stored',fresh,'duplicate',not fresh);
  else raise exception 'unsupported_operation' using errcode='22023';
  end if;
  return jsonb_build_object('ok',true);
end $$;
