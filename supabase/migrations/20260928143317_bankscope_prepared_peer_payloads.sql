-- Prepare the complete public peer response once, inside the existing fenced
-- publication transaction. User reads then fetch one indexed, TOASTed value.
-- Existing publications can be seeded one UUID at a time with the private
-- helper; until seeded, their original read behavior remains available.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create table edgar_private.bank_peer_payloads (
  snapshot_id uuid primary key references edgar_private.bank_peer_snapshots(id) on delete cascade,
  completed_at timestamptz not null,
  prepared_at timestamptz not null default clock_timestamp(),
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  raw_bytes integer not null check(raw_bytes between 1 and 12582912)
);
alter table edgar_private.bank_peer_payloads enable row level security;
revoke all on edgar_private.bank_peer_payloads from public,anon,authenticated,service_role;
grant select,insert,update,delete on edgar_private.bank_peer_payloads to service_role;

create function edgar_private.bank_prepare_peer_payload(p_snapshot_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,edgar_private as $$
declare s edgar_private.bank_peer_snapshots%rowtype; prepared jsonb; size_bytes integer;
begin
  -- A row lock serializes a manual backfill with publication/retention without
  -- locking unrelated quarters. The normal publisher already owns this lock.
  select * into s from edgar_private.bank_peer_snapshots where id=p_snapshot_id for update;
  if not found or s.completed_at is null or s.received_count<>s.expected_count
    or s.matched_count not between 1000 and 10000 then
    raise exception 'peer_snapshot_incomplete' using errcode='22023';
  end if;
  if exists(select 1 from edgar_private.bank_peer_payloads p
    where p.snapshot_id=s.id and p.completed_at=s.completed_at) then
    return jsonb_build_object('snapshotId',s.id,'prepared',false);
  end if;
  select jsonb_build_object('snapshot',jsonb_build_object(
    'id',s.id,'report_date',s.report_date,'created_at',s.created_at,'completed_at',s.completed_at,
    'expected_count',s.expected_count,'received_count',s.received_count,'matched_count',s.matched_count,
    'source_url',s.source_url,'source_sha256',s.source_sha256,'source_index',s.source_index,
    'source_updated_at',s.source_updated_at,'model_version',s.model_version),
    'profiles',coalesce(jsonb_agg(p.profile||jsonb_build_object(
      'name',b.legal_name,'city',b.city,'state',b.state,'form',e.form_type) order by p.id_rssd),'[]'))
    into prepared from edgar_private.bank_peer_profiles p
    join edgar_private.bank_institutions b on b.id_rssd=p.id_rssd
    join edgar_private.bank_panel_entries e on e.id_rssd=p.id_rssd and e.report_date=s.report_date
    where p.snapshot_id=s.id;
  if jsonb_array_length(prepared->'profiles')<>s.matched_count then
    raise exception 'peer_payload_count_mismatch' using errcode='22023';
  end if;
  size_bytes:=octet_length(prepared::text);
  if size_bytes>12582912 then raise exception 'peer_payload_too_large' using errcode='22023'; end if;
  insert into edgar_private.bank_peer_payloads(snapshot_id,completed_at,payload,raw_bytes)
    values(s.id,s.completed_at,prepared,size_bytes)
    on conflict(snapshot_id) do update set completed_at=excluded.completed_at,
      prepared_at=clock_timestamp(),payload=excluded.payload,raw_bytes=excluded.raw_bytes;
  return jsonb_build_object('snapshotId',s.id,'prepared',true,'profiles',s.matched_count,'rawBytes',size_bytes);
end $$;
revoke all on function edgar_private.bank_prepare_peer_payload(uuid) from public,anon,authenticated;
grant execute on function edgar_private.bank_prepare_peer_payload(uuid) to service_role;

create function edgar_private.bank_publish_peer_payload() returns trigger
language plpgsql security invoker set search_path=pg_catalog,edgar_private as $$
begin
  if new.completed_at is not null then
    if tg_op='INSERT' or old.completed_at is distinct from new.completed_at then
      perform edgar_private.bank_prepare_peer_payload(new.id);
    end if;
  end if;
  return new;
end $$;
revoke all on function edgar_private.bank_publish_peer_payload() from public,anon,authenticated;
grant execute on function edgar_private.bank_publish_peer_payload() to service_role;
create trigger bank_peer_payload_publication
  after insert or update of completed_at on edgar_private.bank_peer_snapshots
  for each row execute function edgar_private.bank_publish_peer_payload();

-- Add only the prepared read path to the currently deployed definition. This
-- preserves the separate history logic, generation fences and PT409 fix, and
-- CREATE OR REPLACE retains the function identity, owner and existing ACLs.
do $migration$
declare original text; needle text; replacement text;
begin
  original:=pg_catalog.pg_get_functiondef('public.bank_scope_operation(text,jsonb)'::regprocedure);
  needle:=$branch$    if not found then return jsonb_build_object('profiles','[]'::jsonb); end if;
    return jsonb_build_object('snapshot',to_jsonb(s)-'owner','profiles',$branch$;
  replacement:=$branch$    if not found then return jsonb_build_object('profiles','[]'::jsonb); end if;
    select p.payload into result from edgar_private.bank_peer_payloads p
      where p.snapshot_id=s.id and p.completed_at=s.completed_at;
    if found then return result; end if;
    return jsonb_build_object('snapshot',to_jsonb(s)-'owner','profiles',$branch$;
  if (length(original)-length(replace(original,needle,'')))/length(needle)<>1 then
    raise exception 'peer_payload_read_branch_changed';
  end if;
  execute replace(original,needle,replacement);
end
$migration$;
