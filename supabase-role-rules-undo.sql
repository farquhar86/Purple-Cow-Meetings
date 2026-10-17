-- ============================================================================================
-- Round Up: UNDO the role rules (supabase-role-rules.sql)
--
-- Puts the database back to "any logged-in user can change anything", exactly as it was before.
-- The Claude connector's pieces (ru_save_if_unchanged, connector_log and the small helper
-- functions) are left in place, so the connector keeps working. Safe to run more than once.
-- ============================================================================================

drop policy if exists "ru intake insert entries"        on public.entries;
drop policy if exists "ru team update entries"          on public.entries;
drop policy if exists "ru team delete entries"          on public.entries;

drop policy if exists "ru team insert meetings"         on public.meetings;
drop policy if exists "ru team update meetings"         on public.meetings;
drop policy if exists "ru team delete meetings"         on public.meetings;

drop policy if exists "ru team insert metrics"          on public.metrics;
drop policy if exists "ru team update metrics"          on public.metrics;
drop policy if exists "ru team delete metrics"          on public.metrics;

drop policy if exists "ru team insert metric_values"    on public.metric_values;
drop policy if exists "ru team update metric_values"    on public.metric_values;
drop policy if exists "ru team delete metric_values"    on public.metric_values;

drop policy if exists "ru team insert special_projects" on public.special_projects;
drop policy if exists "ru team update special_projects" on public.special_projects;
drop policy if exists "ru team delete special_projects" on public.special_projects;

drop policy if exists "ru team insert swimlanes"        on public.swimlanes;
drop policy if exists "ru team update swimlanes"        on public.swimlanes;
drop policy if exists "ru team delete swimlanes"        on public.swimlanes;

drop policy if exists "ru team insert vision"           on public.mtgs;
drop policy if exists "ru team update vision"           on public.mtgs;
drop policy if exists "ru team delete vision"           on public.mtgs;

-- To also remove the connector's pieces (only if the connector's update tools are being
-- turned off too), run these as well:
--
-- drop function if exists public.ru_save_if_unchanged(text, text, jsonb, jsonb);
-- drop table    if exists public.connector_log;
-- drop function if exists public.ru_exists(text, text);
-- drop function if exists public.ru_reviews(text, text);
-- drop function if exists public.ru_full();
-- drop function if exists public.ru_owns_metric(text, text);
-- drop function if exists public.ru_is_on(jsonb, text);
-- drop function if exists public.ru_role();
-- drop function if exists public.ru_email();
