-- pg_net is not relocatable. It has just been installed, with the scheduler
-- inactive and no requests sent. Recreate only that empty extension so its
-- registration also lives outside the exposed public schema.
do $check$
begin
  if exists(select 1 from cron.job where jobname='edgar-sec-coverage-v1' and active)
    or exists(select 1 from net.http_request_queue)
    or exists(select 1 from net._http_response)
  then raise exception 'Scheduler must be inactive and network queues empty'; end if;
end
$check$;
drop extension pg_net;
create extension pg_net with schema extensions;
revoke all on schema net from public, anon, authenticated;
revoke all on all functions in schema net from public, anon, authenticated;
revoke all on all tables in schema net from public, anon, authenticated;
