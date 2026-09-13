-- Cover reverse lookups for current, retained-good, and rollback references.
-- Small existing table; bound lock waits and build time during rollout.
set local lock_timeout='2s';
set local statement_timeout='15s';
create index edgar_heads_current_version on public.edgar_dataset_heads(current_version);
create index edgar_heads_last_good_version on public.edgar_dataset_heads(last_good_version);
create index edgar_heads_rollback_version on public.edgar_dataset_heads(rollback_version);
