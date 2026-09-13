-- One private production-wide SEC coordinator. The policy remains at most seven
-- request starts/second; no provider credentials or outbound HTTP are stored here.
create schema if not exists edgar_private;
revoke all on schema edgar_private from public,anon,authenticated;
grant usage on schema edgar_private to service_role;
create table edgar_private.sec_dispatch_control (
  namespace text primary key check(namespace='production'),
  -- Only the database owner can arm AFTER new production is ready. Build-time
  -- calls cannot start or consume the ten-minute coordinator handoff.
  activated_at timestamptz, handoff_until timestamptz,
  owner uuid, lease_until timestamptz,
  next_dispatch_at timestamptz not null default clock_timestamp(),
  cooldown_until timestamptz,
  last_granted_at timestamptz, last_released_at timestamptz, last_cooldown_at timestamptz,
  grants bigint not null default 0 check(grants>=0),
  releases bigint not null default 0 check(releases>=0),
  cooldown_updates bigint not null default 0 check(cooldown_updates>=0),
  check((activated_at is null)=(handoff_until is null)),
  check(handoff_until is null or handoff_until=activated_at+interval '10 minutes'),
  check((owner is null)=(lease_until is null))
);
alter table edgar_private.sec_dispatch_control enable row level security;
revoke all on edgar_private.sec_dispatch_control from public,anon,authenticated,service_role;
grant select on edgar_private.sec_dispatch_control to service_role;
-- Invoker RPCs cannot arm, shorten, restart, insert, or delete the handoff.
grant update(owner,lease_until,next_dispatch_at,cooldown_until,last_granted_at,last_released_at,last_cooldown_at,grants,releases,cooldown_updates)
  on edgar_private.sec_dispatch_control to service_role;
insert into edgar_private.sec_dispatch_control(namespace) values('production');

create function public.edgar_acquire_sec_dispatch(p_namespace text,p_owner uuid)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='750ms' as $$
declare gate edgar_private.sec_dispatch_control; observed timestamptz; blocked_until timestamptz; wait_ms integer;
begin
  if p_namespace is distinct from 'production' or p_owner is null or p_owner='00000000-0000-0000-0000-000000000000'::uuid
    then raise exception 'invalid_sec_dispatch_request' using errcode='22023'; end if;
  select * into gate from edgar_private.sec_dispatch_control where namespace='production' for update;
  if not found then raise exception 'sec_dispatch_gate_missing'; end if;
  observed:=clock_timestamp();
  if gate.activated_at is null then
    return jsonb_build_object('allowed',false,'owner',null,'acquiredAt',null,'expiresAt',null,'leaseMs',5000,'waitMs',300000,'cooldown',true);
  end if;
  blocked_until:=greatest(gate.handoff_until,gate.cooldown_until);
  if blocked_until>observed then
    wait_ms:=greatest(1,least(600000,ceil(extract(epoch from blocked_until-observed)*1000)::integer));
    return jsonb_build_object('allowed',false,'owner',null,'acquiredAt',null,'expiresAt',null,'leaseMs',5000,'waitMs',wait_ms,'cooldown',true);
  end if;
  if gate.owner is not null and gate.lease_until>observed then
    wait_ms:=greatest(1,least(50,ceil(extract(epoch from gate.lease_until-observed)*1000)::integer));
    return jsonb_build_object('allowed',false,'owner',null,'acquiredAt',null,'expiresAt',null,'leaseMs',5000,'waitMs',wait_ms,'cooldown',false);
  end if;
  if gate.next_dispatch_at>observed then
    wait_ms:=greatest(1,least(143,ceil(extract(epoch from gate.next_dispatch_at-observed)*1000)::integer));
    return jsonb_build_object('allowed',false,'owner',null,'acquiredAt',null,'expiresAt',null,'leaseMs',5000,'waitMs',wait_ms,'cooldown',false);
  end if;
  -- Each reservation loop uses a fresh UUID and consumes at most one grant.
  -- The caller derives usable time from its own monotonic request start, discards delayed grants,
  -- and checks again immediately before synchronously dispatching the SEC fetch.
  update edgar_private.sec_dispatch_control set owner=p_owner,lease_until=observed+interval '5 seconds',
    last_granted_at=observed,grants=grants+1 where namespace='production';
  return jsonb_build_object('allowed',true,'owner',p_owner,'acquiredAt',observed,
    'expiresAt',observed+interval '5 seconds','leaseMs',5000,'waitMs',0,'cooldown',false);
