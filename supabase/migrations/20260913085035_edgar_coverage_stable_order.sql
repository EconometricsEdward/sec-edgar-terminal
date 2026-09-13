-- Keep each daily coverage sweep in a stable cycle/shard order. UUID ties in
-- batched enqueue previously shuffled issuer positions between daily sweeps.
-- CREATE OR REPLACE preserves the existing service-role-only execute grants;
-- namespace, dataset, prefix, retry, lease, and owner fences remain unchanged.
create or replace function public.edgar_claim_job_prefix(p_namespace text,p_dataset text,p_owner uuid,p_prefix text,p_lease_seconds integer default 120)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.edgar_ingestion_jobs;
begin
  if p_dataset is distinct from 'sec' or p_prefix is null or p_prefix not in ('sec-coverage-v1:','sec-financial-cohort-v1:')
    or p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$' or p_owner is null
    or p_lease_seconds is null or p_lease_seconds not between 10 and 900
  then raise exception 'invalid_job_prefix' using errcode='22023'; end if;
  update public.edgar_ingestion_jobs set state='dead',owner=null,lease_until=null,error_code='lease_expired',updated_at=clock_timestamp()
    where namespace=p_namespace and dataset=p_dataset and left(job_key,length(p_prefix))=p_prefix
      and state='running' and lease_until<=clock_timestamp() and attempts>=max_attempts;
  select * into j from public.edgar_ingestion_jobs where namespace=p_namespace and dataset=p_dataset
    and left(job_key,length(p_prefix))=p_prefix and attempts<max_attempts and available_at<=clock_timestamp()
    and (state in ('queued','retry') or (state='running' and lease_until<=clock_timestamp()))
    -- Coverage job keys sort by date, then zero-padded stable shard. Continue
    -- the oldest eligible shard before moving on, even after its yielded work
    -- gets a newer available_at. Future cooldowns still fail eligibility above.
    -- Legacy cohort jobs retain their existing available_at / UUID ordering.
    order by case when p_prefix='sec-coverage-v1:' then job_key end,
      available_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.edgar_ingestion_jobs set state='running',generation=generation+1,owner=p_owner,
    lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=attempts+1,updated_at=clock_timestamp()
    where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'dataset',j.dataset,'key',j.resource_key,'jobKey',j.job_key,'owner',j.owner,
    'generation',j.generation,'attempts',j.attempts,'checkpoint',j.checkpoint,'expiresAt',j.lease_until);
end $$;
