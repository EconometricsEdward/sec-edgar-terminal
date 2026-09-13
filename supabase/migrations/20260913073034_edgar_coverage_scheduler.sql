-- Supabase drives bounded background work while Vercel remains on Hobby.
-- The machine credential never leaves Vault; the application stores its hash.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

revoke all on schema net from public, anon, authenticated;
revoke all on all functions in schema net from public, anon, authenticated;
revoke all on all tables in schema net from public, anon, authenticated;

do $provision$
begin
  if not exists (select 1 from vault.secrets where name = 'edgar_sec_coverage_scheduler_v1') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'edgar_sec_coverage_scheduler_v1',
      'Only authorizes bounded SEC coverage refreshes on secedgarterminal.com; never a database credential.'
    );
  end if;
end
$provision$;

select cron.schedule(
  'edgar-sec-coverage-v1',
  '*/5 * * * *',
  $schedule$
    select net.http_get(
      url := 'https://secedgarterminal.com/api/cron/sec-coverage',
      headers := jsonb_build_object('Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'edgar_sec_coverage_scheduler_v1')),
      timeout_milliseconds := 280000
    ) as request_id;
  $schedule$
);

-- Enable only after the deployed endpoint passes authentication and a real job.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'edgar-sec-coverage-v1'),
  active := false
);
