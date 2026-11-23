-- =====================================================================
-- 0017 LAUNCH MODE: free work in exchange for honest feedback; feedback capture;
--      client-requested revisions after delivery
-- =====================================================================
insert into public.settings(key, value, description, critical) values
  ('business.mode', '{"mode": "free_pilot", "max_active_pilots": 10, "ask_review": true}',
   'free_pilot = work delivered free in exchange for honest feedback (launch phase); paid = market pricing + invoices.', true)
on conflict (key) do nothing;

create table if not exists public.client_feedback (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects(id) on delete cascade,
  message_id             uuid references public.messages(id),
  rating                 integer check (rating between 1 and 5),
  comment                text,
  permission_to_publish  boolean not null default false,   -- only true if the client explicitly agreed
  wants_changes          boolean not null default false,
  change_request         text,
  author                 text,
  created_at             timestamptz not null default now()
);
create index if not exists client_feedback_project_idx on public.client_feedback(project_id, created_at desc);
alter table public.client_feedback enable row level security;
create policy owner_read on public.client_feedback for select to authenticated using (public.is_owner());
grant select on public.client_feedback to authenticated;

insert into public.agent_roles(key, name, department, objective, supervisor, model_tier, allowed_tools, task_types, permissions, input_schema, output_schema, quality_rules, max_output_tokens, daily_call_budget, retry_max, timeout_seconds, is_ai) values
 ('customer_success','Customer Success Agent','Client Relations','After delivery: collect honest feedback, handle change requests within scope, and record permission to quote the client.','owner','standard',
  '{llm,email}','{feedback.capture}','{feedback.write,projects.revision,messages.draft}',
  '{"message_id":"uuid","project_id":"uuid"}','{"rating":"1-5|null","comment":"string","permission_to_publish":"bool","wants_changes":"bool"}',
  '{"never publish a review without explicit permission","never pressure for a positive review","treat change requests within agreed scope"}',900,300,3,150,true)
on conflict (key) do nothing;

-- Allow re-delivery after a revision (delivered → revision → in_progress already allowed for projects;
-- delivered deliverables can be superseded by a new version).
insert into public.state_transitions(entity, from_state, to_state) values
  ('deliverable', 'delivered', 'changes_requested')
on conflict do nothing;

-- Client references: only ever created with the client's explicit permission.
create table if not exists public.portfolio_items (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects(id) on delete cascade,
  client_permission_at  timestamptz not null,
  public_text           text not null,
  created_at            timestamptz not null default now()
);
alter table public.portfolio_items enable row level security;
create policy owner_read on public.portfolio_items for select to authenticated using (public.is_owner());
grant select on public.portfolio_items to authenticated;
