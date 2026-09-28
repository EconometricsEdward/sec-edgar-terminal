-- Move per-profile JSON work into bounded ingestion/backfill pieces. Final
-- publication assembles small serialized arrays, never joins/aggregates the
-- full quarter's JSONB profiles. Old snapshots are backfilled one piece/call.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create table edgar_private.bank_peer_payload_chunks (
  snapshot_id uuid not null references edgar_private.bank_peer_snapshots(id) on delete cascade,
  first_rssd bigint not null,
  profile_ids bigint[] not null,
  profile_count integer not null check(profile_count between 1 and 250),
  profiles_json text not null,
  raw_bytes integer not null check(raw_bytes between 2 and 12582912),
  primary key(snapshot_id,first_rssd),
  check(cardinality(profile_ids)=profile_count and profile_ids[1]=first_rssd),
  check(octet_length(profiles_json)=raw_bytes)
);
alter table edgar_private.bank_peer_payload_chunks enable row level security;
revoke all on edgar_private.bank_peer_payload_chunks from public,anon,authenticated,service_role;
grant select,insert,update,delete on edgar_private.bank_peer_payload_chunks to service_role;

create function edgar_private.bank_capture_peer_payload_chunks() returns trigger
language plpgsql security invoker set search_path=pg_catalog,edgar_private as $$
begin
  -- The transition table contains only this peer_batch's successfully inserted
  -- rows. Groups remain bounded even for a larger administrative INSERT.
  insert into edgar_private.bank_peer_payload_chunks
    (snapshot_id,first_rssd,profile_ids,profile_count,profiles_json,raw_bytes)
  select snapshot_id,ids[1],ids,cardinality(ids),profiles,octet_length(profiles)
  from (
    select snapshot_id,array_agg(id_rssd order by id_rssd) ids,
      json_agg(profile||jsonb_build_object('name',legal_name,'city',city,'state',state,'form',form_type)
        order by id_rssd)::text profiles
    from (
      select p.snapshot_id,p.id_rssd,p.profile,b.legal_name,b.city,b.state,e.form_type,
        (row_number() over(partition by p.snapshot_id order by p.id_rssd)-1)/250 as piece
      from bank_new_peer_profiles p
      join edgar_private.bank_peer_snapshots s on s.id=p.snapshot_id
      join edgar_private.bank_institutions b on b.id_rssd=p.id_rssd
      join edgar_private.bank_panel_entries e on e.id_rssd=p.id_rssd and e.report_date=s.report_date
    ) enriched group by snapshot_id,piece
  ) pieces;
  return null;
end $$;
revoke all on function edgar_private.bank_capture_peer_payload_chunks() from public,anon,authenticated;
grant execute on function edgar_private.bank_capture_peer_payload_chunks() to service_role;
create trigger bank_peer_payload_chunks_insert
  after insert on edgar_private.bank_peer_profiles
  referencing new table as bank_new_peer_profiles
  for each statement execute function edgar_private.bank_capture_peer_payload_chunks();

