-- Peer v3 uses domestic noninterest deposits (DEPNIDOM), not all-office DEPNI.
-- Preserve the deployed prepared/chunked read paths, ingestion fences and ACLs.
-- During rolling publication, history must use the selected snapshot's model
-- throughout: never mix v2 funding/cohorts with corrected v3 observations.
do $migration$
declare original text; selected_needle text; history_needle text;
begin
  original:=pg_catalog.pg_get_functiondef('public.bank_scope_operation(text,jsonb)'::regprocedure);
  selected_needle:=$branch$and report_date=target_date and completed_at is not null and model_version='bankscope-peers-2';$branch$;
  history_needle:=$branch$and z.completed_at is not null and z.model_version='bankscope-peers-2'$branch$;
  if (length(original)-length(replace(original,selected_needle,'')))/length(selected_needle)<>1
    or (length(original)-length(replace(original,history_needle,'')))/length(history_needle)<>1 then
    raise exception 'peer_history_model_branches_changed';
  end if;
  original:=replace(original,selected_needle,
    $branch$and report_date=target_date and completed_at is not null and model_version in ('bankscope-peers-2','bankscope-peers-3');$branch$);
  original:=replace(original,history_needle,
    $branch$and z.completed_at is not null and z.model_version=s.model_version$branch$);
  execute original;
end
$migration$;

-- Old ready/review Call Reports otherwise never re-enter the queue when only a
-- mapping changes. Only a new worker initiates this repair, after it has obtained
-- the existing exclusive worker lease. Reparse at most 16 existing retained 031
-- sources per begin; do not inspect XML in SQL or perform new upstream downloads.
-- Reprocessing every old 031 avoids brittle XML election/unit/namespace tests.
do $migration$
declare original text; needle text; replacement text;
begin
  original:=pg_catalog.pg_get_functiondef('public.bank_scope_call_operation(text,jsonb)'::regprocedure);
  needle:=$branch$    update edgar_private.bank_preparation_jobs set status='retry',owner=null,next_attempt_at=t where status='running';
    return jsonb_build_object('allowed',true);$branch$;
  replacement:=$branch$    update edgar_private.bank_preparation_jobs set status='retry',owner=null,next_attempt_at=t where status='running';
    if p_payload->>'mappingVersion'='ffiec-bankscope-v3' then
      with latest as materialized (
        select distinct on(source_report.id_rssd,source_report.report_date) source_report.id,source_report.id_rssd,source_report.report_date,source_report.submission_date_raw,source_report.parser_version
        from edgar_private.bank_call_reports source_report
        where source_report.form_type='031' and c.catalog->'periods' ? source_report.report_date::text
        order by source_report.id_rssd,source_report.report_date,source_report.retrieved_at desc,source_report.id
      ), candidates as materialized (
        select q.id from latest source_report
        join edgar_private.bank_preparation_jobs q on q.id_rssd=source_report.id_rssd and q.report_date=source_report.report_date
        join edgar_private.bank_panel_entries e on e.id_rssd=source_report.id_rssd and e.report_date=source_report.report_date
        where source_report.parser_version in ('ffiec-bankscope-v1','ffiec-bankscope-v2','ffiec031-pilot-v1','ffiec031-pilot-v2')
          and e.form_type='031'
          and q.status in ('ready','review','unavailable')
          and q.desired_submission is not distinct from source_report.submission_date_raw
          -- Raw-source/parsing failures with no normalized metrics cannot be
          -- repaired by a financial mapping change; do not retry them forever.
          and exists(select 1 from edgar_private.bank_call_report_metrics source_metric where source_metric.report_id=source_report.id)
        order by q.report_date desc,q.requested_at,q.id_rssd limit 16
      )
      update edgar_private.bank_preparation_jobs q
        set status='queued',attempts=0,next_attempt_at=t,last_error='mapping_version_refresh',updated_at=t
        from candidates x where q.id=x.id;
    end if;
    return jsonb_build_object('allowed',true);$branch$;
  if (length(original)-length(replace(original,needle,'')))/length(needle)<>1 then
    raise exception 'call_mapping_refresh_begin_changed';
  end if;
  execute replace(original,needle,replacement);
end
$migration$;
