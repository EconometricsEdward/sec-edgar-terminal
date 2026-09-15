-- Reproducible public SEC passages. Hard caps cover raw payload, not indexes,
-- TOAST, WAL or dead tuples. Canonical source/version archives are untouched.
create schema if not exists edgar_private;
revoke all on schema edgar_private from public,anon,authenticated;
grant usage on schema edgar_private to service_role;

create table edgar_private.disclosure_documents (
  id uuid primary key default gen_random_uuid(),
  namespace text not null check(namespace='production'),
  cik text not null check(cik ~ '^[0-9]{10}$' and cik <> '0000000000'),
  accession text not null check(accession ~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'),
  primary_doc text not null check(length(primary_doc) between 1 and 250),
  ticker text not null, form text not null, filing_date date not null,
  parser_version integer not null check(parser_version=1),
  text_hash text not null check(text_hash ~ '^[a-f0-9]{64}$'),
  source_retrieved_at timestamptz not null,
  indexed_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null check(jsonb_typeof(metadata)='object'),
  total_passages integer not null check(total_passages between 1 and 200000),
  indexed_passages integer not null check(indexed_passages between 1 and 180 and indexed_passages<=total_passages),
  complete boolean not null,
  prepared_text text,
  payload_bytes integer not null check(payload_bytes between 1 and 280000),
  unique(namespace,cik,accession,primary_doc),
  check(not complete or (prepared_text is not null and indexed_passages=total_passages)),
  check(prepared_text is null or encode(sha256(convert_to(prepared_text,'UTF8')),'hex')=text_hash)
);
create index disclosure_documents_filing_date on edgar_private.disclosure_documents(namespace,filing_date desc);
create index disclosure_documents_ticker on edgar_private.disclosure_documents(namespace,ticker,filing_date desc);
create table edgar_private.disclosure_passages (
  document_id uuid not null references edgar_private.disclosure_documents(id) on delete cascade,
  paragraph_index integer not null check(paragraph_index between 0 and 199999),
  section_id text not null check(section_id ~ '^(other|risk|mda|notes|8k:[0-9]\.[0-9]{2})$'),
  section_label text not null check(length(section_label) between 1 and 100),
  original_text text not null check(length(original_text) between 1 and 6000),
  -- simple retains stopwords; original literal/Boolean matching remains in Node.
  search_vector tsvector generated always as (to_tsvector('simple'::regconfig,original_text)) stored,
  primary key(document_id,paragraph_index)
);
create index disclosure_passages_fts on edgar_private.disclosure_passages using gin(search_vector);
alter table edgar_private.disclosure_documents enable row level security;
alter table edgar_private.disclosure_passages enable row level security;
revoke all on edgar_private.disclosure_documents,edgar_private.disclosure_passages from public,anon,authenticated,service_role;
grant select,insert,update,delete on edgar_private.disclosure_documents,edgar_private.disclosure_passages to service_role;

create function public.edgar_disclosure_replace(p_namespace text,p_document jsonb,p_passages jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='500ms' set statement_timeout='4500ms' as $$
declare observed timestamptz:=clock_timestamp(); incoming_at timestamptz; filing_day date;
  prior edgar_private.disclosure_documents%rowtype; row_id uuid;
  entry jsonb; raw_bytes integer; paragraphs integer; characters integer; used_bytes bigint; used_rows integer;
begin
  if p_namespace is distinct from 'production' or jsonb_typeof(p_document) is distinct from 'object'
    or jsonb_typeof(p_passages) is distinct from 'array' then raise exception 'invalid_disclosure_document' using errcode='22023'; end if;
  paragraphs:=jsonb_array_length(p_passages);
  raw_bytes:=octet_length(jsonb_build_object('document',p_document,'passages',p_passages)::text);
  if paragraphs not between 1 and 180 or raw_bytes>280000
    or coalesce(p_document->>'cik','') !~ '^[0-9]{10}$' or p_document->>'cik'='0000000000'
    or coalesce(p_document->>'accession','') !~ '^[0-9]{10}-[0-9]{2}-[0-9]{6}$'
    or coalesce(p_document->>'primaryDoc','') !~* '^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(htm|html|txt)$'
    or length(p_document->>'primaryDoc')>250 or position('..' in p_document->>'primaryDoc')>0
    or position('//' in p_document->>'primaryDoc')>0
    or coalesce(p_document->>'ticker','') !~ '^[A-Z0-9.-]{0,15}$'
    or coalesce(length(p_document->>'companyName'),0) not between 1 and 250
    or coalesce(p_document->>'form','') !~ '^(10-K|10-Q|8-K|20-F|40-F|6-K|S-1|S-3|S-4|DEF 14A|DEFM14A|N-CSR|NPORT-P)(/A)?$'
    or coalesce(p_document->>'filingDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or coalesce(p_document->>'textHash','') !~ '^[a-f0-9]{64}$'
    or p_document->>'parserVersion' is distinct from '1'
    or coalesce(p_document->>'totalPassages','') !~ '^[0-9]{1,6}$'
    or jsonb_typeof(p_document->'complete') is distinct from 'boolean'
    or coalesce(jsonb_typeof(p_document->'preparedText'),'null') not in ('null','string')
    then raise exception 'invalid_disclosure_document' using errcode='22023'; end if;
  incoming_at:=(p_document->>'sourceRetrievedAt')::timestamptz;
  filing_day:=(p_document->>'filingDate')::date;
  if incoming_at is null or incoming_at>observed+interval '1 minute'
    or filing_day<current_date-730 or filing_day>current_date
    or (p_document->>'totalPassages')::integer not between paragraphs and 200000
    or coalesce(length(p_document->>'preparedText'),0)>180000
    then raise exception 'invalid_disclosure_document' using errcode='22023'; end if;
  characters:=0;
  for entry in select value from jsonb_array_elements(p_passages) loop
    if jsonb_typeof(entry) is distinct from 'object' or coalesce(entry->>'index','') !~ '^[0-9]{1,6}$'
      or (entry->>'index')::integer>199999
      or coalesce(entry->>'sectionId','') !~ '^(other|risk|mda|notes|8k:[0-9]\.[0-9]{2})$'
      or coalesce(length(entry->>'section'),0) not between 1 and 100
      or jsonb_typeof(entry->'text') is distinct from 'string' or length(entry->>'text') not between 1 and 6000
      then raise exception 'invalid_disclosure_passage' using errcode='22023'; end if;
    characters:=characters+length(entry->>'text');
  end loop;
  if characters>180000 or (select count(distinct value->>'index') from jsonb_array_elements(p_passages))<>paragraphs
    then raise exception 'invalid_disclosure_passage' using errcode='22023'; end if;
  -- One short atomic critical section enforces global bytes and row limits and
  -- prevents a delayed older extraction from replacing a newer generation.
  perform pg_advisory_xact_lock(164812301,1);
  select * into prior from edgar_private.disclosure_documents
    where namespace=p_namespace and cik=p_document->>'cik' and accession=p_document->>'accession' and primary_doc=p_document->>'primaryDoc';
  if prior.id is not null and prior.text_hash=p_document->>'textHash' and prior.parser_version=1 then
    return jsonb_build_object('stored',true,'deduplicated',true,'indexedPassages',prior.indexed_passages);
  end if;
  if prior.id is not null and prior.source_retrieved_at>=incoming_at then
    return jsonb_build_object('stored',false,'reason','stale_generation');
  end if;
  delete from edgar_private.disclosure_documents where namespace=p_namespace and (filing_date<current_date-730 or id=prior.id);
  select coalesce(sum(payload_bytes),0),count(*) into used_bytes,used_rows from edgar_private.disclosure_documents where namespace=p_namespace;
  while used_rows>=600 or used_bytes+raw_bytes>104857600 loop
    delete from edgar_private.disclosure_documents where id=(select id from edgar_private.disclosure_documents
      where namespace=p_namespace order by indexed_at,filing_date,id limit 1);
    select coalesce(sum(payload_bytes),0),count(*) into used_bytes,used_rows from edgar_private.disclosure_documents where namespace=p_namespace;
  end loop;
  insert into edgar_private.disclosure_documents(namespace,cik,accession,primary_doc,ticker,form,filing_date,parser_version,text_hash,
    source_retrieved_at,metadata,total_passages,indexed_passages,complete,prepared_text,payload_bytes)
    values(p_namespace,p_document->>'cik',p_document->>'accession',p_document->>'primaryDoc',p_document->>'ticker',p_document->>'form',filing_day,1,p_document->>'textHash',
      incoming_at,p_document-'preparedText',(p_document->>'totalPassages')::integer,paragraphs,(p_document->>'complete')::boolean,p_document->>'preparedText',raw_bytes)
    returning id into row_id;
  insert into edgar_private.disclosure_passages(document_id,paragraph_index,section_id,section_label,original_text)
    select row_id,(value->>'index')::integer,value->>'sectionId',value->>'section',value->>'text' from jsonb_array_elements(p_passages);
  return jsonb_build_object('stored',true,'indexedPassages',paragraphs,'complete',(p_document->>'complete')::boolean);
end;
$$;

create function public.edgar_disclosure_document(p_namespace text,p_cik text,p_accession text,p_primary_doc text,p_parser_version integer)
returns jsonb language sql stable security invoker set search_path='' set statement_timeout='2500ms' as $$
  select jsonb_build_object('text',prepared_text,'textHash',text_hash,'complete',complete,'sourceRetrievedAt',source_retrieved_at)
  from edgar_private.disclosure_documents where namespace=p_namespace and p_namespace='production' and cik=p_cik and accession=p_accession
    and primary_doc=p_primary_doc and parser_version=p_parser_version and filing_date>=current_date-730 and complete;
$$;

create function public.edgar_disclosure_search(p_namespace text,p_terms text[],p_start date,p_end date,p_forms text[],p_ciks text[],p_tickers text[],
  p_section text,p_offset integer,p_limit integer,p_parser_version integer)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='3500ms' as $$
declare phrase text; lookup tsquery; term_query tsquery; result jsonb; coverage jsonb;
begin
  if p_namespace is distinct from 'production' or coalesce(cardinality(p_terms),0) not between 1 and 16
    or p_start is null or p_end is null or p_start>p_end
    or p_forms is null or cardinality(p_forms)>26 or p_ciks is null or cardinality(p_ciks)>100
    or p_tickers is null or cardinality(p_tickers)>100 or p_parser_version is distinct from 1
    or p_offset is null or p_offset not between 0 and 100000 or p_limit is null or p_limit not between 1 and 120
    or coalesce(p_section,'') !~ '^(all|other|risk|mda|notes|8k:[0-9]\.[0-9]{2})$'
    then raise exception 'invalid_disclosure_search' using errcode='22023'; end if;
  foreach phrase in array p_terms loop
    if phrase is null or length(phrase) not between 2 and 120 then raise exception 'invalid_disclosure_query' using errcode='22023'; end if;
    term_query:=plainto_tsquery('simple'::regconfig,phrase);
    if numnode(term_query)>0 then lookup:=case when lookup is null then term_query else lookup || term_query end; end if;
  end loop;
  select jsonb_build_object('documents',count(*),'passages',coalesce(sum(indexed_passages),0),
    'oldestFilingDate',min(filing_date),'newestFilingDate',max(filing_date),'lastIndexedAt',max(indexed_at),
    'rawPayloadBytes',coalesce(sum(payload_bytes),0),'maxRawPayloadBytes',104857600,'maxDocuments',600,'retentionDays',730,
    'scope','Recent filings prepared by scheduled coverage and on-demand research') into coverage
    from edgar_private.disclosure_documents where namespace=p_namespace and filing_date>=current_date-730 and parser_version=p_parser_version;
  with candidates as materialized (
    select d.metadata || jsonb_build_object('indexedAt',d.indexed_at,'indexedPassages',d.indexed_passages,'rank',ts_rank_cd(p.search_vector,lookup,32),
      'passage',jsonb_build_object('index',p.paragraph_index,'sectionId',p.section_id,'section',p.section_label,'text',p.original_text)) as value,
      ts_rank_cd(p.search_vector,lookup,32) as rank,d.filing_date,d.cik,d.accession,d.primary_doc,p.paragraph_index
    from edgar_private.disclosure_passages p join edgar_private.disclosure_documents d on d.id=p.document_id
    where d.namespace=p_namespace and d.parser_version=p_parser_version and d.filing_date>=greatest(p_start,current_date-730) and d.filing_date<=p_end
      and (cardinality(p_forms)=0 or d.form=any(p_forms))
      and ((cardinality(p_ciks)=0 and cardinality(p_tickers)=0) or d.cik=any(p_ciks) or d.ticker=any(p_tickers))
      and (p_section='all' or p.section_id=p_section) and p.search_vector @@ lookup
    order by rank desc,d.filing_date desc,d.cik,d.accession,d.primary_doc,p.paragraph_index offset p_offset limit p_limit+1
  ), numbered as (select *,row_number() over(order by rank desc,filing_date desc,cik,accession,primary_doc,paragraph_index) as position,
    sum(octet_length(value::text)+4) over(order by rank desc,filing_date desc,cik,accession,primary_doc,paragraph_index) as response_bytes from candidates)
  -- Leave room for metadata and transport formatting under the gateway's
  -- 512 KiB response cap, including non-ASCII passages. Cursor = returned rows.
  select jsonb_build_object('results',coalesce(jsonb_agg(value || jsonb_build_object('score',rank,'rank',p_offset+position) order by position)
      filter(where position<=p_limit and response_bytes<=400000),'[]'::jsonb),
    'hasMore',count(*)>count(*) filter(where position<=p_limit and response_bytes<=400000),'coverage',coverage) into result from numbered;
  return result;
end;
$$;

revoke all on function public.edgar_disclosure_replace(text,jsonb,jsonb), public.edgar_disclosure_document(text,text,text,text,integer),
  public.edgar_disclosure_search(text,text[],date,date,text[],text[],text[],text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.edgar_disclosure_replace(text,jsonb,jsonb), public.edgar_disclosure_document(text,text,text,text,integer),
  public.edgar_disclosure_search(text,text[],date,date,text[],text[],text[],text,integer,integer,integer) to service_role;
comment on table edgar_private.disclosure_documents is 'Bounded reproducible public filing index; 600 documents / 100 MiB raw payload; relation/index overhead is additional. Not canonical archival storage.';
notify pgrst,'reload schema';
