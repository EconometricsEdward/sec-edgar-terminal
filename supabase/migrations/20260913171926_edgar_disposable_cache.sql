-- Disposable, reproducible cache only. This migration does not modify the
-- canonical source archive, dataset versions, lineage, or membership history.
-- Payload quotas count compressed bytes; relation/index/WAL overhead is extra.
create schema if not exists edgar_private;
revoke all on schema edgar_private from public,anon,authenticated;
grant usage on schema edgar_private to service_role;

create table edgar_private.cache_families (
  namespace text not null check(namespace='production'),
  family text not null check(family in ('snapshot','checkpoint','research','document','reference','history')),
  max_bytes bigint not null check(max_bytes>0), max_rows integer not null check(max_rows between 1 and 10000),
  max_ttl_seconds integer not null check(max_ttl_seconds between 1 and 7776000),
  evict_live boolean not null,
  used_bytes bigint not null default 0 check(used_bytes>=0 and used_bytes<=max_bytes),
  used_rows integer not null default 0 check(used_rows>=0 and used_rows<=max_rows),
  puts bigint not null default 0 check(puts>=0),
  deduplicated_puts bigint not null default 0 check(deduplicated_puts>=0),
  evicted_rows bigint not null default 0 check(evicted_rows>=0),
  expired_rows bigint not null default 0 check(expired_rows>=0),
  primary key(namespace,family)
);
insert into edgar_private.cache_families(namespace,family,max_bytes,max_rows,max_ttl_seconds,evict_live) values
  ('production','snapshot',67108864,512,604800,false),
  ('production','checkpoint',100663296,10000,1209600,false),
  ('production','research',268435456,10000,90000,true),
  ('production','document',67108864,10000,2592000,true),
  ('production','reference',16777216,512,7776000,false),
  ('production','history',16777216,512,7776000,false);

