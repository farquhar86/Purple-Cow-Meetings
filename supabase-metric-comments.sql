-- Round Up: weekly comments on metrics, written through the Claude connector
-- Run once in Supabase ▸ SQL Editor. Safe to re-run.
--
-- Comments live on the metric itself (metrics.data.notes, one entry per week), so the app needs
-- no new table. This only lets the connector's safe save (ru_save_if_unchanged) work on metrics,
-- the same way it already does for priorities, special projects and meeting items. It runs as
-- the person asking, so the existing rules still apply: Team-role users can only change metrics
-- they own or review, everyone else any metric.
--
-- Needs supabase-role-rules.sql to have been run first (it created this function).
-- To undo: re-run the function from supabase-role-rules.sql as it was, without 'metrics'.

create or replace function public.ru_save_if_unchanged(p_table text, p_id text, p_expected jsonb, p_new jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  if p_table not in ('entries', 'special_projects', 'mtg_items', 'metrics') then
    raise exception 'ru_save_if_unchanged: % is not allowed', p_table;
  end if;
  execute format('update public.%I set data = $1, updated_at = now() where id = $2 and data = $3', p_table)
    using p_new, p_id, p_expected;
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function public.ru_save_if_unchanged(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.ru_save_if_unchanged(text, text, jsonb, jsonb) to authenticated;
