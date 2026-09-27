-- Only families that can evict live records need read-time LRU bookkeeping.
-- Protected snapshot/checkpoint/reference/history reads remain read-only: their
-- indexed accessed_at updates created WAL and analyze churn without affecting
-- eviction. Keep response bounds, hourly LRU precision, locking and grants.
create or replace function public.edgar_cache_get(p_namespace text,p_family text,p_type text,p_ids text[])
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
  -- Consult the policy instead of a fixed family list so future protected
  -- families also avoid writes. Real LRU families retain coarse hourly touches
  -- and never wait on another reader's touch.
  if exists(select 1 from edgar_private.cache_families
    where namespace=p_namespace and family=p_family and evict_live) then
    with touch as (select namespace,family,cache_type,cache_id from edgar_private.cache_entries
      where namespace=p_namespace and family=p_family and cache_type=p_type and cache_id=any(p_ids)
        and expires_at>observed and accessed_at<=observed-interval '1 hour' for update skip locked)
    update edgar_private.cache_entries e set accessed_at=observed from touch t
      where e.namespace=t.namespace and e.family=t.family and e.cache_type=t.cache_type and e.cache_id=t.cache_id;
  end if;
  return result;
end $$;