end $$;

create function public.edgar_release_sec_dispatch(p_namespace text,p_owner uuid,p_cooldown_ms integer default 0)
returns boolean language plpgsql security invoker set search_path='' set lock_timeout='750ms' as $$
declare gate edgar_private.sec_dispatch_control; observed timestamptz;
begin
  if p_namespace is distinct from 'production' or p_owner is null or p_owner='00000000-0000-0000-0000-000000000000'::uuid
    or p_cooldown_ms is null or p_cooldown_ms not between 0 and 300000
    then raise exception 'invalid_sec_dispatch_release' using errcode='22023'; end if;
  select * into gate from edgar_private.sec_dispatch_control where namespace='production' for update;
  if not found then raise exception 'sec_dispatch_gate_missing'; end if;
  observed:=clock_timestamp();
  if gate.owner is distinct from p_owner or gate.lease_until is null or gate.lease_until<=observed then return false; end if;
  -- Release follows actual fetch dispatch (or an unusable-permit discard).
  -- Server-side spacing starts here, conservatively after actual dispatch.
  update edgar_private.sec_dispatch_control set owner=null,lease_until=null,
    next_dispatch_at=greatest(next_dispatch_at,observed+interval '143 milliseconds'),
    cooldown_until=case when p_cooldown_ms>0 then greatest(cooldown_until,observed+make_interval(secs=>p_cooldown_ms/1000.0)) else cooldown_until end,
    last_released_at=observed,releases=releases+1,
    last_cooldown_at=case when p_cooldown_ms>0 then observed else last_cooldown_at end,
    cooldown_updates=cooldown_updates+case when p_cooldown_ms>0 then 1 else 0 end
    where namespace='production';
  return true;
end $$;

create function public.edgar_publish_sec_cooldown(p_namespace text,p_cooldown_ms integer)
returns boolean language plpgsql security invoker set search_path='' set lock_timeout='750ms' as $$
declare observed timestamptz;
begin
  if p_namespace is distinct from 'production' or p_cooldown_ms is null or p_cooldown_ms not between 1 and 300000
    then raise exception 'invalid_sec_dispatch_cooldown' using errcode='22023'; end if;
  -- Late SEC responses may arrive after release. They can extend the global hold
  -- without granting a permit, releasing another owner, or changing the handoff.
  perform 1 from edgar_private.sec_dispatch_control where namespace='production' for update;
  if not found then raise exception 'sec_dispatch_gate_missing'; end if;
  observed:=clock_timestamp();
  update edgar_private.sec_dispatch_control set cooldown_until=greatest(cooldown_until,observed+make_interval(secs=>p_cooldown_ms/1000.0)),
    last_cooldown_at=observed,cooldown_updates=cooldown_updates+1 where namespace='production';
  return true;
end $$;
revoke all on function public.edgar_acquire_sec_dispatch(text,uuid) from public,anon,authenticated;
revoke all on function public.edgar_release_sec_dispatch(text,uuid,integer) from public,anon,authenticated;
revoke all on function public.edgar_publish_sec_cooldown(text,integer) from public,anon,authenticated;
grant execute on function public.edgar_acquire_sec_dispatch(text,uuid) to service_role;
grant execute on function public.edgar_release_sec_dispatch(text,uuid,integer) to service_role;
grant execute on function public.edgar_publish_sec_cooldown(text,integer) to service_role;
