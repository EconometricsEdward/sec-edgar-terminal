-- Switch new x402 payments to Solana native USDC. Legacy Base receipts remain
-- readable and finishable; no historical payment or ownership token is changed.
-- Solana replay identity is SHA256(decoded transaction message), not wire
-- signature slots. The facilitator enforces actual recent-blockhash expiry;
-- valid_before is a conservative 10-minute receipt retention boundary only.
create function edgar_private.x402_base58_bytes(p_value text, p_bytes integer)
returns boolean language plpgsql immutable strict security invoker set search_path = '' as $$
declare
  v_alphabet text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  v_number numeric := 0;
  v_digit integer;
  v_zeros integer := 0;
  v_size integer := 0;
  v_i integer;
begin
  if p_bytes not in (32,64) or length(p_value) < p_bytes or length(p_value) > (case p_bytes when 32 then 44 else 88 end)
    then return false; end if;
  for v_i in 1..length(p_value) loop
    v_digit := strpos(v_alphabet,substr(p_value,v_i,1))-1;
    if v_digit < 0 then return false; end if;
    if v_i = v_zeros+1 and v_digit = 0 then v_zeros := v_zeros+1; end if;
    v_number := v_number*58+v_digit;
  end loop;
  while v_number > 0 loop
    v_size := v_size+1;
    v_number := trunc(v_number/256);
  end loop;
  return v_zeros+v_size = p_bytes;
end;
$$;
revoke all on function edgar_private.x402_base58_bytes(text,integer) from public,anon,authenticated;
grant execute on function edgar_private.x402_base58_bytes(text,integer) to service_role;

