-- Public research only. No user data, no provider credentials, no public writes.
create schema if not exists market_research;
revoke all on schema market_research from public, anon, authenticated;
grant usage on schema market_research to service_role;

create table market_research.snapshots (
  kind text primary key check (kind in ('funding','derivatives')),
  payload jsonb not null,
  published_at timestamptz not null default now()
);
create table market_research.sources (
  hash text primary key check (hash ~ '^[a-f0-9]{64}$'),
  source_url text not null,
  acquisition text not null,
  retrieved_at timestamptz not null,
  raw_gzip bytea not null check (octet_length(raw_gzip) <= 1048576)
);
create table market_research.observations (
  kind text not null check (kind in ('funding','derivatives')),
  period date not null,
  identity text not null check (length(identity) between 1 and 240),
  value numeric check (value is null or (value <> 'NaN'::numeric and value between -100 and 1e15)),
  attributes jsonb not null,
  primary key (kind, period, identity)
);
create table market_research.refresh_state (
  singleton boolean primary key default true check (singleton),
  owner uuid, generation bigint not null default 0,
  lease_until timestamptz, next_run timestamptz,
  last_attempt timestamptz, last_result jsonb
);
insert into market_research.refresh_state(singleton) values(true);
alter table market_research.snapshots enable row level security;
alter table market_research.sources enable row level security;
alter table market_research.observations enable row level security;
alter table market_research.refresh_state enable row level security;
grant select, insert, update, delete on all tables in schema market_research to service_role;
revoke all on all tables in schema market_research from public, anon, authenticated;

