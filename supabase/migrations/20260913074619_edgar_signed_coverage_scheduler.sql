-- pg_net is platform-owned: this project's postgres role cannot revoke its
-- grants. Keep the durable credential out of the request queue by signing
-- short-lived, endpoint-specific messages. No privileged role changes.
create schema if not exists edgar_private authorization postgres;
revoke all on schema edgar_private from public,anon,authenticated;
grant usage on schema edgar_private to service_role;

create table edgar_private.coverage_schedule_nonces (
  nonce uuid primary key,
  issued_at timestamptz not null,
  consumed_at timestamptz not null default clock_timestamp()
);
alter table edgar_private.coverage_schedule_nonces enable row level security;
revoke all on table edgar_private.coverage_schedule_nonces from public,anon,authenticated;
grant select,insert,delete on table edgar_private.coverage_schedule_nonces to service_role;

create function public.edgar_authorize_coverage_schedule(p_namespace text,p_timestamp bigint,p_nonce uuid,p_signature text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare secret text; expected text; message text; now_seconds bigint; inserted integer;
begin
  now_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
  if p_namespace is distinct from 'production' or p_timestamp is null or p_nonce is null
    or p_signature is null or p_signature !~ '^[a-f0-9]{64}$'
    or p_timestamp<now_seconds-300 or p_timestamp>now_seconds+30
  then return false; end if;
  -- service_role already has Vault SELECT and pgcrypto EXECUTE on this project.
  -- This invoker function grants no additional Vault or platform permissions.
  select decrypted_secret into secret from vault.decrypted_secrets
    where name='edgar_sec_coverage_scheduler_v1';
  if secret is null or secret !~ '^[a-f0-9]{64}$' then return false; end if;
  message:='edgar-sec-coverage-v2'||E'\nGET\n/api/cron/sec-coverage\n'||p_timestamp::text||E'\n'||p_nonce::text;
  expected:=encode(extensions.hmac(message,secret,'sha256'),'hex');
  -- Compare digests of signatures, so comparison work does not reveal a useful
  -- chosen prefix of the underlying HMAC. Never return either expected value.
  if extensions.digest(p_signature,'sha256')<>extensions.digest(expected,'sha256') then return false; end if;
  delete from edgar_private.coverage_schedule_nonces where issued_at<clock_timestamp()-interval '10 minutes';
  insert into edgar_private.coverage_schedule_nonces(nonce,issued_at)
    values(p_nonce,to_timestamp(p_timestamp)) on conflict(nonce) do nothing;
  get diagnostics inserted=row_count;
  return inserted=1;
end $$;
revoke all on function public.edgar_authorize_coverage_schedule(text,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.edgar_authorize_coverage_schedule(text,bigint,uuid,text) to service_role;

do $configure$
declare coverage_job bigint;
begin
  select jobid into coverage_job from cron.job where jobname='edgar-sec-coverage-v1';
  if coverage_job is null then raise exception 'Existing inactive coverage schedule is required'; end if;
  perform cron.alter_job(coverage_job,command:=$schedule$
    do $request$
    declare scheduled_at bigint; request_nonce uuid; signature text;
    begin
      scheduled_at:=floor(extract(epoch from clock_timestamp()))::bigint;
      request_nonce:=gen_random_uuid();
      select encode(extensions.hmac(
        'edgar-sec-coverage-v2'||E'\nGET\n/api/cron/sec-coverage\n'||scheduled_at::text||E'\n'||request_nonce::text,
        decrypted_secret,'sha256'),'hex') into signature
      from vault.decrypted_secrets where name='edgar_sec_coverage_scheduler_v1';
      if signature is null then raise exception 'Coverage signing credential unavailable'; end if;
      perform net.http_get(
        url:='https://secedgarterminal.com/api/cron/sec-coverage',
        headers:=jsonb_build_object('x-edgar-schedule-timestamp',scheduled_at::text,
          'x-edgar-schedule-nonce',request_nonce::text,'x-edgar-schedule-signature',signature),
        timeout_milliseconds:=280000
      );
    end
    $request$;
  $schedule$,active:=false);
end
$configure$;
