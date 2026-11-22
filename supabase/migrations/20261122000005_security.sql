-- =====================================================================
-- 0005 SECURITY: RLS everywhere, least-privilege grants, scheduled
--                maintenance (pg_cron if available)
-- =====================================================================

-- Supabase grants broad default privileges to anon/authenticated on objects in
-- `public`. We revoke everything and grant back only what the owner UI needs.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- RLS on every table, owner-only read.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('create policy owner_read on public.%I for select to authenticated using (public.is_owner())', t.tablename);
    execute format('grant select on public.%I to authenticated', t.tablename);
  end loop;
end $$;

-- Reporting views run with security_invoker (RLS of underlying tables applies).
do $$
declare v record;
begin
  for v in select viewname from pg_views where schemaname = 'public' loop
    execute format('grant select on public.%I to authenticated', v.viewname);
  end loop;
end $$;

-- Owner may directly edit low-risk reference data. Everything else goes through RPCs.
do $$
declare t text;
begin
  foreach t in array array['companies','contacts','notes','reminders','message_templates','expenses','sources','tools','agent_roles','ai_providers','ai_models'] loop
    execute format('create policy owner_insert on public.%I for insert to authenticated with check (public.is_owner())', t);
    execute format('create policy owner_update on public.%I for update to authenticated using (public.is_owner()) with check (public.is_owner())', t);
    execute format('grant insert, update on public.%I to authenticated', t);
  end loop;
end $$;
-- Messages: owner can create/edit drafts only (sending goes through approvals).
create policy owner_insert_draft on public.messages for insert to authenticated
  with check (public.is_owner() and status in ('draft','received'));
create policy owner_update_draft on public.messages for update to authenticated
  using (public.is_owner() and status in ('draft','received')) with check (public.is_owner() and status in ('draft','received'));
grant insert, update (subject, body, to_addr, status) on public.messages to authenticated;
create policy owner_insert on public.conversations for insert to authenticated with check (public.is_owner());
create policy owner_update on public.conversations for update to authenticated using (public.is_owner()) with check (public.is_owner());
grant insert, update on public.conversations to authenticated;
grant usage on sequence public.invoice_number_seq to authenticated;

-- RPCs exposed to the authenticated owner (each re-checks is_owner()).
grant execute on function public.is_owner() to authenticated;
grant execute on function public.setting(text) to authenticated;
grant execute on function public.decide_approval(uuid, boolean, text) to authenticated;
grant execute on function public.owner_set_setting(text, jsonb) to authenticated;
grant execute on function public.owner_transition(text, uuid, text, text) to authenticated;
grant execute on function public.owner_enqueue(text, jsonb, text, text, text) to authenticated;
grant execute on function public.owner_task_action(uuid, text) to authenticated;
grant execute on function public.owner_create_invoice(uuid, bigint, text, integer, uuid, text) to authenticated;
grant execute on function public.owner_record_payment(uuid, bigint, text, text, text, boolean, text, text, text, timestamptz) to authenticated;
grant execute on function public.owner_confirm_payment(uuid, text, text, text) to authenticated;
grant execute on function public.owner_create_project(uuid, text, text, bigint, text, timestamptz) to authenticated;
grant execute on function public.owner_log_inbound(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.owner_submit_message(uuid) to authenticated;
-- Trigger/helper functions invoked inside definer functions need no grants.
grant execute on function public.current_actor() to authenticated;
grant execute on function public.touch_updated_at() to authenticated;
grant execute on function public.audit_trigger() to authenticated;
grant execute on function public.enforce_transition() to authenticated;
grant execute on function public.enforce_lead_stage() to authenticated;
grant execute on function public.log_event(text, text, text, text, jsonb, text) to authenticated;
grant execute on function public.messages_require_approval() to authenticated;
grant execute on function public.payments_confirm_guard() to authenticated;
grant execute on function public.require_evidence() to authenticated;
grant execute on function public.forbid_mutation() to authenticated;
grant execute on function public.deliverable_requires_qa() to authenticated;
grant execute on function public.qa_independence() to authenticated;
grant execute on function public.payments_update_invoice() to authenticated;
grant execute on function public.assert_owner() to authenticated;

-- Realtime (Supabase): publish the live event stream if the publication exists.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.events, public.tasks, public.approvals';
  end if;
end $$;

-- In-database maintenance every 5 minutes when pg_cron is available (Supabase provides it).
-- The GitHub Actions worker also runs these, so pg_cron is an optimisation, not a dependency.
do $$ begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron not available: %', sqlerrm;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aic-recover-leases', '*/5 * * * *', 'select public.recover_expired_leases(); select public.expire_approvals();');
  end if;
end $$;