create function public.market_research_operation(p_operation text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  s market_research.refresh_state%rowtype; k text; snap jsonb; src jsonb; row jsonb; id text; rows jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'invalid_payload'; end if;
  if p_operation = 'read' then
    k := p_payload->>'kind';
    if k is null or k not in ('funding','derivatives') then raise exception 'invalid_kind'; end if;
    return (select jsonb_build_object('snapshot', x.payload, 'refresh', (select last_result from market_research.refresh_state where singleton)) from market_research.snapshots x where kind=k);
  end if;
  select * into s from market_research.refresh_state where singleton for update;
  if p_operation = 'begin' then
    if p_payload->>'owner' is null then raise exception 'invalid_owner'; end if;
    if s.lease_until > clock_timestamp() or s.next_run > clock_timestamp() then return jsonb_build_object('allowed',false); end if;
    update market_research.refresh_state set owner=(p_payload->>'owner')::uuid, generation=generation+1,
      lease_until=clock_timestamp()+interval '5 minutes', last_attempt=clock_timestamp() where singleton
      returning * into s;
    return jsonb_build_object('allowed',true,'owner',s.owner,'generation',s.generation);
  end if;
  if s.owner is null or s.owner is distinct from (p_payload->>'owner')::uuid or s.generation is distinct from (p_payload->>'generation')::bigint
    or s.lease_until is null or s.lease_until <= clock_timestamp() then raise exception 'lease_lost'; end if;
  if p_operation = 'publish' then
    snap := p_payload->'snapshot'; k := snap->>'kind';
    if k is null or k not in ('funding','derivatives') or snap->>'version' is distinct from '1' or length(snap::text)>3000000
      or jsonb_typeof(snap->'sources') is distinct from 'array' or jsonb_array_length(snap->'sources') not between 1 and 20 then raise exception 'invalid_snapshot'; end if;
    if snap->>'generatedAt' is null or (snap->>'generatedAt')::timestamptz > clock_timestamp()+interval '5 minutes' then raise exception 'future_snapshot'; end if;
    if k='funding' then rows:=snap->'rates'; else rows:=snap->'observations'; end if;
    if jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows) not between 1 and 12000 then raise exception 'invalid_rows'; end if;
    if jsonb_typeof(p_payload->'archives') is distinct from 'array' or jsonb_array_length(p_payload->'archives') > 20 or length((p_payload->'archives')::text)>1800000 then raise exception 'invalid_archives'; end if;
    for src in select value from jsonb_array_elements(p_payload->'archives') loop
      if src->>'url' is null or src->>'url' !~ '^https://(markets\.newyorkfed\.org/api/|www\.cftc\.gov/MarketReports/SwapsReports/)'
        or src->>'acquisition' is null or src->>'acquisition' not in ('direct-http','official-page-web-retrieval') then raise exception 'invalid_source'; end if;
      insert into market_research.sources(hash,source_url,acquisition,retrieved_at,raw_gzip)
        values(src->>'hash',src->>'url',src->>'acquisition',(src->>'retrievedAt')::timestamptz,decode(src->>'gzip','base64')) on conflict(hash) do nothing;
    end loop;
    for src in select value from jsonb_array_elements(snap->'sources') loop
      if not exists(select 1 from market_research.sources where hash=src->>'hash' and source_url=src->>'url') then raise exception 'missing_source'; end if;
    end loop;
    -- Publish replaces a complete bounded serving snapshot. Revised releases
    -- must also remove products that disappeared from the source.
    delete from market_research.observations where kind=k;
    for row in select value from jsonb_array_elements(rows) loop
      if row->>'date' is null or (row->>'date')::date > current_date then raise exception 'future_observation'; end if;
      if k='derivatives' and (not exists(select 1 from market_research.sources where hash=row->>'sourceHash')
        or row->>'asset' is null or row->>'asset' not in ('rates','credit','fx') or row->>'measure' is null or row->>'measure' not in ('volume','outstanding','tickets')
        or row->>'dimension' is null or row->>'dimension' not in ('clearing','currency','tenor','grade') or row->>'product' is null or row->>'bucket' is null
        or (row->>'value')::numeric<0) then raise exception 'invalid_observation'; end if;
      if k='funding' and (row->>'series' is null or row->>'series' not in ('SOFR','BGCR','TGCR') or row->>'value' is null) then raise exception 'invalid_observation'; end if;
      id := case when k='funding' then row->>'series' else concat_ws('|',row->>'asset',row->>'measure',row->>'dimension',row->>'product',row->>'bucket') end;
      insert into market_research.observations(kind,period,identity,value,attributes)
        values(k,(row->>'date')::date,id,(row->>'value')::numeric,row)
        on conflict(kind,period,identity) do update set value=excluded.value,attributes=excluded.attributes;
    end loop;
    if k='funding' then
      if jsonb_typeof(snap->'fails') is distinct from 'array' or jsonb_array_length(snap->'fails')>104 then raise exception 'invalid_fails'; end if;
      for row in select value from jsonb_array_elements(snap->'fails') loop
        if row->>'date' is null or (row->>'date')::date>current_date then raise exception 'future_observation'; end if;
        insert into market_research.observations(kind,period,identity,value,attributes)
          values(k,(row->>'date')::date,'treasury_fails',null,row)
          on conflict(kind,period,identity) do update set attributes=excluded.attributes;
      end loop;
    end if;
    insert into market_research.snapshots(kind,payload) values(k,snap)
      on conflict(kind) do update set payload=excluded.payload,published_at=clock_timestamp();
    return jsonb_build_object('published',true);
  elsif p_operation='finish' then
    update market_research.refresh_state set owner=null,lease_until=null,
      next_run=clock_timestamp()+interval '11 hours 50 minutes',last_result=p_payload->'result' where singleton;
    return jsonb_build_object('finished',true);
  end if;
  raise exception 'invalid_operation';
end;
$$;
revoke all on function public.market_research_operation(text,jsonb) from public, anon, authenticated;
grant execute on function public.market_research_operation(text,jsonb) to service_role;
comment on schema market_research is 'Curated New York Fed and CFTC public research. DTCC ingestion is not licensed or enabled. Compressed raw captures are bounded to 1 MiB each and isolated from serving tables.';
