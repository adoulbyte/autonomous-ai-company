-- =====================================================================
-- 0004 ENGINE: state transitions, durable queue functions, approvals,
--              owner RPCs, finance logic, views
-- =====================================================================

alter table public.tasks add column deferrals integer not null default 0;

-- ---------------------------------------------------------------------
-- Allowed state transitions
-- ---------------------------------------------------------------------
insert into public.state_transitions(entity, from_state, to_state) values
  -- opportunities
  ('opportunity','discovered','analyzing'), ('opportunity','discovered','rejected'), ('opportunity','discovered','expired'),
  ('opportunity','analyzing','scored'), ('opportunity','analyzing','discovered'), ('opportunity','analyzing','rejected'),
  ('opportunity','scored','shortlisted'), ('opportunity','scored','monitoring'), ('opportunity','scored','rejected'), ('opportunity','scored','analyzing'),
  ('opportunity','monitoring','analyzing'), ('opportunity','monitoring','shortlisted'), ('opportunity','monitoring','rejected'), ('opportunity','monitoring','expired'),
  ('opportunity','shortlisted','pursuing'), ('opportunity','shortlisted','rejected'), ('opportunity','shortlisted','monitoring'), ('opportunity','shortlisted','expired'),
  ('opportunity','rejected','shortlisted'),
  ('opportunity','pursuing','won'), ('opportunity','pursuing','lost'), ('opportunity','pursuing','expired'),
  -- leads
  ('lead','new','qualified'), ('lead','new','disqualified'), ('lead','new','contacted'),
  ('lead','qualified','contacted'), ('lead','qualified','proposal'), ('lead','qualified','disqualified'), ('lead','qualified','lost'),
  ('lead','contacted','engaged'), ('lead','contacted','lost'), ('lead','contacted','proposal'),
  ('lead','engaged','proposal'), ('lead','engaged','negotiating'), ('lead','engaged','lost'),
  ('lead','proposal','negotiating'), ('lead','proposal','won'), ('lead','proposal','lost'),
  ('lead','negotiating','won'), ('lead','negotiating','lost'), ('lead','negotiating','proposal'),
  -- projects
  ('project','planning','in_progress'), ('project','planning','cancelled'), ('project','planning','on_hold'),
  ('project','in_progress','in_qa'), ('project','in_progress','on_hold'), ('project','in_progress','cancelled'),
  ('project','in_qa','in_progress'), ('project','in_qa','ready_for_delivery'), ('project','in_qa','on_hold'),
  ('project','ready_for_delivery','delivered'), ('project','ready_for_delivery','in_progress'),
  ('project','delivered','revision'), ('project','delivered','accepted'),
  ('project','revision','in_progress'),
  ('project','accepted','closed'),
  ('project','on_hold','in_progress'), ('project','on_hold','planning'), ('project','on_hold','cancelled'),
  -- deliverables
  ('deliverable','in_qa','approved'), ('deliverable','in_qa','changes_requested'), ('deliverable','in_qa','rejected'),
  ('deliverable','changes_requested','superseded'), ('deliverable','approved','superseded'),
  ('deliverable','approved','ready_for_delivery'), ('deliverable','ready_for_delivery','delivered'),
  ('deliverable','delivered','accepted'), ('deliverable','delivered','superseded'),
  -- messages
  ('message','draft','awaiting_approval'), ('message','draft','rejected'),
  ('message','awaiting_approval','approved'), ('message','awaiting_approval','rejected'),
  ('message','approved','sent'), ('message','approved','failed'), ('message','failed','approved'),
  -- invoices
  ('invoice','draft','issued'), ('invoice','draft','void'),
  ('invoice','issued','partially_paid'), ('invoice','issued','paid'), ('invoice','issued','overdue'), ('invoice','issued','void'),
  ('invoice','partially_paid','paid'), ('invoice','partially_paid','overdue'),
  ('invoice','overdue','paid'), ('invoice','overdue','partially_paid'), ('invoice','overdue','void'),
  -- approvals
  ('approval','pending','approved'), ('approval','pending','rejected'), ('approval','pending','expired'),
  ('approval','approved','executed'), ('approval','approved','failed');