create table edgar_private.cache_entries (
  namespace text not null, family text not null,
  cache_type text not null check(cache_type ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'),
  cache_id text not null check(octet_length(cache_id) between 1 and 1200 and cache_id !~ '[[:cntrl:]]'),
  payload_gzip bytea not null check(octet_length(payload_gzip) between 1 and 6291456),
  raw_sha256 text not null check(raw_sha256 ~ '^[0-9a-f]{64}$'),
  gzip_sha256 text not null check(gzip_sha256 ~ '^[0-9a-f]{64}$'),
  raw_bytes integer not null check(raw_bytes between 1 and 33554432),
  stored_bytes integer generated always as (octet_length(payload_gzip)) stored,
  written_at timestamptz not null, expires_at timestamptz not null, accessed_at timestamptz not null,
  primary key(namespace,family,cache_type,cache_id),
  foreign key(namespace,family) references edgar_private.cache_families(namespace,family),
  check(expires_at>written_at)
);
create index cache_entries_expiry on edgar_private.cache_entries(namespace,family,expires_at,cache_type,cache_id);
create index cache_entries_access on edgar_private.cache_entries(namespace,family,accessed_at,cache_type,cache_id);

create table edgar_private.cache_maintenance_control (
  namespace text primary key check(namespace='production'),
  mode text not null default 'inventory' check(mode in ('inventory','migrate','steady')),
  mode_changed_at timestamptz not null default clock_timestamp(),
  owner uuid, lease_until timestamptz,
  state jsonb not null default '{}'::jsonb check(jsonb_typeof(state)='object' and octet_length(state::text)<=65536),
  updated_at timestamptz not null default clock_timestamp(),
  check((owner is null)=(lease_until is null))
);
insert into edgar_private.cache_maintenance_control(namespace) values('production');

alter table edgar_private.cache_families enable row level security;
alter table edgar_private.cache_entries enable row level security;
alter table edgar_private.cache_maintenance_control enable row level security;
revoke all on edgar_private.cache_families,edgar_private.cache_entries,edgar_private.cache_maintenance_control from public,anon,authenticated,service_role;
grant select on edgar_private.cache_families,edgar_private.cache_maintenance_control to service_role;
grant update(used_bytes,used_rows,puts,deduplicated_puts,evicted_rows,expired_rows) on edgar_private.cache_families to service_role;
grant select,insert,update,delete on edgar_private.cache_entries to service_role;
-- The web application can checkpoint its work, but cannot enable deletion or
-- alter the start of the required old-producer drain window.
grant update(owner,lease_until,state,updated_at) on edgar_private.cache_maintenance_control to service_role;

create function public.edgar_cache_get(p_namespace text,p_family text,p_type text,p_ids text[])
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='500ms' as $$
declare observed timestamptz:=clock_timestamp(); result jsonb;
begin
  if p_namespace is distinct from 'production' or p_family is null
    or not exists(select 1 from edgar_private.cache_families where namespace=p_namespace and family=p_family)
    or p_type is null or p_type !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'
    or p_ids is null or cardinality(p_ids) not between 1 and 25 or array_ndims(p_ids)<>1
    or exists(select 1 from unnest(p_ids) id where id is null or octet_length(id) not between 1 and 1200 or id ~ '[[:cntrl:]]')
    then raise exception 'invalid_cache_get' using errcode='22023'; end if;
  -- Check compressed lengths before constructing base64 JSON. Duplicates count
  -- repeatedly because callers receive one result for each original position.
  -- The budget and payload use one statement snapshot: a concurrent replacement
  -- cannot pass a small-size check and then return a larger generation.
  with matching as materialized (
    select requested.position,e.cache_id,e.stored_bytes from unnest(p_ids) with ordinality requested(id,position)
      left join edgar_private.cache_entries e on e.namespace=p_namespace and e.family=p_family
        and e.cache_type=p_type and e.cache_id=requested.id and e.expires_at>observed
  ), budget as (select coalesce(sum(((stored_bytes::bigint+2)/3)*4+octet_length(cache_id)*2+512),0) bytes from matching)
  select case when budget.bytes>9437184 then '{}'::jsonb else (
    select jsonb_agg(case when e.cache_id is null then 'null'::jsonb else jsonb_build_object(
      'id',e.cache_id,'gzipBase64',replace(encode(e.payload_gzip,'base64'),E'\n',''),
      'rawSha256',e.raw_sha256,'gzipSha256',e.gzip_sha256,'rawBytes',e.raw_bytes,
      'storedBytes',e.stored_bytes,'writtenAt',e.written_at,'expiresAt',e.expires_at) end order by m.position)
      from matching m left join edgar_private.cache_entries e on e.namespace=p_namespace and e.family=p_family
        and e.cache_type=p_type and e.cache_id=m.cache_id
  ) end into result from budget;
  if jsonb_typeof(result)<>'array' or octet_length(result::text)>9437184
    then raise exception 'cache_response_too_large' using errcode='22023'; end if;
  -- Coarse popularity is sufficient for a disposable cache. Do not write WAL
  -- for every public read; also avoid making lookup wait on another touch.
  with touch as (select namespace,family,cache_type,cache_id from edgar_private.cache_entries
    where namespace=p_namespace and family=p_family and cache_type=p_type and cache_id=any(p_ids)
      and expires_at>observed and accessed_at<=observed-interval '1 hour' for update skip locked)
  update edgar_private.cache_entries e set accessed_at=observed from touch t
    where e.namespace=t.namespace and e.family=t.family and e.cache_type=t.cache_type and e.cache_id=t.cache_id;
  return result;
end $$;

create function public.edgar_cache_put(p_namespace text,p_family text,p_type text,p_id text,
  p_gzip_base64 text,p_raw_sha256 text,p_gzip_sha256 text,p_raw_bytes integer,p_ttl_seconds integer,p_if_hash text default null,
  p_expires_at timestamptz default null)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='500ms' as $$
declare policy edgar_private.cache_families; compressed bytea; incoming_bytes integer; observed timestamptz;
  prior record; prior_exists boolean; prior_live boolean; next_bytes bigint; next_rows integer;
  remove_types text[]:='{}'; remove_ids text[]:='{}'; remove_bytes bigint:=0; remove_count integer:=0;
  removed_expired integer:=0; removed_live integer:=0; victim record; expiry timestamptz;
begin
  if p_namespace is distinct from 'production' or p_family is null
    or p_type is null or p_type !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'
    or p_id is null or octet_length(p_id) not between 1 and 1200 or p_id ~ '[[:cntrl:]]'
    or p_gzip_base64 is null or octet_length(p_gzip_base64) not between 1 and 8388608
    or p_gzip_base64 !~ '^[A-Za-z0-9+/]*={0,2}$' or length(p_gzip_base64)%4<>0
    or p_raw_sha256 is null or p_raw_sha256 !~ '^[0-9a-f]{64}$'
    or p_gzip_sha256 is null or p_gzip_sha256 !~ '^[0-9a-f]{64}$'
    or p_raw_bytes is null or p_raw_bytes not between 1 and 33554432
    or p_ttl_seconds is null or p_ttl_seconds<1
    or (p_if_hash is not null and p_if_hash<>'absent' and p_if_hash !~ '^[0-9a-f]{64}$')
    then raise exception 'invalid_cache_put' using errcode='22023'; end if;
  compressed:=decode(p_gzip_base64,'base64'); incoming_bytes:=octet_length(compressed);
  if incoming_bytes not between 1 and 6291456 or encode(sha256(compressed),'hex')<>p_gzip_sha256
    then raise exception 'invalid_cache_payload' using errcode='22023'; end if;
  -- The gateway additionally decompresses and verifies the raw SHA and length.
  -- A family row lock fences every quota-changing operation, including prune.
  -- Payload hashing happens first so this lock is short and predictable.
  select * into policy from edgar_private.cache_families where namespace=p_namespace and family=p_family for update;
  if not found or p_ttl_seconds>policy.max_ttl_seconds then raise exception 'invalid_cache_policy' using errcode='22023'; end if;
  if incoming_bytes>policy.max_bytes then return jsonb_build_object('stored',false,'reason','quota_full'); end if;
  observed:=clock_timestamp(); expiry:=least(observed+make_interval(secs=>p_ttl_seconds),p_expires_at);
  if expiry<=observed then return jsonb_build_object('stored',false,'reason','expired'); end if;
  select raw_sha256,raw_bytes,stored_bytes,expires_at into prior from edgar_private.cache_entries
    where namespace=p_namespace and family=p_family and cache_type=p_type and cache_id=p_id for update;
  prior_exists:=found; prior_live:=prior_exists and prior.expires_at>observed;
  if (p_if_hash='absent' and prior_live) or (p_if_hash is not null and p_if_hash<>'absent'
    and (not prior_live or prior.raw_sha256<>p_if_hash)) then
    return jsonb_build_object('stored',false,'reason','compare_failed');
  end if;
  if prior_exists and prior.raw_sha256=p_raw_sha256 then
    if prior.raw_bytes<>p_raw_bytes then raise exception 'cache_raw_metadata_mismatch' using errcode='22023'; end if;
    update edgar_private.cache_entries set expires_at=expiry,accessed_at=observed
      where namespace=p_namespace and family=p_family and cache_type=p_type and cache_id=p_id;
    update edgar_private.cache_families set puts=puts+1,deduplicated_puts=deduplicated_puts+1
      where namespace=p_namespace and family=p_family;
    return jsonb_build_object('stored',true,'reason','unchanged','rawSha256',p_raw_sha256,'expiresAt',expiry);
  end if;
  next_bytes:=policy.used_bytes+incoming_bytes-case when prior_exists then prior.stored_bytes else 0 end;
  next_rows:=policy.used_rows+case when prior_exists then 0 else 1 end;
  if next_bytes>policy.max_bytes or next_rows>policy.max_rows then
    -- Select at most 128 victims across this family. Expired entries precede
    -- live LRU entries; protected global families never evict a live entry.
    -- Plan first: a rejected replacement must not delete still-useful entries.
    for victim in select cache_type,cache_id,stored_bytes,expires_at from edgar_private.cache_entries
      where namespace=p_namespace and family=p_family and not(cache_type=p_type and cache_id=p_id)
        and (expires_at<=observed or policy.evict_live)
      order by (expires_at>observed),case when expires_at<=observed then expires_at else accessed_at end,cache_type,cache_id
      limit 128 for update
    loop
      remove_types:=array_append(remove_types,victim.cache_type); remove_ids:=array_append(remove_ids,victim.cache_id);
      remove_count:=remove_count+1; remove_bytes:=remove_bytes+victim.stored_bytes;
      if victim.expires_at<=observed then removed_expired:=removed_expired+1; else removed_live:=removed_live+1; end if;
      exit when next_bytes-remove_bytes<=policy.max_bytes and next_rows-remove_count<=policy.max_rows;
    end loop;
    if next_bytes-remove_bytes>policy.max_bytes or next_rows-remove_count>policy.max_rows then
      return jsonb_build_object('stored',false,'reason','quota_full');
    end if;
    delete from edgar_private.cache_entries e using unnest(remove_types,remove_ids) doomed(cache_type,cache_id)
      where e.namespace=p_namespace and e.family=p_family and e.cache_type=doomed.cache_type and e.cache_id=doomed.cache_id;
  end if;
  insert into edgar_private.cache_entries(namespace,family,cache_type,cache_id,payload_gzip,raw_sha256,gzip_sha256,
    raw_bytes,written_at,expires_at,accessed_at)
    values(p_namespace,p_family,p_type,p_id,compressed,p_raw_sha256,p_gzip_sha256,p_raw_bytes,observed,expiry,observed)
    on conflict(namespace,family,cache_type,cache_id) do update set payload_gzip=excluded.payload_gzip,
      raw_sha256=excluded.raw_sha256,gzip_sha256=excluded.gzip_sha256,raw_bytes=excluded.raw_bytes,
      written_at=excluded.written_at,expires_at=excluded.expires_at,accessed_at=excluded.accessed_at;
  update edgar_private.cache_families set used_bytes=next_bytes-remove_bytes,used_rows=next_rows-remove_count,
    puts=puts+1,evicted_rows=evicted_rows+removed_live,expired_rows=expired_rows+removed_expired
    where namespace=p_namespace and family=p_family;
  return jsonb_build_object('stored',true,'rawSha256',p_raw_sha256,'expiresAt',expiry);
end $$;

create function public.edgar_cache_maintenance(p_namespace text,p_action text,p_owner uuid default null,p_state jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='500ms' as $$
declare control edgar_private.cache_maintenance_control; observed timestamptz;
begin
  if p_namespace is distinct from 'production' or p_action is null or p_action not in ('read','claim','save')
    or (p_action<>'read' and (p_owner is null or p_owner='00000000-0000-0000-0000-000000000000'::uuid))
    or (p_action='save' and (p_state is null or jsonb_typeof(p_state)<>'object' or octet_length(p_state::text)>65536))
    or (p_action<>'save' and p_state is not null)
    or (p_action='read' and p_owner is not null)
    then raise exception 'invalid_cache_maintenance' using errcode='22023'; end if;
  if p_action='read' then
    select * into control from edgar_private.cache_maintenance_control where namespace=p_namespace;
    return jsonb_build_object('mode',control.mode,'modeChangedAt',control.mode_changed_at,'state',control.state,'leaseUntil',control.lease_until);
  end if;
  select * into control from edgar_private.cache_maintenance_control where namespace=p_namespace for update;
  if not found then raise exception 'cache_maintenance_missing'; end if;
  observed:=clock_timestamp();
  if p_action='claim' then
    if control.owner is not null and control.lease_until>observed then return null; end if;
    update edgar_private.cache_maintenance_control set owner=p_owner,lease_until=observed+interval '45 seconds',updated_at=observed
      where namespace=p_namespace;
    return jsonb_build_object('mode',control.mode,'modeChangedAt',control.mode_changed_at,'state',control.state,
      'owner',p_owner,'leaseUntil',observed+interval '45 seconds');
  end if;
  if control.owner is distinct from p_owner or control.lease_until<=observed then return jsonb_build_object('saved',false); end if;
  update edgar_private.cache_maintenance_control set state=p_state,owner=null,lease_until=null,updated_at=observed
    where namespace=p_namespace;
  return jsonb_build_object('saved',true);
end $$;

create function public.edgar_cache_prune(p_namespace text,p_limit integer default 1000)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='500ms' as $$
declare policy record; observed timestamptz:=clock_timestamp(); removed integer:=0; reclaimed bigint:=0; batch record;
begin
  if p_namespace is distinct from 'production' or p_limit is null or p_limit not between 1 and 1000
    then raise exception 'invalid_cache_prune' using errcode='22023'; end if;
  -- Same family-before-entry lock order as put. This has no SQL path to an
  -- archive/source/history table: expired disposable cache rows alone are removed.
  for policy in select family from edgar_private.cache_families where namespace=p_namespace order by family for update skip locked
  loop
    exit when removed>=p_limit;
    with expired as (select namespace,family,cache_type,cache_id from edgar_private.cache_entries
      where namespace=p_namespace and family=policy.family and expires_at<=observed order by expires_at,cache_type,cache_id
      limit (p_limit-removed) for update skip locked), deleted as (
      delete from edgar_private.cache_entries e using expired x where e.namespace=x.namespace and e.family=x.family
        and e.cache_type=x.cache_type and e.cache_id=x.cache_id returning e.stored_bytes)
    select count(*)::integer n,coalesce(sum(stored_bytes),0)::bigint bytes into batch from deleted;
    update edgar_private.cache_families set used_rows=used_rows-batch.n,used_bytes=used_bytes-batch.bytes,expired_rows=expired_rows+batch.n
      where namespace=p_namespace and family=policy.family;
    removed:=removed+batch.n; reclaimed:=reclaimed+batch.bytes;
  end loop;
  return jsonb_build_object('removed',removed,'reclaimedBytes',reclaimed,'limit',p_limit);
end $$;

create function public.edgar_cache_status(p_namespace text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_namespace is distinct from 'production' then raise exception 'invalid_cache_status' using errcode='22023'; end if;
  select jsonb_build_object('schema',1,'observedAt',now(),'maxPayloadBytes',536870912,
    'payloadBytes',sum(f.used_bytes),'rows',sum(f.used_rows),
    'families',jsonb_agg(jsonb_build_object('family',f.family,'payloadBytes',f.used_bytes,'rows',f.used_rows,
      'maxPayloadBytes',f.max_bytes,'maxRows',f.max_rows,'maxTtlSeconds',f.max_ttl_seconds,'evictLive',f.evict_live,
      'puts',f.puts,'deduplicatedPuts',f.deduplicated_puts,'evictedRows',f.evicted_rows,'expiredRows',f.expired_rows,
      'expiredPendingRows',(select count(*) from edgar_private.cache_entries e where e.namespace=f.namespace and e.family=f.family and e.expires_at<=now()),
      'oldestExpiresAt',(select min(expires_at) from edgar_private.cache_entries e where e.namespace=f.namespace and e.family=f.family)) order by f.family),
    'maintenance',(select jsonb_build_object('mode',c.mode,'modeChangedAt',c.mode_changed_at,'leaseUntil',c.lease_until,
      'state',c.state,'updatedAt',c.updated_at) from edgar_private.cache_maintenance_control c where c.namespace=p_namespace),
    'interpretation','Payload quotas exclude table, index, TOAST, WAL and backup overhead. Only reproducible cache entries expire; canonical evidence and membership history are separate.')
    into result from edgar_private.cache_families f where f.namespace=p_namespace;
  return result;
end $$;

revoke all on function public.edgar_cache_get(text,text,text,text[]) from public,anon,authenticated;
revoke all on function public.edgar_cache_put(text,text,text,text,text,text,text,integer,integer,text,timestamptz) from public,anon,authenticated;
revoke all on function public.edgar_cache_maintenance(text,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.edgar_cache_prune(text,integer) from public,anon,authenticated;
revoke all on function public.edgar_cache_status(text) from public,anon,authenticated;
grant execute on function public.edgar_cache_get(text,text,text,text[]) to service_role;
grant execute on function public.edgar_cache_put(text,text,text,text,text,text,text,integer,integer,text,timestamptz) to service_role;
grant execute on function public.edgar_cache_maintenance(text,text,uuid,jsonb) to service_role;
grant execute on function public.edgar_cache_prune(text,integer) to service_role;
grant execute on function public.edgar_cache_status(text) to service_role;

-- Bounded expiry work is SQL-only and does not consume Edge Function calls.
select cron.schedule('edgar-disposable-cache-expiry-v1','37 3 * * *',
  $$select public.edgar_cache_prune('production',1000);$$);