-- A private operational backfill primitive: exactly one bounded piece per
-- invocation. It cannot publish a partial snapshot or change its source data.
create function edgar_private.bank_prepare_peer_payload_chunk(p_snapshot_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,edgar_private as $$
declare s edgar_private.bank_peer_snapshots%rowtype; ids bigint[]; profiles text;
  selected_count integer; ready_count integer;
begin
  select * into s from edgar_private.bank_peer_snapshots where id=p_snapshot_id for update;
  if not found or s.completed_at is null or s.received_count<>s.expected_count
    or s.matched_count not between 1000 and 10000 then
    raise exception 'peer_snapshot_incomplete' using errcode='22023';
  end if;
  if exists(select 1 from edgar_private.bank_peer_payloads p
    where p.snapshot_id=s.id and p.completed_at=s.completed_at) then
    return jsonb_build_object('snapshotId',s.id,'added',0,'remaining',0,'published',true);
  end if;
  with prepared_ids as materialized (
    select unnest(c.profile_ids) id_rssd from edgar_private.bank_peer_payload_chunks c where c.snapshot_id=s.id
  ), pending as materialized (
    select p.id_rssd,p.profile from edgar_private.bank_peer_profiles p
    where p.snapshot_id=s.id and not exists(select 1 from prepared_ids x where x.id_rssd=p.id_rssd)
    order by p.id_rssd limit 250
  ), enriched as (
    select p.id_rssd,p.profile,b.legal_name,b.city,b.state,e.form_type from pending p
    join edgar_private.bank_institutions b on b.id_rssd=p.id_rssd
    join edgar_private.bank_panel_entries e on e.id_rssd=p.id_rssd and e.report_date=s.report_date
  ) select (select count(*)::integer from pending),array_agg(id_rssd order by id_rssd),
    json_agg(profile||jsonb_build_object('name',legal_name,'city',city,'state',state,'form',form_type)
      order by id_rssd)::text into selected_count,ids,profiles from enriched;
  if selected_count<>coalesce(cardinality(ids),0) then
    raise exception 'peer_payload_count_mismatch' using errcode='22023';
  end if;
  if selected_count>0 then
    insert into edgar_private.bank_peer_payload_chunks
      (snapshot_id,first_rssd,profile_ids,profile_count,profiles_json,raw_bytes)
      values(s.id,ids[1],ids,selected_count,profiles,octet_length(profiles));
  end if;
  select coalesce(sum(profile_count),0)::integer into ready_count
    from edgar_private.bank_peer_payload_chunks where snapshot_id=s.id;
  return jsonb_build_object('snapshotId',s.id,'added',selected_count,'remaining',s.matched_count-ready_count,'published',false);
end $$;
revoke all on function edgar_private.bank_prepare_peer_payload_chunk(uuid) from public,anon,authenticated;
grant execute on function edgar_private.bank_prepare_peer_payload_chunk(uuid) to service_role;

create or replace function edgar_private.bank_prepare_peer_payload(p_snapshot_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,edgar_private as $$
declare s edgar_private.bank_peer_snapshots%rowtype; prepared jsonb; size_bytes integer;
  profile_total integer; matched_ids integer; unique_ids integer; source_count integer; parts_bytes bigint; profiles text;
begin
  select * into s from edgar_private.bank_peer_snapshots where id=p_snapshot_id for update;
  if not found or s.completed_at is null or s.received_count<>s.expected_count
    or s.matched_count not between 1000 and 10000 then
    raise exception 'peer_snapshot_incomplete' using errcode='22023';
  end if;
  if exists(select 1 from edgar_private.bank_peer_payloads p
    where p.snapshot_id=s.id and p.completed_at=s.completed_at) then
    return jsonb_build_object('snapshotId',s.id,'prepared',false);
  end if;
  select coalesce(sum(profile_count),0)::integer,coalesce(sum(raw_bytes),0)
    into profile_total,parts_bytes from edgar_private.bank_peer_payload_chunks where snapshot_id=s.id;
  if profile_total<>s.matched_count then
    raise exception 'peer_payload_chunks_incomplete' using errcode='22023';
  end if;
  if parts_bytes>12582912 then raise exception 'peer_payload_too_large' using errcode='22023'; end if;
  -- Validate only compact integer identities, never read the source JSON here.
  -- The profile primary key plus distinct IDs proves every expected bank is
  -- represented once across disjoint ingestion/backfill pieces.
  select count(distinct x.id_rssd)::integer,count(p.id_rssd)::integer into unique_ids,matched_ids
    from edgar_private.bank_peer_payload_chunks c cross join lateral unnest(c.profile_ids) x(id_rssd)
    left join edgar_private.bank_peer_profiles p on p.snapshot_id=s.id and p.id_rssd=x.id_rssd
    where c.snapshot_id=s.id;
  if unique_ids<>profile_total or matched_ids<>profile_total then
    raise exception 'peer_payload_count_mismatch' using errcode='22023';
  end if;
  select count(*)::integer into source_count from edgar_private.bank_peer_profiles where snapshot_id=s.id;
  if source_count<>profile_total then
    raise exception 'peer_payload_count_mismatch' using errcode='22023';
  end if;
  select '['||string_agg(substring(profiles_json from 2 for length(profiles_json)-2),',' order by first_rssd)||']'
    into profiles from edgar_private.bank_peer_payload_chunks where snapshot_id=s.id;
  prepared:=jsonb_build_object('snapshot',jsonb_build_object(
    'id',s.id,'report_date',s.report_date,'created_at',s.created_at,'completed_at',s.completed_at,
    'expected_count',s.expected_count,'received_count',s.received_count,'matched_count',s.matched_count,
    'source_url',s.source_url,'source_sha256',s.source_sha256,'source_index',s.source_index,
    'source_updated_at',s.source_updated_at,'model_version',s.model_version),'profiles',profiles::jsonb);
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