-- ---------------------------------------------------------------------
-- Queue: enqueue (idempotent, dependency-aware, fan-out limited)
-- ---------------------------------------------------------------------
create or replace function public.enqueue_task(
  p_type text, p_idempotency_key text, p_input jsonb default '{}'::jsonb,
  p_role_key text default null, p_entity_type text default null, p_entity_id text default null,
  p_priority integer default 50, p_run_after timestamptz default now(), p_max_attempts integer default 3,
  p_timeout_seconds integer default 180, p_depends_on uuid[] default '{}', p_title text default null,
  p_parent_task_id uuid default null, p_approval_id uuid default null, p_deadline_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_status text; v_entity_count integer;
  v_cap integer := coalesce((public.setting('limits.max_tasks_per_entity'))::text::integer, 60);
  v_pending_cap integer := coalesce((public.setting('limits.max_open_tasks'))::text::integer, 2000);
begin
  select id into v_id from public.tasks where idempotency_key = p_idempotency_key;
  if v_id is not null then return v_id; end if;

  if p_entity_id is not null then
    select count(*) into v_entity_count from public.tasks where entity_type = p_entity_type and entity_id = p_entity_id;
    if v_entity_count >= v_cap then
      raise exception 'task fan-out limit reached for % % (%)', p_entity_type, p_entity_id, v_cap using errcode = 'P0001';
    end if;
  end if;
  if (select count(*) from public.tasks where status in ('pending','blocked','retry_wait','awaiting_approval')) >= v_pending_cap then
    raise exception 'global open-task cap (%) reached', v_pending_cap using errcode = 'P0001';
  end if;

  v_status := case
    when p_approval_id is not null and not exists (select 1 from public.approvals where id = p_approval_id and status in ('approved','executed')) then 'awaiting_approval'
    when exists (select 1 from public.tasks d where d.id = any(p_depends_on) and d.status <> 'succeeded') then 'blocked'
    else 'pending' end;

  insert into public.tasks(type, role_key, status, priority, title, entity_type, entity_id, input, idempotency_key,
                           max_attempts, run_after, timeout_seconds, parent_task_id, approval_id, deadline_at, created_by)
  values (p_type, p_role_key, v_status, p_priority, p_title, p_entity_type, p_entity_id, coalesce(p_input,'{}'::jsonb), p_idempotency_key,
          p_max_attempts, coalesce(p_run_after, now()), p_timeout_seconds, p_parent_task_id, p_approval_id, p_deadline_at, public.current_actor())
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then  -- lost a race: return the winner
    select id into v_id from public.tasks where idempotency_key = p_idempotency_key;
    return v_id;
  end if;

  insert into public.task_dependencies(task_id, depends_on_id)
  select v_id, d from unnest(p_depends_on) d on conflict do nothing;

  perform public.log_event('task', v_id::text, 'task_created', format('%s queued (%s)', coalesce(p_title, p_type), v_status),
    jsonb_build_object('type', p_type, 'status', v_status, 'role', p_role_key));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Queue: claim with lease (SKIP LOCKED); honours kill switch & deps
-- ---------------------------------------------------------------------
create or replace function public.claim_tasks(p_worker text, p_limit integer default 1, p_types text[] default null)
returns setof public.tasks language plpgsql security definer set search_path = public as $$
begin
  if coalesce((public.setting('system.kill_switch'))::text::boolean, false) then
    return;
  end if;
  return query
  with c as (
    select t.id from public.tasks t
    where t.status in ('pending','retry_wait') and t.run_after <= now()
      and (p_types is null or t.type = any(p_types))
      and not exists (select 1 from public.task_dependencies d join public.tasks dt on dt.id = d.depends_on_id
                      where d.task_id = t.id and dt.status <> 'succeeded')
      and (t.role_key is null or exists (select 1 from public.agent_roles r where r.key = t.role_key and r.enabled))
    order by t.priority desc, t.run_after
    limit greatest(p_limit, 0)
    for update skip locked
  ), u as (
    update public.tasks t set status = 'running', attempts = t.attempts + 1, lease_owner = p_worker,
           lease_expires_at = now() + make_interval(secs => t.timeout_seconds),
           started_at = coalesce(t.started_at, now()), error = null
    from c where t.id = c.id
    returning t.*
  ), r as (
    insert into public.task_runs(task_id, attempt, worker_id) select u.id, u.attempts, p_worker from u
  )
  select * from u;
end $$;

create or replace function public.heartbeat_task(p_task_id uuid, p_worker text, p_progress integer default null, p_note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update public.tasks set lease_expires_at = now() + make_interval(secs => timeout_seconds),
         progress = coalesce(p_progress, progress), progress_note = coalesce(p_note, progress_note)
  where id = p_task_id and status = 'running' and lease_owner = p_worker
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.unblock_dependents(p_task_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tasks t set status = 'pending'
  where t.status = 'blocked'
    and exists (select 1 from public.task_dependencies d where d.task_id = t.id and d.depends_on_id = p_task_id)
    and not exists (select 1 from public.task_dependencies d join public.tasks dt on dt.id = d.depends_on_id
                    where d.task_id = t.id and dt.status <> 'succeeded');
end $$;

create or replace function public.complete_task(p_task_id uuid, p_worker text, p_output jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare v public.tasks;
begin
  update public.tasks set status = 'succeeded', output = p_output, finished_at = now(), progress = 100,
         lease_owner = null, lease_expires_at = null
  where id = p_task_id and status = 'running' and lease_owner = p_worker
  returning * into v;
  if v.id is null then return false; end if;  -- lease lost: result is discarded, never reported as done
  update public.task_runs set status = 'succeeded', finished_at = now(),
         duration_ms = (extract(epoch from now() - started_at) * 1000)::int
  where task_id = p_task_id and attempt = v.attempts and worker_id = p_worker;
  perform public.unblock_dependents(p_task_id);
  perform public.log_event('task', p_task_id::text, 'task_succeeded', format('%s succeeded', coalesce(v.title, v.type)),
    jsonb_build_object('type', v.type, 'attempts', v.attempts));
  return true;
end $$;

create or replace function public.fail_task(p_task_id uuid, p_worker text, p_error text, p_retryable boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare v public.tasks; v_new text; v_backoff integer;
begin
  select * into v from public.tasks where id = p_task_id and status = 'running' and lease_owner = p_worker for update;
  if v.id is null then return 'lease_lost'; end if;
  v_backoff := least(3600, (30 * power(2, greatest(v.attempts - 1, 0)))::int);
  v_new := case when p_retryable and v.attempts < v.max_attempts then 'retry_wait' else 'dead' end;
  update public.tasks set status = v_new, error = left(p_error, 4000), lease_owner = null, lease_expires_at = null,
         run_after = case when v_new = 'retry_wait' then now() + make_interval(secs => v_backoff) else run_after end,
         finished_at = case when v_new = 'dead' then now() else null end
  where id = p_task_id;
  update public.task_runs set status = case when v_new = 'dead' then 'failed' else 'retry' end, finished_at = now(), error = left(p_error, 4000),
         duration_ms = (extract(epoch from now() - started_at) * 1000)::int
  where task_id = p_task_id and attempt = v.attempts and worker_id = p_worker;
  if v_new = 'dead' then
    -- dependents can never run: cancel them explicitly (visible, recoverable via retry)
    update public.tasks t set status = 'cancelled', error = 'dependency ' || p_task_id || ' failed'
    where t.status = 'blocked' and exists (select 1 from public.task_dependencies d where d.task_id = t.id and d.depends_on_id = p_task_id);
    perform public.log_event('task', p_task_id::text, 'task_dead_lettered', format('%s moved to dead-letter queue: %s', coalesce(v.title, v.type), left(p_error, 300)),
      jsonb_build_object('type', v.type, 'attempts', v.attempts), 'error');
  else
    perform public.log_event('task', p_task_id::text, 'task_retry_scheduled', format('%s failed (attempt %s/%s), retry in %ss', coalesce(v.title, v.type), v.attempts, v.max_attempts, v_backoff),
      jsonb_build_object('error', left(p_error, 500)), 'warning');
  end if;
  return v_new;
end $$;

-- Defer without consuming an attempt (e.g. no AI model currently available). Bounded.
create or replace function public.defer_task(p_task_id uuid, p_worker text, p_seconds integer, p_reason text)
returns text language plpgsql security definer set search_path = public as $$
declare v public.tasks; v_max integer := coalesce((public.setting('limits.max_deferrals'))::text::integer, 48);
begin
  select * into v from public.tasks where id = p_task_id and status = 'running' and lease_owner = p_worker for update;
  if v.id is null then return 'lease_lost'; end if;
  if v.deferrals + 1 > v_max then
    perform public.fail_task(p_task_id, p_worker, 'deferred too many times: ' || p_reason, false);
    return 'dead';
  end if;
  update public.tasks set status = 'retry_wait', attempts = greatest(attempts - 1, 0), deferrals = deferrals + 1,
         error = left(p_reason, 2000), lease_owner = null, lease_expires_at = null,
         run_after = now() + make_interval(secs => greatest(p_seconds, 30))
  where id = p_task_id;
  update public.task_runs set status = 'retry', finished_at = now(), error = left(p_reason, 2000)
  where task_id = p_task_id and attempt = v.attempts and worker_id = p_worker;
  perform public.log_event('task', p_task_id::text, 'task_deferred', format('%s deferred: %s', coalesce(v.title, v.type), left(p_reason, 200)), '{}'::jsonb, 'warning');
  return 'deferred';
end $$;

-- Recover tasks whose worker died (lease expired). Safe to call from any worker or pg_cron.
create or replace function public.recover_expired_leases() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; r record;
begin
  for r in select * from public.tasks where status = 'running' and lease_expires_at < now() for update skip locked loop
    update public.task_runs set status = 'lease_expired', finished_at = now(), error = 'lease expired (worker lost)'
    where task_id = r.id and attempt = r.attempts and finished_at is null;
    update public.tasks set
      status = case when r.attempts < r.max_attempts then 'retry_wait' else 'dead' end,
      run_after = now() + interval '30 seconds', lease_owner = null, lease_expires_at = null,
      error = 'lease expired: worker stopped before finishing',
      finished_at = case when r.attempts < r.max_attempts then null else now() end
    where id = r.id;
    perform public.log_event('task', r.id::text, 'lease_recovered', format('Recovered %s after worker loss', coalesce(r.title, r.type)), '{}'::jsonb, 'warning');
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Approvals
-- ---------------------------------------------------------------------
create or replace function public.request_approval(
  p_action_type text, p_title text, p_requested_by text, p_reason text,
  p_if_approved text, p_if_rejected text, p_payload jsonb default '{}'::jsonb,
  p_evidence jsonb default '[]'::jsonb, p_expected_benefit text default null, p_risk text default null,
  p_risk_level text default 'medium', p_cost_minor bigint default 0, p_currency text default 'USD',
  p_entity_type text default null, p_entity_id text default null, p_task_id uuid default null,
  p_idempotency_key text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_idempotency_key is not null then
    select id into v_id from public.approvals where idempotency_key = p_idempotency_key;
    if v_id is not null then return v_id; end if;
  end if;
  insert into public.approvals(action_type, title, requested_by, reason, if_approved, if_rejected, payload, evidence,
                               expected_benefit, risk, risk_level, cost_minor, currency, entity_type, entity_id, task_id, idempotency_key)
  values (p_action_type, p_title, p_requested_by, p_reason, p_if_approved, p_if_rejected, coalesce(p_payload,'{}'), coalesce(p_evidence,'[]'),
          p_expected_benefit, p_risk, p_risk_level, p_cost_minor, p_currency, p_entity_type, p_entity_id, p_task_id, p_idempotency_key)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then select id into v_id from public.approvals where idempotency_key = p_idempotency_key; return v_id; end if;
  perform public.log_event('approval', v_id::text, 'approval_requested', p_title,
    jsonb_build_object('action_type', p_action_type, 'requested_by', p_requested_by, 'risk_level', p_risk_level), 'warning');
  return v_id;
end $$;

-- Owner decision. Enforced in the database: non-owners get 42501 regardless of UI.
create or replace function public.decide_approval(p_id uuid, p_approve boolean, p_note text default null)
returns public.approvals language plpgsql security definer set search_path = public as $$
declare a public.approvals; v_key text; v_val jsonb;
begin
  if not public.is_owner() then raise exception 'only the owner can decide approvals' using errcode = '42501'; end if;
  select * into a from public.approvals where id = p_id for update;
  if a.id is null then raise exception 'approval not found' using errcode = 'P0002'; end if;
  if a.status <> 'pending' then raise exception 'approval already %', a.status using errcode = 'P0001'; end if;
  if a.expires_at < now() then
    update public.approvals set status = 'expired' where id = p_id returning * into a;
    return a;
  end if;

  update public.approvals set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = public.current_actor(), decided_at = now(), decision_note = p_note
  where id = p_id returning * into a;

  -- Gated tasks
  update public.tasks set status = case when p_approve then 'pending' else 'cancelled' end,
         error = case when p_approve then null else 'rejected by owner' end
  where approval_id = p_id and status = 'awaiting_approval';

  -- Gated outbound messages
  update public.messages set status = case when p_approve then 'approved' else 'rejected' end
  where approval_id = p_id and status = 'awaiting_approval';

  -- Critical setting changes proposed by agents
  if p_approve and a.action_type = 'settings.change' then
    v_key := a.payload ->> 'key'; v_val := a.payload -> 'value';
    if v_key is null or v_val is null then raise exception 'settings.change payload invalid'; end if;
    update public.settings set value = v_val, version = version + 1, updated_by = public.current_actor() where key = v_key;
    update public.approvals set status = 'executed', executed_at = now(), execution_result = jsonb_build_object('applied', v_key) where id = p_id returning * into a;
  end if;

  perform public.log_event('approval', p_id::text, case when p_approve then 'approval_granted' else 'approval_rejected' end,
    a.title, jsonb_build_object('note', p_note));
  return a;
end $$;

create or replace function public.expire_approvals() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with e as (update public.approvals set status = 'expired' where status = 'pending' and expires_at < now() returning id)
  select count(*) into n from e;
  update public.tasks t set status = 'cancelled', error = 'approval expired'
  where t.status = 'awaiting_approval' and exists (select 1 from public.approvals a where a.id = t.approval_id and a.status = 'expired');
  update public.messages m set status = 'rejected'
  where m.status = 'awaiting_approval' and exists (select 1 from public.approvals a where a.id = m.approval_id and a.status = 'expired');
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Finance logic
-- ---------------------------------------------------------------------
create or replace function public.payments_update_invoice() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv public.invoices; paid bigint;
begin
  if new.invoice_id is null then return new; end if;
  select * into inv from public.invoices where id = new.invoice_id for update;
  if new.currency <> inv.currency then
    raise exception 'payment currency % does not match invoice currency %', new.currency, inv.currency using errcode = 'P0001';
  end if;
  if new.status = 'confirmed' then
    if inv.status in ('draft','void') then raise exception 'cannot confirm payment against % invoice', inv.status using errcode = 'P0001'; end if;
    select coalesce(sum(amount_minor),0) into paid from public.payments where invoice_id = inv.id and status = 'confirmed';
    if paid >= inv.amount_minor and inv.status <> 'paid' then
      update public.invoices set status = 'paid' where id = inv.id;
    elsif paid > 0 and paid < inv.amount_minor and inv.status not in ('partially_paid') then
      update public.invoices set status = 'partially_paid' where id = inv.id;
    end if;
    perform public.log_event('payment', new.id::text, 'payment_confirmed',
      format('Payment confirmed: %s %s (%s)', new.amount_minor / 100.0, new.currency, new.evidence_type),
      jsonb_build_object('invoice', inv.number, 'evidence_type', new.evidence_type));
  end if;
  return new;
end $$;
create trigger payments_invoice after insert or update of status on public.payments for each row execute function public.payments_update_invoice();

-- ---------------------------------------------------------------------
-- Owner RPCs (every one checks is_owner(); RLS blocks direct writes)
-- ---------------------------------------------------------------------
create or replace function public.assert_owner() returns void language plpgsql stable security definer set search_path = public as $$
begin if not public.is_owner() then raise exception 'owner authentication required' using errcode = '42501'; end if; end $$;

create or replace function public.owner_set_setting(p_key text, p_value jsonb) returns public.settings
language plpgsql security definer set search_path = public as $$
declare s public.settings;
begin
  perform public.assert_owner();
  update public.settings set value = p_value, version = version + 1, updated_by = public.current_actor()
  where key = p_key returning * into s;
  if s.key is null then raise exception 'unknown setting %', p_key using errcode = 'P0002'; end if;
  perform public.log_event('settings', p_key, 'setting_changed', format('Setting %s changed by owner', p_key), jsonb_build_object('value', p_value),
    case when s.critical then 'warning' else 'info' end);
  return s;
end $$;

create or replace function public.owner_transition(p_entity text, p_id uuid, p_to text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_owner();
  case p_entity
    when 'opportunity' then
      update public.opportunities set status = p_to,
        decision_reasons = case when p_reason is not null then decision_reasons || ('owner: ' || p_reason) else decision_reasons end
      where id = p_id;
      if p_to in ('shortlisted','rejected','monitoring') then
        insert into public.opportunity_decisions(opportunity_id, decision, reasons, decided_by)
        values (p_id, case p_to when 'shortlisted' then 'pursue' when 'rejected' then 'reject' else 'monitor' end,
                array[coalesce('owner override: ' || p_reason, 'owner override')], public.current_actor());
      end if;
    when 'lead' then update public.leads set stage = p_to, lost_reason = coalesce(p_reason, lost_reason) where id = p_id;
    when 'project' then update public.projects set status = p_to,
        delivered_at = case when p_to = 'delivered' then now() else delivered_at end,
        accepted_at = case when p_to = 'accepted' then now() else accepted_at end where id = p_id;
    when 'deliverable' then update public.deliverables set status = p_to where id = p_id;
    when 'invoice' then update public.invoices set status = p_to where id = p_id;
    else raise exception 'unsupported entity %', p_entity;
  end case;
  if not found then raise exception '% % not found', p_entity, p_id using errcode = 'P0002'; end if;
  if p_reason is not null then
    insert into public.notes(entity_type, entity_id, body) values (p_entity, p_id, 'Status → ' || p_to || ': ' || p_reason);
  end if;
end $$;

create or replace function public.owner_enqueue(p_type text, p_input jsonb, p_entity_type text default null, p_entity_id text default null, p_title text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  perform public.assert_owner();
  if p_type not in ('discovery.run_source','opportunity.analyze','opportunity.score','lead.draft_outreach','project.plan',
                    'project.prepare_delivery','strategy.review','analytics.snapshot','comms.triage','system.health_check') then
    raise exception 'task type % cannot be created manually', p_type using errcode = '42501';
  end if;
  select key into v_role from public.agent_roles where p_type = any(task_types) limit 1;
  return public.enqueue_task(p_type, 'owner:' || p_type || ':' || coalesce(p_entity_id,'') || ':' || gen_random_uuid(), coalesce(p_input,'{}'),
                             v_role, p_entity_type, p_entity_id, 80, now(), 3, 300, '{}', coalesce(p_title, 'Owner request: ' || p_type));
end $$;

create or replace function public.owner_task_action(p_task_id uuid, p_action text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_owner();
  if p_action = 'cancel' then
    update public.tasks set status = 'cancelled', lease_owner = null, lease_expires_at = null, error = 'cancelled by owner', finished_at = now()
    where id = p_task_id and status in ('pending','blocked','retry_wait','awaiting_approval','running');
  elsif p_action = 'retry' then
    update public.tasks set status = 'pending', attempts = 0, deferrals = 0, run_after = now(), error = null, finished_at = null
    where id = p_task_id and status in ('dead','cancelled','failed');
    -- previously cancelled dependents become blocked again
    update public.tasks t set status = 'blocked', error = null
    where t.status = 'cancelled' and t.error = 'dependency ' || p_task_id || ' failed';
  else raise exception 'unknown action %', p_action;
  end if;
  if not found then raise exception 'task not in a state allowing %', p_action using errcode = 'P0001'; end if;
  perform public.log_event('task', p_task_id::text, 'task_' || p_action || '_by_owner', 'Owner ' || p_action || ' task');
end $$;

create or replace function public.owner_create_invoice(p_project_id uuid, p_amount_minor bigint, p_currency text, p_due_days integer default 14,
                                                       p_milestone_id uuid default null, p_notes text default null)
returns public.invoices language plpgsql security definer set search_path = public as $$
declare inv public.invoices; v_client uuid;
begin
  perform public.assert_owner();
  select client_id into v_client from public.projects where id = p_project_id;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  insert into public.invoices(number, project_id, client_id, milestone_id, due_date, amount_minor, currency, notes)
  values ('INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.invoice_number_seq')::text, 5, '0'),
          p_project_id, v_client, p_milestone_id, current_date + p_due_days, p_amount_minor, upper(p_currency), p_notes)
  returning * into inv;
  perform public.log_event('invoice', inv.id::text, 'invoice_created', format('Invoice %s drafted: %s %s', inv.number, p_amount_minor / 100.0, inv.currency));
  return inv;
end $$;

-- Record a payment. Confirmation requires evidence; the DB rejects anything else.
create or replace function public.owner_record_payment(p_invoice_id uuid, p_amount_minor bigint, p_currency text, p_method text,
    p_external_ref text, p_confirm boolean, p_evidence_type text default null, p_evidence_ref text default null, p_evidence_note text default null,
    p_received_at timestamptz default null)
returns public.payments language plpgsql security definer set search_path = public as $$
declare p public.payments;
begin
  perform public.assert_owner();
  insert into public.payments(invoice_id, amount_minor, currency, method, external_ref, status, evidence_type, evidence_ref, evidence_note,
                              received_at, confirmed_by, confirmed_at)
  values (p_invoice_id, p_amount_minor, upper(p_currency), p_method, p_external_ref,
          case when p_confirm then 'confirmed' else 'pending' end,
          p_evidence_type, p_evidence_ref, p_evidence_note, p_received_at,
          case when p_confirm then public.current_actor() end, case when p_confirm then now() end)
  returning * into p;
  return p;
end $$;

create or replace function public.owner_confirm_payment(p_payment_id uuid, p_evidence_type text, p_evidence_ref text, p_evidence_note text default null)
returns public.payments language plpgsql security definer set search_path = public as $$
declare p public.payments;
begin
  perform public.assert_owner();
  update public.payments set status = 'confirmed', evidence_type = p_evidence_type, evidence_ref = p_evidence_ref,
         evidence_note = coalesce(p_evidence_note, evidence_note), confirmed_by = public.current_actor(), confirmed_at = now()
  where id = p_payment_id and status = 'pending' returning * into p;
  if p.id is null then raise exception 'payment not pending or not found' using errcode = 'P0001'; end if;
  return p;
end $$;


-- Convert a won lead into a project (owner commits to the work).
create or replace function public.owner_create_project(p_lead_id uuid, p_name text, p_scope text, p_budget_minor bigint,
                                                       p_currency text, p_deadline_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare l public.leads; v_client uuid; v_project uuid;
begin
  perform public.assert_owner();
  select * into l from public.leads where id = p_lead_id for update;
  if l.id is null then raise exception 'lead not found' using errcode = 'P0002'; end if;
  if l.company_id is not null then
    insert into public.clients(company_id) values (l.company_id) on conflict (company_id) do nothing;
    select id into v_client from public.clients where company_id = l.company_id;
  end if;
  insert into public.projects(opportunity_id, lead_id, client_id, name, scope, budget_minor, currency, deadline_at)
  values (l.opportunity_id, l.id, v_client, p_name, p_scope, p_budget_minor, upper(p_currency), p_deadline_at)
  returning id into v_project;
  perform public.enqueue_task('project.plan', 'project.plan:' || v_project, jsonb_build_object('project_id', v_project),
    'project_architect', 'project', v_project::text, 70, now(), 3, 300, '{}', 'Plan project: ' || p_name);
  perform public.log_event('project', v_project::text, 'project_created', format('Project "%s" created', p_name));
  return v_project;
end $$;


-- Owner logs an inbound message (e.g. a reply received by email/platform) for triage.
create or replace function public.owner_log_inbound(p_conversation_id uuid, p_lead_id uuid, p_subject text, p_body text, p_from text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_conv uuid := p_conversation_id; v_msg uuid;
begin
  perform public.assert_owner();
  if v_conv is null then
    insert into public.conversations(lead_id, channel, subject) values (p_lead_id, 'email', coalesce(p_subject, '(no subject)')) returning id into v_conv;
  end if;
  insert into public.messages(conversation_id, direction, status, from_addr, subject, body)
  values (v_conv, 'inbound', 'received', p_from, p_subject, p_body) returning id into v_msg;
  perform public.enqueue_task('comms.triage', 'comms.triage:' || v_msg, jsonb_build_object('message_id', v_msg), 'communications',
    'message', v_msg::text, 75, now(), 3, 120, '{}', 'Triage inbound message');
  return v_msg;
end $$;

-- Owner approves sending a drafted message: creates the approval record and links it.
create or replace function public.owner_submit_message(p_message_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare m public.messages; v_approval uuid;
begin
  perform public.assert_owner();
  select * into m from public.messages where id = p_message_id and status = 'draft';
  if m.id is null then raise exception 'message is not a draft' using errcode = 'P0001'; end if;
  v_approval := public.request_approval('message.send', 'Send: ' || coalesce(m.subject, '(no subject)'), 'owner',
    'Owner submitted draft for sending', 'Message becomes approved for sending.', 'Message is rejected and not sent.',
    jsonb_build_object('message_id', m.id), '[]', null, 'External communication', 'medium', 0, 'USD', 'message', m.id::text, null,
    'message.send:' || m.id);
  update public.messages set status = 'awaiting_approval', approval_id = v_approval where id = m.id;
  return v_approval;
end $$;

-- ---------------------------------------------------------------------
-- Views (security_invoker so RLS applies)
-- ---------------------------------------------------------------------
create or replace view public.v_finance_by_currency with (security_invoker = true) as
with cur as (
  select currency from public.invoices union select currency from public.payments union select currency from public.expenses
)
select c.currency,
  coalesce((select sum(amount_minor) from public.payments p where p.currency = c.currency and p.status = 'confirmed'), 0)::bigint as confirmed_revenue_minor,
  coalesce((select sum(amount_minor) from public.payments p where p.currency = c.currency and p.status = 'pending'), 0)::bigint as unconfirmed_payments_minor,
  coalesce((select sum(i.amount_minor - coalesce((select sum(p.amount_minor) from public.payments p where p.invoice_id = i.id and p.status = 'confirmed'),0))
            from public.invoices i where i.currency = c.currency and i.status in ('issued','partially_paid','overdue')), 0)::bigint as receivable_minor,
  coalesce((select sum(amount_minor) from public.invoices i where i.currency = c.currency and i.status <> 'void' and i.status <> 'draft'), 0)::bigint as invoiced_minor,
  coalesce((select sum(amount_minor) from public.expenses e where e.currency = c.currency), 0)::bigint as expenses_minor,
  (coalesce((select sum(amount_minor) from public.payments p where p.currency = c.currency and p.status = 'confirmed'), 0)
   - coalesce((select sum(amount_minor) from public.expenses e where e.currency = c.currency), 0))::bigint as net_profit_minor
from cur c;

create or replace view public.v_project_profitability with (security_invoker = true) as
select pr.id as project_id, pr.name, pr.status, pr.currency, pr.budget_minor,
  coalesce((select sum(p.amount_minor) from public.payments p join public.invoices i on i.id = p.invoice_id
            where i.project_id = pr.id and p.status = 'confirmed' and p.currency = pr.currency), 0)::bigint as revenue_minor,
  coalesce((select sum(e.amount_minor) from public.expenses e where e.project_id = pr.id and e.currency = pr.currency), 0)::bigint as expenses_minor,
  coalesce((select sum(c.cost_micros) from public.ai_calls c join public.tasks t on t.id = c.task_id
            where t.entity_id = pr.id::text or t.input ->> 'project_id' = pr.id::text), 0)::bigint as ai_cost_micros,
  (select count(*) from public.ai_calls c join public.tasks t on t.id = c.task_id
            where t.entity_id = pr.id::text or t.input ->> 'project_id' = pr.id::text)::int as ai_calls
from public.projects pr;

create or replace view public.v_queue_stats with (security_invoker = true) as
select status, count(*)::int as count, min(run_after) as oldest_run_after from public.tasks group by status;

create or replace view public.v_agent_performance with (security_invoker = true) as
select r.key as role_key, r.name, r.department, r.enabled, r.model_tier,
  (select count(*) from public.tasks t where t.role_key = r.key and t.status = 'succeeded')::int as tasks_succeeded,
  (select count(*) from public.tasks t where t.role_key = r.key and t.status = 'dead')::int as tasks_dead,
  (select count(*) from public.tasks t where t.role_key = r.key and t.status in ('pending','retry_wait','blocked'))::int as tasks_queued,
  (select count(*) from public.tasks t where t.role_key = r.key and t.status = 'running')::int as tasks_running,
  (select count(*) from public.ai_calls c where c.role_key = r.key and c.at > now() - interval '24 hours')::int as ai_calls_24h,
  (select coalesce(sum(c.prompt_tokens + c.completion_tokens),0) from public.ai_calls c where c.role_key = r.key and c.at > now() - interval '30 days')::bigint as tokens_30d,
  (select coalesce(sum(c.cost_micros),0) from public.ai_calls c where c.role_key = r.key and c.at > now() - interval '30 days')::bigint as cost_micros_30d,
  (select max(t.updated_at) from public.tasks t where t.role_key = r.key) as last_activity_at,
  (select t.title from public.tasks t where t.role_key = r.key and t.status = 'running' order by t.started_at desc limit 1) as current_task
from public.agent_roles r;

create or replace view public.v_source_performance with (security_invoker = true) as
select s.key, s.name, s.enabled, s.health, s.last_run_at, s.items_found_total,
  (select count(*) from public.opportunities o where o.source_key = s.key)::int as opportunities,
  (select count(*) from public.opportunities o where o.source_key = s.key and o.status in ('shortlisted','pursuing','won'))::int as shortlisted_or_better,
  (select count(*) from public.opportunities o where o.source_key = s.key and o.status = 'won')::int as won,
  (select round(avg(o.score),2) from public.opportunities o where o.source_key = s.key and o.score is not null) as avg_score
from public.sources s;

create or replace view public.v_model_performance with (security_invoker = true) as
select m.provider_key, m.model, m.tier, m.enabled, m.cooldown_until, m.last_error, m.last_success_at,
  (select count(*) from public.ai_calls c where c.provider_key = m.provider_key and c.model = m.model and c.at > now() - interval '7 days')::int as calls_7d,
  (select count(*) from public.ai_calls c where c.provider_key = m.provider_key and c.model = m.model and c.status = 'ok' and c.at > now() - interval '7 days')::int as ok_7d,
  (select round(avg(c.latency_ms)) from public.ai_calls c where c.provider_key = m.provider_key and c.model = m.model and c.status = 'ok' and c.at > now() - interval '7 days') as avg_latency_ms_7d,
  (select coalesce(sum(c.prompt_tokens + c.completion_tokens),0) from public.ai_calls c where c.provider_key = m.provider_key and c.model = m.model and c.at > now() - interval '30 days')::bigint as tokens_30d
from public.ai_models m;
