-- Purple Cow Meetings — file every weekly number under its Sunday
-- Run once in Supabase ▸ SQL Editor. Safe to re-run.
--
-- Until Oct 2026 the week start was a per-browser setting, so some people's numbers were saved
-- under Monday dates, where anyone on the normal Sunday week couldn't see them. The app now uses
-- Sunday for everyone. This moves those numbers to the Sunday of the same week:
--   * nothing on that Sunday yet     → the number moves to the Sunday
--   * the same number on the Sunday  → the extra copy is removed
--   * a different number on Sunday   → both are left alone and listed at the end for the owner

begin;

create temp table wk_fix on commit drop as
select distinct on (v.metric_id, v.wk)
       v.id      as old_id,
       v.metric_id,
       v.wk      as old_wk,
       to_char(v.wk::date - extract(dow from v.wk::date)::int, 'YYYY-MM-DD') as new_wk,
       v.value
from metric_values v
where v.wk ~ '^\d{4}-\d{2}-\d{2}$'
  and extract(dow from v.wk::date) <> 0
  and v.value is not null
  and (v.value #>> '{}') <> '';

-- 1) Move numbers whose Sunday has nothing yet.
insert into metric_values (id, metric_id, wk, value, updated_at)
select distinct on (f.metric_id, f.new_wk)
       f.metric_id || '|' || f.new_wk, f.metric_id, f.new_wk, f.value, now()
from wk_fix f
where not exists (
  select 1 from metric_values s
  where s.metric_id = f.metric_id and s.wk = f.new_wk
    and s.value is not null and (s.value #>> '{}') <> ''
)
order by f.metric_id, f.new_wk, f.old_wk desc
on conflict (id) do update set value = excluded.value, updated_at = now();

-- 2) Remove the off-day copies that now match their Sunday.
delete from metric_values v
using wk_fix f
where v.id = f.old_id
  and exists (
    select 1 from metric_values s
    where s.metric_id = f.metric_id and s.wk = f.new_wk
      and (s.value #>> '{}') = (f.value #>> '{}')
  );

-- 3) Left for the owner: two different numbers for the same week.
select m.data->>'name'               as metric,
       f.new_wk                       as week_of,
       s.value                        as sunday_number,
       f.old_wk                       as other_date,
       f.value                        as other_number
from wk_fix f
join metric_values s on s.metric_id = f.metric_id and s.wk = f.new_wk
join metrics m       on m.id = f.metric_id
where (s.value #>> '{}') <> (f.value #>> '{}')
order by 1, 2;

commit;
