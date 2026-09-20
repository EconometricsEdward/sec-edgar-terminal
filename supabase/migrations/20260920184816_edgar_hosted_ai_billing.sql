-- Paid hosted AI: $10 USD / 100 account-bound, nonexpiring responses.
-- Only the verified server workload calls this invoker RPC. No browser grants.
-- No prompts, answers, card data, email addresses or bearer tokens are stored.
create schema if not exists edgar_billing;
revoke all on schema edgar_billing from public, anon, authenticated;
grant usage on schema edgar_billing to service_role;

create table edgar_billing.accounts (
  user_id uuid primary key,
  balance bigint not null default 0,
  funded_microdollars bigint not null default 0 check (funded_microdollars >= 0),
  reserved_microdollars bigint not null default 0 check (reserved_microdollars >= 0),
  created_at timestamptz not null default clock_timestamp()
);
create table edgar_billing.control (
  singleton boolean primary key default true check (singleton),
  funded_microdollars bigint not null default 0 check (funded_microdollars >= 0),
  reserved_microdollars bigint not null default 0 check (reserved_microdollars >= 0),
  daily_limit_microdollars bigint not null default 100000000 check (daily_limit_microdollars between 0 and 100000000),
  monthly_limit_microdollars bigint not null default 2000000000 check (monthly_limit_microdollars between 0 and 2000000000)
);
insert into edgar_billing.control(singleton) values (true);
create table edgar_billing.payments (
  payment_intent_id text primary key,
  checkout_id text unique,
  user_id uuid references edgar_billing.accounts(user_id),
  amount_total integer,
  amount_subtotal integer,
  currency text,
  credits integer not null default 0 check (credits in (0,100)),
  revoked_credits integer not null default 0 check (revoked_credits between 0 and 100),
  refunded_amount integer not null default 0 check (refunded_amount >= 0),
  disputed boolean not null default false,
  funded_microdollars bigint not null default 0 check (funded_microdollars >= 0),
  consent_version text,
  livemode boolean,
  created_at timestamptz,
  fulfilled_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check ((checkout_id is null and user_id is null and credits=0) or
    (checkout_id is not null and user_id is not null and amount_total >= 1000 and amount_subtotal=1000
      and currency='usd' and credits=100 and consent_version='2026-09-20' and livemode is true and created_at is not null))
);
create index edgar_billing_payments_user on edgar_billing.payments(user_id,created_at desc);
create table edgar_billing.disputes (
  dispute_id text primary key,
  payment_intent_id text not null references edgar_billing.payments(payment_intent_id),
  status text not null check (status in ('pending','won','lost')),
  updated_at timestamptz not null default clock_timestamp()
);
create index edgar_billing_disputes_payment on edgar_billing.disputes(payment_intent_id);
create table edgar_billing.events (
  event_id text primary key,
  payment_intent_id text not null references edgar_billing.payments(payment_intent_id),
  action text not null check (action in ('fulfill','adjust_payment')),
  payload jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create table edgar_billing.reservations (
  request_id uuid primary key,
  user_id uuid not null references edgar_billing.accounts(user_id),
  status text not null check (status in ('pending','succeeded','failed','expired')),
  cost_microdollars integer not null check (cost_microdollars=40000),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  finalized_at timestamptz,
  check (expires_at=created_at+interval '120 seconds')
);
create index edgar_billing_active on edgar_billing.reservations(expires_at) where status='pending';
create index edgar_billing_user_requests on edgar_billing.reservations(user_id,created_at);
create table edgar_billing.budget_periods (
  period_kind text not null check (period_kind in ('day','month')),
  starts_on date not null,
  reserved_microdollars bigint not null default 0 check (reserved_microdollars>=0),
  primary key (period_kind, starts_on)
);
create table edgar_billing.ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references edgar_billing.accounts(user_id),
  kind text not null check (kind in ('purchase','reversal','reserve','restore_failed','restore_expired')),
  source_id text not null,
  credit_delta integer not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique(kind,source_id)
);
create index edgar_billing_ledger_user on edgar_billing.ledger(user_id,recorded_at);