alter table edgar_private.x402_receipts drop constraint x402_receipts_network_check;
alter table edgar_private.x402_receipts drop constraint x402_receipts_asset_check;
alter table edgar_private.x402_receipts drop constraint x402_receipts_payer_check;
alter table edgar_private.x402_receipts drop constraint x402_receipts_pay_to_check;
alter table edgar_private.x402_receipts drop constraint x402_receipts_transaction_hash_check;
alter table edgar_private.x402_receipts add constraint x402_receipts_network_asset_check check (
  (network='eip155:8453' and asset='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
  or (network='eip155:84532' and asset='0x036cbd53842c5426634e7929541ec2318f3dcf7e')
  or (network='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' and asset='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
);
alter table edgar_private.x402_receipts add constraint x402_receipts_address_check check (
  (network in ('eip155:8453','eip155:84532') and payer ~ '^0x[a-f0-9]{40}$' and pay_to ~ '^0x[a-f0-9]{40}$')
  or (network='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' and edgar_private.x402_base58_bytes(payer,32) and edgar_private.x402_base58_bytes(pay_to,32))
);
alter table edgar_private.x402_receipts add constraint x402_receipts_transaction_check check (
  transaction_hash is null
  or (network in ('eip155:8453','eip155:84532') and transaction_hash ~ '^0x[a-f0-9]{64}$')
  or (network='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' and edgar_private.x402_base58_bytes(transaction_hash,64))
);

create or replace function public.edgar_x402_claim(p_namespace text, p_payment jsonb, p_owner uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_expiry timestamptz;
  v_inserted integer;
  v_row edgar_private.x402_receipts;
begin
  if p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$' or p_owner is null
    or not coalesce(jsonb_typeof(p_payment) = 'object', false)
    or p_payment - array['paymentHash','resourceUrl','resourceHash','payer','network','asset','amount','payTo','nonceHash','validBefore'] <> '{}'::jsonb
    or not coalesce((p_payment->>'paymentHash') ~ '^[a-f0-9]{64}$', false)
    or not coalesce((p_payment->>'resourceHash') ~ '^[a-f0-9]{64}$', false)
    or not coalesce((p_payment->>'nonceHash') ~ '^[a-f0-9]{64}$', false)
    or not coalesce(edgar_private.x402_base58_bytes(p_payment->>'payer',32), false)
    or not coalesce(edgar_private.x402_base58_bytes(p_payment->>'payTo',32), false)
    or not coalesce((p_payment->>'resourceUrl') ~ '^https://secedgarterminal\.com/api/x402/v1/[^#[:cntrl:]]+$', false)
    or length(p_payment->>'resourceUrl') > 2048
    or not coalesce(jsonb_typeof(p_payment->'amount') = 'string' and p_payment->>'amount' = '10000', false)
    or not coalesce(jsonb_typeof(p_payment->'validBefore') = 'string' and (p_payment->>'validBefore') ~ '^[1-9][0-9]{0,10}$', false)
    or not coalesce(p_payment->>'network' = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      and p_payment->>'asset' = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', false)
    then raise exception using errcode = '22023', message = 'invalid_x402_payment';
  end if;
  v_expiry := to_timestamp((p_payment->>'validBefore')::double precision);
  if v_expiry <= v_now or v_expiry > v_now + interval '10 minutes' then
    raise exception using errcode = '22023', message = 'invalid_x402_authorization_expiry';
  end if;
  -- Bounded cleanup is part of a verified claim, never an unpaid public request.
  delete from edgar_private.x402_receipts where (namespace, payment_hash) in (
    select namespace, payment_hash from edgar_private.x402_receipts
    where expires_at < v_now order by expires_at limit 200 for update skip locked
  );
  insert into edgar_private.x402_receipts(namespace,payment_hash,owner,resource_url,resource_hash,network,asset,payer,pay_to,amount,nonce_hash,valid_before,expires_at)
  values (p_namespace,p_payment->>'paymentHash',p_owner,p_payment->>'resourceUrl',p_payment->>'resourceHash',p_payment->>'network',p_payment->>'asset',
    p_payment->>'payer',p_payment->>'payTo',p_payment->>'amount',p_payment->>'nonceHash',v_expiry,greatest(v_now,v_expiry)+interval '30 days')
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return jsonb_build_object('claimed',true,'token',jsonb_build_object('paymentHash',p_payment->>'paymentHash','owner',p_owner));
  end if;
  select * into v_row from edgar_private.x402_receipts
    where namespace = p_namespace and (payment_hash = p_payment->>'paymentHash'
      or (network = p_payment->>'network' and asset = p_payment->>'asset' and payer = p_payment->>'payer' and nonce_hash = p_payment->>'nonceHash'))
    order by created_at limit 1;
  if not found then raise exception using errcode = 'PT409', message = 'x402_claim_conflict'; end if;
  -- Existing claims never reveal their ownership token or provide paid access.
  return jsonb_strip_nulls(jsonb_build_object('claimed',false,'status',v_row.status,'transaction',v_row.transaction_hash));
end;
$$;

create or replace function public.edgar_x402_finish(p_namespace text, p_claim jsonb, p_receipt jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row edgar_private.x402_receipts;
  v_status text := p_receipt->>'status';
  v_owner uuid;
begin
  if p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,48}$'
    or not coalesce(jsonb_typeof(p_claim) = 'object' and jsonb_typeof(p_receipt) = 'object',false)
    or p_claim - array['paymentHash','owner'] <> '{}'::jsonb
    or p_receipt - array['status','transaction','payer','network','errorCode'] <> '{}'::jsonb
    or not coalesce((p_claim->>'paymentHash') ~ '^[a-f0-9]{64}$',false)
    or not coalesce((p_claim->>'owner') ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
    or not coalesce(v_status in ('pending','settled','failed','handler_failed'),false)
    or (p_receipt ? 'errorCode' and not coalesce((p_receipt->>'errorCode') ~ '^[a-z0-9_]{1,80}$',false))
    or ((v_status = 'settled' or v_status = 'pending' and p_receipt ? 'transaction') and not coalesce(
      ((p_receipt->>'network') in ('eip155:8453','eip155:84532') and (p_receipt->>'transaction') ~ '^0x[a-f0-9]{64}$' and (p_receipt->>'payer') ~ '^0x[a-f0-9]{40}$')
      or (p_receipt->>'network' = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
        and edgar_private.x402_base58_bytes(p_receipt->>'transaction',64) and edgar_private.x402_base58_bytes(p_receipt->>'payer',32)),false))
    or (v_status in ('failed','handler_failed') and p_receipt ?| array['transaction','payer','network'])
    or (v_status = 'pending' and not (p_receipt ? 'transaction') and p_receipt ?| array['payer','network'])
    then raise exception using errcode = '22023', message = 'invalid_x402_receipt';
  end if;
  v_owner := (p_claim->>'owner')::uuid;
  select * into v_row from edgar_private.x402_receipts
    where namespace = p_namespace and payment_hash = p_claim->>'paymentHash' for update;
  if not found or v_row.owner <> v_owner then
    raise exception using errcode = 'PT409', message = 'x402_receipt_owner_conflict';
  end if;
  if p_receipt ? 'transaction' and (p_receipt->>'network' <> v_row.network or p_receipt->>'payer' <> v_row.payer) then
    raise exception using errcode = '22023', message = 'x402_receipt_identity_mismatch';
  end if;
  if v_row.transaction_hash is not null and (v_status in ('failed','handler_failed')
    or (p_receipt ? 'transaction' and p_receipt->>'transaction' <> v_row.transaction_hash)) then
    raise exception using errcode = 'PT409', message = 'x402_receipt_transaction_conflict';
  end if;
  if v_row.status <> 'pending' then
    if v_status <> v_row.status or (v_status = 'settled' and p_receipt->>'transaction' <> v_row.transaction_hash) then
      raise exception using errcode = 'PT409', message = 'x402_receipt_already_finished';
    end if;
    return jsonb_build_object('finished',true,'status',v_row.status);
  end if;
  update edgar_private.x402_receipts set status = v_status,
    transaction_hash = coalesce(p_receipt->>'transaction',v_row.transaction_hash),
    error_code = p_receipt->>'errorCode', updated_at = clock_timestamp()
    where namespace = p_namespace and payment_hash = v_row.payment_hash and owner = v_owner;
  return jsonb_build_object('finished',true,'status',v_status);
end;
$$;

revoke all on function public.edgar_x402_claim(text,jsonb,uuid) from public, anon, authenticated;
revoke all on function public.edgar_x402_finish(text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.edgar_x402_claim(text,jsonb,uuid) to service_role;
grant execute on function public.edgar_x402_finish(text,jsonb,jsonb) to service_role;
comment on table edgar_private.x402_receipts is 'Verified x402 authorization hashes and settlement receipts; no signatures, bearer tokens or wallet private keys. No proof can be reclaimed after settlement ambiguity.';
