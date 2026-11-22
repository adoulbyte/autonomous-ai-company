-- =====================================================================
-- 0009 RETENTION: keep the database inside the Supabase free tier (500 MB)
-- Business records (opportunities, CRM, projects, finance, audit) are kept;
-- high-volume operational logs are trimmed. Settings-driven, logged.
-- =====================================================================
insert into public.settings(key, value, description, critical) values
  ('retention.days', '{"events": 180, "ai_calls": 180, "task_runs": 90, "succeeded_tasks": 90, "health_checks": 30, "raw_evidence_payload": 365}',
   'Retention for operational logs. Audit log and business records are never trimmed automatically.', true)
on conflict (key) do nothing;

create or replace function public.apply_retention() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb := public.setting('retention.days'); n_ev int; n_ai int; n_runs int; n_tasks int; n_hc int; n_raw int;
begin
  perform set_config('app.allow_log_retention', 'on', true);
  delete from public.events where occurred_at < now() - make_interval(days => (r->>'events')::int); get diagnostics n_ev = row_count;
  delete from public.ai_calls where at < now() - make_interval(days => (r->>'ai_calls')::int); get diagnostics n_ai = row_count;
  delete from public.task_runs where started_at < now() - make_interval(days => (r->>'task_runs')::int); get diagnostics n_runs = row_count;
  delete from public.tasks t where t.status in ('succeeded','cancelled') and t.finished_at < now() - make_interval(days => (r->>'succeeded_tasks')::int)
    and not exists (select 1 from public.task_dependencies d where d.depends_on_id = t.id)
    and not exists (select 1 from public.deliverables d where d.produced_by_task = t.id)
    and not exists (select 1 from public.qa_reviews q where q.reviewer_task = t.id)
    and not exists (select 1 from public.messages m where m.generated_by_task = t.id)
    and not exists (select 1 from public.strategy_reviews s where s.task_id = t.id)
    and not exists (select 1 from public.tasks c where c.parent_task_id = t.id);
  get diagnostics n_tasks = row_count;
  delete from public.health_checks where at < now() - make_interval(days => (r->>'health_checks')::int); get diagnostics n_hc = row_count;
  update public.evidence set raw = '{}'::jsonb where raw <> '{}'::jsonb and fetched_at < now() - make_interval(days => (r->>'raw_evidence_payload')::int); get diagnostics n_raw = row_count;
  perform set_config('app.allow_log_retention', 'off', true);
  return jsonb_build_object('events', n_ev, 'ai_calls', n_ai, 'task_runs', n_runs, 'tasks', n_tasks, 'health_checks', n_hc, 'evidence_raw_cleared', n_raw);
end $$;
revoke execute on function public.apply_retention() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aic-retention', '17 4 * * *', 'select public.apply_retention();');
  end if;
end $$;