alter table edgar_billing.accounts enable row level security;
alter table edgar_billing.control enable row level security;
alter table edgar_billing.payments enable row level security;
alter table edgar_billing.events enable row level security;
alter table edgar_billing.disputes enable row level security;
alter table edgar_billing.reservations enable row level security;
alter table edgar_billing.budget_periods enable row level security;
alter table edgar_billing.ledger enable row level security;
revoke all on all tables in schema edgar_billing from public,anon,authenticated;
revoke all on all sequences in schema edgar_billing from public,anon,authenticated;
grant select,insert,update on edgar_billing.accounts,edgar_billing.payments,edgar_billing.reservations,edgar_billing.budget_periods,edgar_billing.disputes to service_role;
grant select,insert on edgar_billing.events,edgar_billing.ledger to service_role;
grant usage on all sequences in schema edgar_billing to service_role;
grant select on edgar_billing.control to service_role;
-- The server can consume budget, but cannot increase configured ceilings.
grant update(funded_microdollars,reserved_microdollars) on edgar_billing.control to service_role;

create or replace function public.edgar_billing_operation(p_action text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog
as $$
declare
  v_keys text[];
  v_user uuid;
  v_request uuid;
  v_now timestamptz;
  v_balance bigint;
  v_user_funded bigint;
  v_user_reserved bigint;
  v_control edgar_billing.control%rowtype;
  v_payment edgar_billing.payments%rowtype;
  v_event edgar_billing.events%rowtype;
  v_dispute edgar_billing.disputes%rowtype;
  v_reservation edgar_billing.reservations%rowtype;
  v_row record;
  v_total integer;
  v_refund integer;
  v_revoked integer;
  v_funding bigint;
  v_previous_funding bigint;
  v_previous_revoked integer;
  v_day date;
  v_month date;
  v_day_spend bigint;
  v_month_spend bigint;
  v_code text;
  v_purchases jsonb;
  v_active jsonb;
begin
  if p_action is null or p_action not in ('status','fulfill','adjust_payment','reserve','finalize')
    or p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text)>8192 then
    raise exception using errcode='22023',message='invalid_billing_request';
  end if;
  v_keys:=case p_action
    when 'status' then array['user_id']
    when 'fulfill' then array['user_id','checkout_id','payment_intent_id','event_id','amount_total','amount_subtotal','currency','credits','consent_version','livemode','created_at']
    when 'adjust_payment' then array['payment_intent_id','event_id','refunded_amount','dispute_id','dispute_status']
    when 'reserve' then array['user_id','request_id','cost_microdollars']
    else array['user_id','request_id','success'] end;
  if exists(select 1 from jsonb_object_keys(p_payload) k where not k=any(v_keys))
    or exists(select 1 from unnest(v_keys) k where k<>'cost_microdollars' and not p_payload ? k) then
    raise exception using errcode='22023',message='invalid_billing_request';
  end if;
  if p_action<>'adjust_payment' then
    if jsonb_typeof(p_payload->'user_id') is distinct from 'string'
      or p_payload->>'user_id' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      or p_payload->>'user_id'='00000000-0000-0000-0000-000000000000' then
      raise exception using errcode='22023',message='invalid_billing_request';
    end if;
    v_user:=(p_payload->>'user_id')::uuid;
  end if;
  if p_action in ('reserve','finalize') then
    if jsonb_typeof(p_payload->'request_id') is distinct from 'string'
      or p_payload->>'request_id' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      or p_payload->>'request_id'='00000000-0000-0000-0000-000000000000' then
      raise exception using errcode='22023',message='invalid_billing_request';
    end if;
    v_request:=(p_payload->>'request_id')::uuid;
  end if;
  if p_action in ('fulfill','adjust_payment') then
    if jsonb_typeof(p_payload->'payment_intent_id') is distinct from 'string' or length(p_payload->>'payment_intent_id')>255
      or p_payload->>'payment_intent_id' !~ '^pi_[A-Za-z0-9_]+$'
      or jsonb_typeof(p_payload->'event_id') is distinct from 'string' or length(p_payload->>'event_id')>255
      or p_payload->>'event_id' !~ '^evt_[A-Za-z0-9_]+$' then
      raise exception using errcode='22023',message='invalid_billing_request';
    end if;
  end if;
  if p_action='fulfill' then
    if jsonb_typeof(p_payload->'checkout_id') is distinct from 'string' or length(p_payload->>'checkout_id')>255
      or p_payload->>'checkout_id' !~ '^cs_[A-Za-z0-9_]+$'
      or p_payload->'amount_subtotal' is distinct from '1000'::jsonb or p_payload->'credits' is distinct from '100'::jsonb
      or p_payload->'currency' is distinct from '"usd"'::jsonb or p_payload->'consent_version' is distinct from '"2026-09-20"'::jsonb
      or p_payload->'livemode' is distinct from 'true'::jsonb
      or jsonb_typeof(p_payload->'amount_total') is distinct from 'number' or p_payload->>'amount_total' !~ '^[0-9]{4,6}$'
      or (p_payload->>'amount_total')::numeric not between 1000 and 100000
      or jsonb_typeof(p_payload->'created_at') is distinct from 'string' or length(p_payload->>'created_at')>40
      or p_payload->>'created_at' !~ '^\d{4}-\d{2}-\d{2}T' then
      raise exception using errcode='22023',message='invalid_billing_request';
    end if;
    if (p_payload->>'created_at')::timestamptz>clock_timestamp()+interval '60 seconds' then
      raise exception using errcode='22023',message='invalid_billing_request';
    end if;
  end if;
  if p_action='adjust_payment' and (jsonb_typeof(p_payload->'dispute_status') is distinct from 'string'
    or p_payload->>'dispute_status' not in ('none','pending','won','lost')
    or (p_payload->>'dispute_status'='none' and p_payload->'dispute_id' is distinct from 'null'::jsonb)
    or (p_payload->>'dispute_status'<>'none' and (jsonb_typeof(p_payload->'dispute_id') is distinct from 'string'
      or p_payload->>'dispute_id' !~ '^d[pu]_[A-Za-z0-9_]+$' or length(p_payload->>'dispute_id')>255))
    or jsonb_typeof(p_payload->'refunded_amount') is distinct from 'number' or p_payload->>'refunded_amount' !~ '^[0-9]{1,9}$'
    or (p_payload->>'refunded_amount')::numeric>100000000) then
    raise exception using errcode='22023',message='invalid_billing_request';
  end if;
  if p_action='reserve' and p_payload ? 'cost_microdollars' and p_payload->'cost_microdollars' is distinct from '40000'::jsonb then
    raise exception using errcode='22023',message='invalid_billing_request';
  end if;
  if p_action='finalize' and jsonb_typeof(p_payload->'success') is distinct from 'boolean' then
    raise exception using errcode='22023',message='invalid_billing_request';
  end if;

  -- A single durable row serializes payment delivery, balance changes, global
  -- budget checks and reservations across all deployments/server instances.
  select * into strict v_control from edgar_billing.control where singleton for update;
  v_now:=clock_timestamp();
  -- At most eight leases can be active. Expiration always produces a ledger
  -- entry; the provider cost reservation is NEVER refunded, even on failure.
  for v_row in select request_id,user_id from edgar_billing.reservations where status='pending' and expires_at<=v_now loop
    update edgar_billing.accounts set balance=balance+1 where user_id=v_row.user_id;
    update edgar_billing.reservations set status='expired',finalized_at=v_now where request_id=v_row.request_id;
    insert into edgar_billing.ledger(user_id,kind,source_id,credit_delta)
      values(v_row.user_id,'restore_expired',v_row.request_id::text,1);
  end loop;
  if v_user is not null then
    insert into edgar_billing.accounts(user_id) values(v_user) on conflict do nothing;
    select balance,funded_microdollars,reserved_microdollars into v_balance,v_user_funded,v_user_reserved
      from edgar_billing.accounts where user_id=v_user;
  end if;

  if p_action in ('fulfill','adjust_payment') then
    select * into v_event from edgar_billing.events where event_id=p_payload->>'event_id';
    if found then
      if v_event.action<>p_action or v_event.payload<>p_payload then
        raise exception using errcode='22023',message='billing_event_conflict';
      end if;
      return jsonb_build_object('ok',true,'duplicate',true,'remaining',greatest(0,v_balance),'balance',v_balance);
    end if;
    insert into edgar_billing.payments(payment_intent_id) values(p_payload->>'payment_intent_id') on conflict do nothing;
    select * into strict v_payment from edgar_billing.payments where payment_intent_id=p_payload->>'payment_intent_id';
    v_previous_funding:=v_payment.funded_microdollars;
    v_previous_revoked:=v_payment.revoked_credits;
    if p_action='fulfill' then
      v_total:=(p_payload->>'amount_total')::integer;
      if v_payment.checkout_id is not null then
        if v_payment.checkout_id<>p_payload->>'checkout_id' or v_payment.user_id<>v_user or v_payment.amount_total<>v_total then
          raise exception using errcode='22023',message='billing_payment_conflict';
        end if;
        insert into edgar_billing.events(event_id,payment_intent_id,action,payload)
          values(p_payload->>'event_id',v_payment.payment_intent_id,p_action,p_payload);
        return jsonb_build_object('ok',true,'duplicate',true,'remaining',greatest(0,v_balance),'balance',v_balance);
      end if;
      v_revoked:=case when v_payment.disputed then 100 else ceil(100::numeric*least(v_payment.refunded_amount,v_total)/v_total)::integer end;
      v_funding:=case when v_payment.disputed then 0 else (1000-ceil(1000::numeric*least(v_payment.refunded_amount,v_total)/v_total)::bigint)*6000 end;
      update edgar_billing.payments set checkout_id=p_payload->>'checkout_id',user_id=v_user,amount_total=v_total,amount_subtotal=1000,
        currency='usd',credits=100,revoked_credits=v_revoked,funded_microdollars=v_funding,consent_version=p_payload->>'consent_version',
        livemode=true,created_at=(p_payload->>'created_at')::timestamptz,fulfilled_at=v_now,updated_at=v_now
        where payment_intent_id=v_payment.payment_intent_id;
      update edgar_billing.accounts set balance=balance+100-v_revoked,funded_microdollars=funded_microdollars+v_funding
        where user_id=v_user returning balance into v_balance;
      insert into edgar_billing.ledger(user_id,kind,source_id,credit_delta) values(v_user,'purchase',v_payment.payment_intent_id,100-v_revoked);
    else
      v_refund:=greatest(v_payment.refunded_amount,(p_payload->>'refunded_amount')::integer);
      if p_payload->>'dispute_status'<>'none' then
        select * into v_dispute from edgar_billing.disputes where dispute_id=p_payload->>'dispute_id';
        if found then
          if v_dispute.payment_intent_id<>v_payment.payment_intent_id
            or (v_dispute.status in ('won','lost') and p_payload->>'dispute_status' in ('won','lost')
              and v_dispute.status<>p_payload->>'dispute_status') then
            raise exception using errcode='22023',message='billing_dispute_conflict';
          end if;
          -- Terminal outcomes fence stale pending webhook deliveries. A won
          -- dispute restores only the original entitlement, net of refunds.
          if v_dispute.status='pending' then
            update edgar_billing.disputes set status=p_payload->>'dispute_status',updated_at=v_now where dispute_id=v_dispute.dispute_id;
          end if;
        else
          insert into edgar_billing.disputes(dispute_id,payment_intent_id,status)
            values(p_payload->>'dispute_id',v_payment.payment_intent_id,p_payload->>'dispute_status');
        end if;
      end if;
      select exists(select 1 from edgar_billing.disputes where payment_intent_id=v_payment.payment_intent_id and status in ('pending','lost')) into v_payment.disputed;
      if v_payment.checkout_id is null then v_revoked:=0;v_funding:=0;
      else
        v_revoked:=case when v_payment.disputed then 100 else ceil(100::numeric*least(v_refund,v_payment.amount_total)/v_payment.amount_total)::integer end;
        v_funding:=case when v_payment.disputed then 0 else (v_payment.amount_subtotal-ceil(v_payment.amount_subtotal::numeric*least(v_refund,v_payment.amount_total)/v_payment.amount_total)::bigint)*6000 end;
        update edgar_billing.accounts set balance=balance-(v_revoked-v_previous_revoked),
          funded_microdollars=funded_microdollars+v_funding-v_previous_funding where user_id=v_payment.user_id;
        insert into edgar_billing.ledger(user_id,kind,source_id,credit_delta)
          values(v_payment.user_id,'reversal',p_payload->>'event_id',v_previous_revoked-v_revoked);
      end if;
      update edgar_billing.payments set refunded_amount=v_refund,disputed=v_payment.disputed,revoked_credits=v_revoked,
        funded_microdollars=v_funding,updated_at=v_now where payment_intent_id=v_payment.payment_intent_id;
    end if;
    update edgar_billing.control set funded_microdollars=funded_microdollars+v_funding-v_previous_funding where singleton;
    insert into edgar_billing.events(event_id,payment_intent_id,action,payload)
      values(p_payload->>'event_id',v_payment.payment_intent_id,p_action,p_payload);
    return jsonb_build_object('ok',true,'duplicate',false,'remaining',greatest(0,v_balance),'balance',v_balance);
  end if;

  if p_action='status' then
    select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc),'[]'::jsonb) into v_purchases from
      (select checkout_id,created_at,amount_total,amount_subtotal,currency,credits,revoked_credits,refunded_amount,disputed
        from edgar_billing.payments where user_id=v_user order by created_at desc limit 25) p;
    select jsonb_build_object('request_id',request_id,'lease_expires_at',expires_at) into v_active
      from edgar_billing.reservations where user_id=v_user and status='pending' limit 1;
    return jsonb_build_object('remaining',greatest(0,v_balance),'balance',v_balance,'purchases',v_purchases,'active_request',v_active);
  end if;
  if p_action='finalize' then
    select * into v_reservation from edgar_billing.reservations where request_id=v_request and user_id=v_user;
    if not found then return jsonb_build_object('ok',false,'code','request_not_found','remaining',greatest(0,v_balance),'committed',false); end if;
    if v_reservation.status='pending' then
      if (p_payload->>'success')::boolean then
        update edgar_billing.reservations set status='succeeded',finalized_at=v_now where request_id=v_request;
        v_reservation.status:='succeeded';
      else
        update edgar_billing.reservations set status='failed',finalized_at=v_now where request_id=v_request;
        update edgar_billing.accounts set balance=balance+1 where user_id=v_user returning balance into v_balance;
        insert into edgar_billing.ledger(user_id,kind,source_id,credit_delta) values(v_user,'restore_failed',v_request::text,1);
        v_reservation.status:='failed';
      end if;
    end if;
    return jsonb_build_object('ok',v_reservation.status<>'expired','code',v_reservation.status,'status',v_reservation.status,
      'remaining',greatest(0,v_balance),'committed',v_reservation.status='succeeded');
  end if;

  -- No duplicate can start a second provider call, including after expiry.
  if exists(select 1 from edgar_billing.reservations where request_id=v_request) then v_code:='request_already_used';
  elsif v_balance<1 then v_code:='credits_required';
  elsif exists(select 1 from edgar_billing.reservations where user_id=v_user and status='pending') then v_code:='account_busy';
  elsif (select count(*) from edgar_billing.reservations where status='pending')>=8 then v_code:='service_busy';
  elsif (select count(*) from edgar_billing.reservations where user_id=v_user and created_at>v_now-interval '1 minute')>=5 then v_code:='rate_limited';
  elsif (select count(*) from edgar_billing.reservations where user_id=v_user and created_at>v_now-interval '24 hours')>=100 then v_code:='daily_rate_limited';
  elsif v_user_reserved+40000>v_user_funded then v_code:='account_budget_exhausted';
  elsif v_control.reserved_microdollars+40000>v_control.funded_microdollars then v_code:='service_budget_exhausted';
  end if;
  v_day:=(v_now at time zone 'UTC')::date;
  v_month:=date_trunc('month',v_now at time zone 'UTC')::date;
  select reserved_microdollars into v_day_spend from edgar_billing.budget_periods where period_kind='day' and starts_on=v_day;
  select reserved_microdollars into v_month_spend from edgar_billing.budget_periods where period_kind='month' and starts_on=v_month;
  if v_code is null and (coalesce(v_day_spend,0)+40000>v_control.daily_limit_microdollars
    or coalesce(v_month_spend,0)+40000>v_control.monthly_limit_microdollars) then v_code:='service_budget_exhausted'; end if;
  if v_code is not null then return jsonb_build_object('allowed',false,'code',v_code,'remaining',greatest(0,v_balance),'request_id',v_request); end if;
  update edgar_billing.accounts set balance=balance-1,reserved_microdollars=reserved_microdollars+40000
    where user_id=v_user returning balance into v_balance;
  insert into edgar_billing.reservations(request_id,user_id,status,cost_microdollars,created_at,expires_at)
    values(v_request,v_user,'pending',40000,v_now,v_now+interval '120 seconds');
  insert into edgar_billing.ledger(user_id,kind,source_id,credit_delta) values(v_user,'reserve',v_request::text,-1);
  update edgar_billing.control set reserved_microdollars=reserved_microdollars+40000 where singleton;
  insert into edgar_billing.budget_periods(period_kind,starts_on,reserved_microdollars) values('day',v_day,40000),('month',v_month,40000)
    on conflict(period_kind,starts_on) do update set reserved_microdollars=edgar_billing.budget_periods.reserved_microdollars+40000;
  return jsonb_build_object('allowed',true,'code','reserved','remaining',greatest(0,v_balance),'request_id',v_request,'lease_expires_at',v_now+interval '120 seconds');
end;
$$;
revoke all on function public.edgar_billing_operation(text,jsonb) from public,anon,authenticated;
grant execute on function public.edgar_billing_operation(text,jsonb) to service_role;
comment on function public.edgar_billing_operation(text,jsonb) is
  'Production hosted AI billing. Service role only; caller verifies Supabase Auth user IDs and Stripe signatures. No provider prompts or responses are retained.';
