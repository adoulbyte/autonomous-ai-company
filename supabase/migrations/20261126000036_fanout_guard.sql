-- Fan-out guard: count only the tasks still open or created in the last hour for one entity (a runaway loop is still stopped),
-- instead of every task ever created — a long-lived source or client must not get blocked after weeks of normal work.
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
    select count(*) into v_entity_count from public.tasks where entity_type = p_entity_type and entity_id = p_entity_id
      and (status in ('pending','running','blocked','retry_wait','awaiting_approval') or created_at > now() - interval '1 hour');
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
