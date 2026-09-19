-- Use bounded capacity already available in the existing Pro project. Only
-- disposable cache policy changes: no source archive, cache rows, TTLs,
-- eviction rules, schedules, role grants, or source rate limits are altered.
-- At the current seven-family allocation this adds at most 224 MiB of
-- compressed payload capacity (512 -> 736 MiB); table/index/WAL overhead is extra.

alter table edgar_private.cache_families
  drop constraint cache_families_max_rows_check;
alter table edgar_private.cache_families
  add constraint cache_families_max_rows_check
  check(max_rows between 1 and case when family='checkpoint' then 20000 else 10000 end);

-- 5,000 company checkpoints plus retry markers and retained legacy records.
-- The existing 96 MiB checkpoint byte cap and non-evicting policy stay in force.
update edgar_private.cache_families
  set max_rows=20000
  where namespace='production' and family='checkpoint';

-- Measured eviction pressure, not total database size, was limiting cache reuse.
-- These caches remain disposable and retain their existing expiry/LRU behavior.
update edgar_private.cache_families
  set max_bytes=268435456
  where namespace='production' and family='research';
update edgar_private.cache_families
  set max_bytes=201326592
  where namespace='production' and family='document';
