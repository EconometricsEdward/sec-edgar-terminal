-- Corrective additive migration: CFTC support must preserve the stable SEC
-- cycle/shard ordering introduced by 20260913085035. No job records, checkpoints,
-- retry budgets, claims, startup controls, or scheduler definitions are altered.
-- CREATE OR REPLACE retains the invoker-only service-role execute privileges.
create or replace function public.edgar_claim_job_prefix(p_namespace text,p_dataset text,p_owner uuid,p_prefix text,p_lease_seconds integer default 120)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.edgar_ingestion_jobs;
begin
  if not coalesce((p_dataset='sec' and p_prefix in ('sec-coverage-v1:','sec-financial-cohort-v1:'))
    or (p_dataset='cftc' and p_prefix='cftc-history-v1:'),false)
    or p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$' or p_owner is null
    or p_lease_seconds is null or p_lease_seconds not between 10 and 900
  then raise exception 'invalid_job_prefix' using errcode='22023'; end if;
  if p_dataset='cftc' and not exists(select 1 from edgar_private.cftc_history_control where namespace=p_namespace and enabled) then return null; end if;
  update public.edgar_ingestion_jobs set state='dead',owner=null,lease_until=null,error_code='lease_expired',updated_at=clock_timestamp()
    where namespace=p_namespace and dataset=p_dataset and left(job_key,length(p_prefix))=p_prefix
      and state='running' and lease_until<=clock_timestamp() and attempts>=max_attempts;
  select * into j from public.edgar_ingestion_jobs where namespace=p_namespace and dataset=p_dataset
    and left(job_key,length(p_prefix))=p_prefix and attempts<max_attempts and available_at<=clock_timestamp()
    and (state in ('queued','retry') or (state='running' and lease_until<=clock_timestamp()))
    -- Preserve the previously deployed SEC cycle/shard ordering. Eligibility
    -- still excludes future cooldowns; CFTC and legacy SEC cohort jobs retain
    -- their existing FIFO availability order.
    order by case when p_prefix='sec-coverage-v1:' then job_key end,
      available_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.edgar_ingestion_jobs set state='running',generation=generation+1,owner=p_owner,
    lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=attempts+1,updated_at=clock_timestamp()
    where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'dataset',j.dataset,'key',j.resource_key,'jobKey',j.job_key,'owner',j.owner,
    'generation',j.generation,'attempts',j.attempts,'checkpoint',j.checkpoint,'expiresAt',j.lease_until);
end $$;
