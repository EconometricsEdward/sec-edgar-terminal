-- Optional 24-hour delivery recovery. Store only a capability hash and the
-- exact prepared representation. A pending authorization never unlocks data.
create table edgar_private.x402_deliveries (
  namespace text not null,
  payment_hash text not null,
  recovery_hash text not null check (recovery_hash ~ '^[a-f0-9]{64}$'),
  gzip_body bytea not null check (octet_length(gzip_body) between 18 and 4259840),
  gzip_hash text not null check (gzip_hash ~ '^[a-f0-9]{64}$'),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  raw_bytes integer not null check (raw_bytes between 1 and 4194304),
  response_status integer not null check (response_status between 200 and 299 and response_status <> 204),
  response_headers jsonb not null check (jsonb_typeof(response_headers) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '24 hours',
  primary key (namespace,payment_hash),
  unique (namespace,recovery_hash),
  foreign key (namespace,payment_hash) references edgar_private.x402_receipts(namespace,payment_hash) on delete cascade
);
alter table edgar_private.x402_deliveries enable row level security;
revoke all on edgar_private.x402_deliveries from public,anon,authenticated;
grant select,insert,delete on edgar_private.x402_deliveries to service_role;
-- Row-locking during bounded cleanup requires UPDATE on at least one column.
-- Response bytes/headers stay immutable to this role as well as the RPC.
grant update(expires_at) on edgar_private.x402_deliveries to service_role;
create index x402_deliveries_expiry on edgar_private.x402_deliveries(expires_at);

create function public.edgar_x402_stage_delivery(p_namespace text,p_claim jsonb,p_delivery jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_receipt edgar_private.x402_receipts;
  v_delivery edgar_private.x402_deliveries;
  v_gzip bytea;
begin
  if p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$'
    or not coalesce(jsonb_typeof(p_claim)='object' and jsonb_typeof(p_delivery)='object',false)
    or p_claim - array['paymentHash','owner'] <> '{}'::jsonb
    or p_delivery - array['recoveryHash','gzipBase64','gzipHash','contentHash','rawBytes','status','headers'] <> '{}'::jsonb
    or not coalesce(p_claim->>'paymentHash' ~ '^[a-f0-9]{64}$',false)
    or not coalesce(p_claim->>'owner' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
    or not coalesce(p_delivery->>'recoveryHash' ~ '^[a-f0-9]{64}$',false)
    or not coalesce(p_delivery->>'gzipHash' ~ '^[a-f0-9]{64}$',false)
    or not coalesce(p_delivery->>'contentHash' ~ '^[a-f0-9]{64}$',false)
    or not coalesce(jsonb_typeof(p_delivery->'rawBytes')='number' and p_delivery->>'rawBytes' ~ '^[1-9][0-9]{0,6}$',false)
    or not coalesce(jsonb_typeof(p_delivery->'status')='number' and p_delivery->>'status' ~ '^2[0-9]{2}$' and p_delivery->>'status'<>'204',false)
    or not coalesce(p_delivery->>'gzipBase64' ~ '^H4sI[A-Za-z0-9+/]*={0,2}$',false)
    or length(p_delivery->>'gzipBase64') > 5680000 or length(p_delivery->>'gzipBase64') % 4 <> 0
    or not coalesce(jsonb_typeof(p_delivery->'headers')='object',false)
    or (p_delivery->'headers') - array['content-type','content-disposition','x-data-stale','x-schema-version','link'] <> '{}'::jsonb
    or not coalesce(btrim(split_part(p_delivery->'headers'->>'content-type',';',1)) in ('application/json','text/csv'),false)
    then raise exception using errcode='22023',message='invalid_x402_delivery'; end if;
  if (p_delivery->>'rawBytes')::integer > 4194304
    or exists(select 1 from jsonb_each(p_delivery->'headers') h where jsonb_typeof(h.value)<>'string'
      or length(h.value #>> '{}')>2048 or (h.value #>> '{}') ~ '[[:cntrl:]]')
    then raise exception using errcode='22023',message='invalid_x402_delivery'; end if;
  v_gzip := decode(p_delivery->>'gzipBase64','base64');
  if octet_length(v_gzip) not between 18 and 4259840
    or encode(sha256(v_gzip),'hex')<>p_delivery->>'gzipHash'
    or replace(encode(v_gzip,'base64'),E'\n','')<>p_delivery->>'gzipBase64'
    then raise exception using errcode='22023',message='invalid_x402_delivery'; end if;
  select * into v_receipt from edgar_private.x402_receipts
    where namespace=p_namespace and payment_hash=p_claim->>'paymentHash' for update;
  if not found or v_receipt.owner<>(p_claim->>'owner')::uuid or v_receipt.status<>'pending'
    or v_receipt.transaction_hash is not null
    then raise exception using errcode='PT409',message='x402_delivery_owner_conflict'; end if;
  -- Bounded cleanup runs only after ownership of a verified purchase is proven.
  delete from edgar_private.x402_deliveries where (namespace,payment_hash) in (
    select namespace,payment_hash from edgar_private.x402_deliveries
    where expires_at<clock_timestamp() order by expires_at limit 200 for update skip locked
  );
  insert into edgar_private.x402_deliveries(namespace,payment_hash,recovery_hash,gzip_body,gzip_hash,content_hash,raw_bytes,response_status,response_headers)
  values(p_namespace,v_receipt.payment_hash,p_delivery->>'recoveryHash',v_gzip,p_delivery->>'gzipHash',p_delivery->>'contentHash',
    (p_delivery->>'rawBytes')::integer,(p_delivery->>'status')::integer,p_delivery->'headers')
  on conflict do nothing;
  select * into v_delivery from edgar_private.x402_deliveries
    where namespace=p_namespace and payment_hash=v_receipt.payment_hash;
  if not found or v_delivery.recovery_hash<>p_delivery->>'recoveryHash'
    or v_delivery.gzip_hash<>p_delivery->>'gzipHash' or v_delivery.content_hash<>p_delivery->>'contentHash'
    or v_delivery.raw_bytes<>(p_delivery->>'rawBytes')::integer or v_delivery.response_status<>(p_delivery->>'status')::integer
    or v_delivery.response_headers<>p_delivery->'headers'
    then raise exception using errcode='PT409',message='x402_delivery_immutable'; end if;
  return jsonb_build_object('staged',true,'expiresAt',v_delivery.expires_at);
end;
$$;

create function public.edgar_x402_recover_delivery(p_namespace text,p_recovery_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_delivery edgar_private.x402_deliveries;
  v_receipt edgar_private.x402_receipts;
  v_result jsonb;
begin
  if p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$'
    or not coalesce(p_recovery_hash ~ '^[a-f0-9]{64}$',false)
    then raise exception using errcode='22023',message='invalid_x402_delivery_lookup'; end if;
  select * into v_delivery from edgar_private.x402_deliveries
    where namespace=p_namespace and recovery_hash=p_recovery_hash and expires_at>clock_timestamp();
  if not found then return jsonb_build_object('found',false); end if;
  select * into v_receipt from edgar_private.x402_receipts
    where namespace=p_namespace and payment_hash=v_delivery.payment_hash;
  if not found then return jsonb_build_object('found',false); end if;
  v_result := jsonb_strip_nulls(jsonb_build_object('found',true,'status',v_receipt.status,
    'expiresAt',v_delivery.expires_at,'transaction',v_receipt.transaction_hash,'errorCode',v_receipt.error_code));
  if v_receipt.status='settled' then
    v_result := v_result || jsonb_build_object('paymentHash',v_receipt.payment_hash,'payer',v_receipt.payer,'network',v_receipt.network,
      'delivery',jsonb_build_object('gzipBase64',replace(encode(v_delivery.gzip_body,'base64'),E'\n',''),
        'gzipHash',v_delivery.gzip_hash,'contentHash',v_delivery.content_hash,'rawBytes',v_delivery.raw_bytes,
        'status',v_delivery.response_status,'headers',v_delivery.response_headers));
  end if;
  return v_result;
end;
$$;

revoke all on function public.edgar_x402_stage_delivery(text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.edgar_x402_recover_delivery(text,text) from public,anon,authenticated;
grant execute on function public.edgar_x402_stage_delivery(text,jsonb,jsonb) to service_role;
grant execute on function public.edgar_x402_recover_delivery(text,text) to service_role;
comment on table edgar_private.x402_deliveries is 'Optional exact paid-response recovery for 24 hours. Capability hashes only; no wallet secrets or signed payment proofs. Pending receipts never disclose content.';
