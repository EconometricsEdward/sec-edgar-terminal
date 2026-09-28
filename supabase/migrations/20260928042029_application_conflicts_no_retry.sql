-- These are final application conflicts, not retryable serialization failures.
-- PostgREST 14 can retry custom SQLSTATE 40001 indefinitely. Return HTTP 409
-- instead, preserving every generation/owner/lease predicate and rollback.
-- https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $migration$
declare fn record; original text; corrected text;
begin
  for fn in
    select p.oid from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
      and p.proname in (
        'edgar_publish', 'edgar_stage_membership', 'edgar_activate_membership',
        'edgar_cache_put_fenced', 'edgar_fund_review_save',
        'bank_pilot_operation', 'bank_scope_call_operation', 'bank_scope_operation'
      ) and position('errcode=''40001''' in p.prosrc)>0
  loop
    original:=pg_catalog.pg_get_functiondef(fn.oid);
    corrected:=replace(original, 'errcode=''40001''', 'errcode=''PT409''');
    if corrected=original then raise exception 'application_conflict_replacement_failed'; end if;
    -- CREATE OR REPLACE retains the function identity, owner, and existing ACL.
    -- This exact literal replacement leaves all security and data logic intact.
    execute corrected;
  end loop;
  if exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
      and (p.proname like 'edgar_%' or p.proname like 'bank_%')
      and position('errcode=''40001''' in p.prosrc)>0
  ) then raise exception 'unaudited_retryable_application_conflict'; end if;
end
$migration$;
