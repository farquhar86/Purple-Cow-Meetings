-- Purple Cow Meetings — keep deleted metrics deleted
-- Run once in Supabase ▸ SQL Editor. Safe to re-run.
--
-- Why: deleting a metric leaves a tombstone row (data.deleted = true). A browser
-- still running the old app — or a tab left open since before the metric was
-- deleted — can write its cached copy straight back over that tombstone the next
-- time someone hits Save. These two triggers stop that in the database, so it
-- holds no matter what version of the page anyone has loaded.

-- 1) A tombstoned metric can never be flipped back to not-deleted.
create or replace function metrics_block_undelete()
returns trigger language plpgsql as $$
begin
  if coalesce(old.data->>'deleted','false') = 'true'
     and coalesce(new.data->>'deleted','false') <> 'true' then
    return old;   -- stale page tried to undo the delete — keep the tombstone
  end if;
  return new;
end $$;

drop trigger if exists metrics_no_undelete on metrics;
create trigger metrics_no_undelete
  before update on metrics
  for each row execute function metrics_block_undelete();

-- 2) No weekly numbers for a metric that has been deleted.
create or replace function metric_values_block_deleted()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from metrics m
             where m.id = new.metric_id
               and coalesce(m.data->>'deleted','false') = 'true') then
    return null;  -- metric is gone — drop the stray weekly number
  end if;
  return new;
end $$;

drop trigger if exists metric_values_no_zombie on metric_values;
create trigger metric_values_no_zombie
  before insert or update on metric_values
  for each row execute function metric_values_block_deleted();
