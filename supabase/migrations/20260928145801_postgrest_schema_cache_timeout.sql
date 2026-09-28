-- PostgREST 14.5 loads pg_timezone_names while rebuilding its schema cache.
-- The hosted authenticator's 8s limit repeatedly cancelled that maintenance,
-- making otherwise small application requests fail with PGRST002. Give schema
-- loading a bounded 30s allowance; keep service-role application queries at 8s.
-- anon/authenticated already have their own 3s/8s limits and are untouched.
-- This changes runtime settings only, not role attributes, grants or RLS.
-- References: https://supabase.com/docs/guides/database/postgres/timeouts
-- https://docs.postgrest.org/en/v14/references/transactions.html#impersonated-role-settings
-- Rollback: ALTER ROLE authenticator SET statement_timeout='8s';
-- ALTER ROLE service_role RESET statement_timeout; then both notifications below.
set local lock_timeout = '2s';
set local statement_timeout = '10s';
do $migration$
declare auth_timeout text; service_timeout text;
begin
  -- A plain PostgreSQL test database may have no PostgREST connection role.
  if not exists(select 1 from pg_roles where rolname='authenticator') then return; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then
    raise exception 'postgrest_service_role_missing';
  end if;
  select split_part(setting,'=',2) into auth_timeout from pg_roles r,
    unnest(coalesce(r.rolconfig,'{}'::text[])) setting
    where r.rolname='authenticator' and setting like 'statement_timeout=%';
  select split_part(setting,'=',2) into service_timeout from pg_roles r,
    unnest(coalesce(r.rolconfig,'{}'::text[])) setting
    where r.rolname='service_role' and setting like 'statement_timeout=%';
  -- Do not overwrite a separately customized operational policy. The second
  -- allowed state makes reapplication of this exact migration harmless.
  if coalesce(auth_timeout,'') not in ('8s','8000ms','8000','30s','30000ms','30000')
    or service_timeout is not null and service_timeout not in ('8s','8000ms','8000') then
    raise exception 'postgrest_timeout_policy_changed';
  end if;
  alter role service_role set statement_timeout = '8s';
  alter role authenticator set statement_timeout = '30s';
end
$migration$;
-- On live v14.5, schemaCacheLoader flushes its pool before reading config and
-- schema metadata. New connections therefore receive the authenticator limit.
-- Configuration reload alone does not flush that pool.
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
