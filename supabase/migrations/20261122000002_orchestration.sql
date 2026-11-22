-- =====================================================================
-- 0002 ORCHESTRATION: agents, AI registry, tools, task queue, approvals
-- =====================================================================

-- ---------------------------------------------------------------------
-- Agent roles (config-as-data, versioned through audit log)
-- ---------------------------------------------------------------------
create table public.agent_roles (
  key              text primary key,
  name             text not null,
  department       text not null,
  objective        text not null,
  supervisor       text,                          -- role key or 'owner'
  model_tier       text not null default 'standard' check (model_tier in ('none','fast','standard','strong')),
  allowed_tools    text[] not null default '{}',
  task_types       text[] not null default '{}',
  permissions      text[] not null default '{}',
  input_schema     jsonb not null default '{}'::jsonb,
  output_schema    jsonb not null default '{}'::jsonb,
  quality_rules    text[] not null default '{}',
  max_output_tokens integer not null default 2000,
  daily_call_budget integer not null default 200 check (daily_call_budget >= 0),
  retry_max        integer not null default 3,
  timeout_seconds  integer not null default 120,
  is_ai            boolean not null default true,
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger agent_roles_audit after insert or update or delete on public.agent_roles for each row execute function public.audit_trigger();
create trigger agent_roles_touch before update on public.agent_roles for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- AI provider + model registry
-- ---------------------------------------------------------------------
create table public.ai_providers (
  key            text primary key,
  name           text not null,
  base_url       text not null,                   -- OpenAI-compatible chat completions base
  api_key_env    text not null,                   -- NAME of the env var holding the key (never the key)
  enabled        boolean not null default true,
  priority       integer not null default 100,     -- lower = preferred
  free_tier      boolean not null default true,
  data_policy    text,                             -- e.g. "free tier prompts may be used for training"
  notes          text,
  updated_at     timestamptz not null default now()
);
create trigger ai_providers_audit after insert or update or delete on public.ai_providers for each row execute function public.audit_trigger();

create table public.ai_models (
  id                 uuid primary key default gen_random_uuid(),
  provider_key       text not null references public.ai_providers(key) on update cascade,
  model              text not null,
  display_name       text,
  tier               text not null check (tier in ('fast','standard','strong')),
  capabilities       text[] not null default '{chat,json}',
  context_window     integer,
  max_output_tokens  integer,
  rpm_limit          integer,
  rpd_limit          integer,
  cost_in_micros_per_mtok  bigint not null default 0,  -- 0 on free tiers; still tracked
  cost_out_micros_per_mtok bigint not null default 0,
  enabled            boolean not null default true,
  cooldown_until     timestamptz,
  consecutive_failures integer not null default 0,
  last_error         text,
  last_success_at    timestamptz,
  quality_score      numeric(5,2),                  -- updated from QA outcomes
  unique (provider_key, model)
);

create table public.ai_calls (
  id                 bigint generated always as identity primary key,
  at                 timestamptz not null default now(),
  task_id            uuid,
  role_key           text,
  provider_key       text,
  model              text,
  status             text not null check (status in ('ok','rate_limited','error','invalid_output','timeout')),
  prompt_tokens      integer not null default 0,
  completion_tokens  integer not null default 0,
  latency_ms         integer,
  cost_micros        bigint not null default 0,
  error              text
);
create index ai_calls_at_idx on public.ai_calls (at desc);
create index ai_calls_model_idx on public.ai_calls (provider_key, model, at desc);
create index ai_calls_task_idx on public.ai_calls (task_id);

-- ---------------------------------------------------------------------
-- Tool registry
-- ---------------------------------------------------------------------
create table public.tools (
  key             text primary key,
  name            text not null,
  description     text not null,
  capabilities    text[] not null default '{}',
  allowed_roles   text[] not null default '{}',
  auth            text not null default 'none',      -- none | env:NAME | github_token
  cost_model      text not null default 'free',
  usage_limits    text,
  security_class  text not null check (security_class in ('read_internal','read_external','write_internal','write_external','financial','code_exec')),
  requires_approval boolean not null default false,
  enabled         boolean not null default true,
  health          text not null default 'unknown' check (health in ('unknown','healthy','degraded','down')),
  last_check_at   timestamptz,
  last_error      text,
  failure_policy  text not null default 'retry 3x with backoff, then fail task',
  tos_notes       text
);
create trigger tools_audit after insert or update or delete on public.tools for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------
-- Approvals (backend-enforced human gate)
-- ---------------------------------------------------------------------
create table public.approvals (
  id                        uuid primary key default gen_random_uuid(),
  action_type               text not null,     -- e.g. project.create, message.send, settings.change, payment.confirm
  title                     text not null,
  requested_by              text not null,     -- role key / system
  task_id                   uuid,
  entity_type               text,
  entity_id                 text,
  reason                    text not null,
  evidence                  jsonb not null default '[]'::jsonb,
  expected_benefit          text,
  risk                      text,
  risk_level                text not null default 'medium' check (risk_level in ('low','medium','high','critical')),
  cost_minor                bigint not null default 0,
  currency                  text not null default 'USD',
  if_approved               text not null,
  if_rejected               text not null,
  payload                   jsonb not null default '{}'::jsonb,
  status                    text not null default 'pending' check (status in ('pending','approved','rejected','expired','executed','failed')),
  idempotency_key           text unique,
  decided_by                text,
  decided_at                timestamptz,
  decision_note             text,
  expires_at                timestamptz not null default now() + interval '14 days',
  executed_at               timestamptz,
  execution_result          jsonb,
  created_at                timestamptz not null default now()
);
create index approvals_status_idx on public.approvals (status, created_at desc);
create trigger approvals_audit after insert or update on public.approvals for each row execute function public.audit_trigger();
create trigger approvals_transition before update on public.approvals for each row execute function public.enforce_transition('approval');

-- ---------------------------------------------------------------------
-- Task queue
-- ---------------------------------------------------------------------
create table public.tasks (
  id                uuid primary key default gen_random_uuid(),
  type              text not null,
  role_key          text references public.agent_roles(key),
  status            text not null default 'pending' check (status in
                     ('pending','blocked','awaiting_approval','running','succeeded','retry_wait','failed','dead','cancelled')),
  priority          integer not null default 50 check (priority between 0 and 100),   -- higher runs first
  title             text,
  entity_type       text,
  entity_id         text,
  input             jsonb not null default '{}'::jsonb,
  output            jsonb,
  error             text,
  idempotency_key   text not null unique,
  attempts          integer not null default 0,
  max_attempts      integer not null default 3 check (max_attempts between 1 and 10),
  run_after         timestamptz not null default now(),
  deadline_at       timestamptz,
  timeout_seconds   integer not null default 180 check (timeout_seconds between 5 and 3600),
  lease_owner       text,
  lease_expires_at  timestamptz,
  approval_id       uuid references public.approvals(id),
  parent_task_id    uuid references public.tasks(id),
  correlation_id    text,
  progress          integer not null default 0 check (progress between 0 and 100),
  progress_note     text,
  created_by        text not null default 'system',
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz not null default now()
);
create index tasks_claim_idx on public.tasks (priority desc, run_after) where status = 'pending';
create index tasks_lease_idx on public.tasks (lease_expires_at) where status = 'running';
create index tasks_entity_idx on public.tasks (entity_type, entity_id);
create index tasks_status_idx on public.tasks (status, updated_at desc);
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();

create table public.task_dependencies (
  task_id        uuid not null references public.tasks(id) on delete cascade,
  depends_on_id  uuid not null references public.tasks(id) on delete cascade,
  primary key (task_id, depends_on_id),
  check (task_id <> depends_on_id)
);

create table public.task_runs (
  id           bigint generated always as identity primary key,
  task_id      uuid not null references public.tasks(id) on delete cascade,
  attempt      integer not null,
  worker_id    text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','succeeded','failed','lease_expired','retry')),
  error        text,
  duration_ms  integer
);
create index task_runs_task_idx on public.task_runs (task_id, attempt);

create table public.worker_heartbeats (
  worker_id        text primary key,
  started_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  status           text not null default 'running' check (status in ('running','finished','crashed')),
  tasks_succeeded  integer not null default 0,
  tasks_failed     integer not null default 0,
  run_url          text,
  note             text
);

create table public.health_checks (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  component  text not null,
  status     text not null check (status in ('healthy','degraded','down')),
  detail     text
);
create index health_checks_idx on public.health_checks (component, at desc);
