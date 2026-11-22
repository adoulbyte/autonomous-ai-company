-- =====================================================================
-- 0003 BUSINESS: sources, evidence, opportunities, CRM, projects,
--                production, QA, communications, finance, metrics
-- =====================================================================

-- ---------------------------------------------------------------------
-- Opportunity sources & evidence
-- ---------------------------------------------------------------------
create table public.sources (
  key                   text primary key,
  name                  text not null,
  kind                  text not null check (kind in ('api','rss','manual','inbound')),
  connector             text not null,             -- worker connector id
  description           text,
  config                jsonb not null default '{}'::jsonb,
  enabled               boolean not null default true,
  interval_minutes      integer not null default 360 check (interval_minutes >= 15),
  max_items_per_run     integer not null default 30 check (max_items_per_run between 1 and 200),
  last_run_at           timestamptz,
  next_run_at           timestamptz not null default now(),
  health                text not null default 'unknown' check (health in ('unknown','healthy','degraded','down')),
  consecutive_failures  integer not null default 0,
  last_error            text,
  items_found_total     integer not null default 0,
  terms_notes           text not null,             -- why this source is legitimate to use
  created_at            timestamptz not null default now()
);
create trigger sources_audit after insert or update or delete on public.sources for each row execute function public.audit_trigger();

create table public.evidence (
  id            uuid primary key default gen_random_uuid(),
  source_key    text references public.sources(key),
  url           text not null,
  fetched_at    timestamptz not null default now(),
  content_hash  text not null,
  title         text,
  excerpt       text not null,                     -- the verbatim text the opportunity is based on
  raw           jsonb not null default '{}'::jsonb,
  unique (url, content_hash)
);

-- ---------------------------------------------------------------------
-- Opportunities
-- ---------------------------------------------------------------------
create table public.opportunities (
  id                  uuid primary key default gen_random_uuid(),
  source_key          text not null references public.sources(key),
  external_id         text not null,
  fingerprint         text not null unique,
  title               text not null,
  description         text not null,
  url                 text not null,
  status              text not null default 'discovered' check (status in
                       ('discovered','analyzing','scored','shortlisted','monitoring','rejected','pursuing','won','lost','expired')),
  business_model      text check (business_model in ('freelance','ai_services','digital_product','affiliate','partnership','bounty','retainer','other')),
  revenue_mechanism   text,
  buyer_name          text,
  buyer_contact       text,                         -- only publicly published business contact
  posted_at           timestamptz,
  discovered_at       timestamptz not null default now(),
  last_verified_at    timestamptz,
  skills              text[] not null default '{}',
  est_revenue_minor   bigint check (est_revenue_minor >= 0),
  est_cost_minor      bigint check (est_cost_minor >= 0),
  currency            text not null default 'USD' check (currency ~ '^[A-Z]{3,5}$'),
  est_hours           numeric(8,2) check (est_hours >= 0),
  difficulty          numeric(4,3) check (difficulty between 0 and 1),
  competition         numeric(4,3) check (competition between 0 and 1),
  risk                numeric(4,3) check (risk between 0 and 1),
  p_win               numeric(4,3) check (p_win between 0 and 1),
  p_paid              numeric(4,3) check (p_paid between 0 and 1),
  confidence          numeric(4,3) check (confidence between 0 and 1),
  evidence_quality    numeric(4,3) check (evidence_quality between 0 and 1),
  strategic_value     numeric(4,3) check (strategic_value between 0 and 1),
  skill_fit           numeric(4,3) check (skill_fit between 0 and 1),
  risk_flags          text[] not null default '{}',
  analysis            jsonb,                        -- structured analyst output (+ rationale)
  score               numeric(6,2),
  score_breakdown     jsonb,
  score_version       integer,
  decision            text check (decision in ('pursue','monitor','reject','investigate')),
  decision_reasons    text[] not null default '{}',
  deleted_at          timestamptz,
  updated_at          timestamptz not null default now(),
  unique (source_key, external_id)
);
create index opportunities_status_idx on public.opportunities (status, score desc nulls last);
create index opportunities_title_trgm on public.opportunities using gin (title gin_trgm_ops);
create trigger opportunities_touch before update on public.opportunities for each row execute function public.touch_updated_at();
create trigger opportunities_transition before update on public.opportunities for each row execute function public.enforce_transition('opportunity');
create trigger opportunities_audit after update or delete on public.opportunities for each row execute function public.audit_trigger();

create table public.opportunity_evidence (
  opportunity_id  uuid not null references public.opportunities(id) on delete cascade,
  evidence_id     uuid not null references public.evidence(id),
  primary key (opportunity_id, evidence_id)
);

-- An opportunity can never progress past 'discovered' without evidence.
create or replace function public.require_evidence() returns trigger language plpgsql as $$
begin
  if new.status <> 'discovered' and not exists (select 1 from public.opportunity_evidence e where e.opportunity_id = new.id) then
    raise exception 'opportunity % has no evidence; cannot move to %', new.id, new.status using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger opportunities_require_evidence before update on public.opportunities for each row execute function public.require_evidence();

create table public.opportunity_decisions (
  id               bigint generated always as identity primary key,
  opportunity_id   uuid not null references public.opportunities(id) on delete cascade,
  decision         text not null check (decision in ('pursue','monitor','reject','investigate')),
  score            numeric(6,2),
  score_breakdown  jsonb,
  reasons          text[] not null default '{}',
  weights_version  integer,
  decided_by       text not null,
  at               timestamptz not null default now()
);
create index opportunity_decisions_idx on public.opportunity_decisions (opportunity_id, at desc);

-- ---------------------------------------------------------------------
-- CRM
-- ---------------------------------------------------------------------
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  domain      text,
  website     text,
  industry    text,
  country     text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index companies_domain_uq on public.companies (lower(domain)) where domain is not null and deleted_at is null;
create unique index companies_name_uq on public.companies (lower(name)) where domain is null and deleted_at is null;
create trigger companies_audit after insert or update or delete on public.companies for each row execute function public.audit_trigger();
create trigger companies_touch before update on public.companies for each row execute function public.touch_updated_at();

create table public.contacts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references public.companies(id),
  name            text,
  email           text,
  handle          text,                      -- e.g. HN username / GitHub login (public)
  role            text,
  source          text,
  lawful_basis    text not null default 'public_request' check (lawful_basis in ('public_request','inbound','consent','legitimate_interest','existing_client')),
  do_not_contact  boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
create unique index contacts_email_uq on public.contacts (lower(email)) where email is not null and deleted_at is null;
create unique index contacts_handle_uq on public.contacts (lower(source), lower(handle)) where handle is not null and deleted_at is null;
create trigger contacts_audit after insert or update or delete on public.contacts for each row execute function public.audit_trigger();
create trigger contacts_touch before update on public.contacts for each row execute function public.touch_updated_at();

create table public.leads (
  id                 uuid primary key default gen_random_uuid(),
  opportunity_id     uuid unique references public.opportunities(id),
  company_id         uuid references public.companies(id),
  contact_id         uuid references public.contacts(id),
  title              text not null,
  source             text not null,
  stage              text not null default 'new',
  status             text generated always as (stage) stored,
  score              numeric(6,2),
  value_minor        bigint check (value_minor >= 0),
  currency           text not null default 'USD',
  next_follow_up_at  timestamptz,
  follow_ups_sent    integer not null default 0,
  outcome            text check (outcome in ('won','lost','disqualified')),
  lost_reason        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (stage in ('new','qualified','contacted','engaged','proposal','negotiating','won','lost','disqualified'))
);
create index leads_stage_idx on public.leads (stage, updated_at desc);
create trigger leads_touch before update on public.leads for each row execute function public.touch_updated_at();
create trigger leads_audit after insert or update or delete on public.leads for each row execute function public.audit_trigger();

-- leads use "stage"; dedicated transition trigger
create or replace function public.enforce_lead_stage() returns trigger language plpgsql as $$
begin
  if new.stage is distinct from old.stage then
    if not exists (select 1 from public.state_transitions t where t.entity = 'lead' and t.from_state = old.stage and t.to_state = new.stage) then
      raise exception 'invalid lead transition: % -> %', old.stage, new.stage using errcode = 'P0001';
    end if;
    insert into public.lead_stage_history(lead_id, from_stage, to_stage, actor) values (new.id, old.stage, new.stage, public.current_actor());
    perform public.log_event('lead', new.id::text, 'stage_changed', format('Lead "%s": %s → %s', new.title, old.stage, new.stage),
      jsonb_build_object('from', old.stage, 'to', new.stage));
    if new.stage in ('won','lost','disqualified') then new.outcome := new.stage; end if;
  end if;
  return new;
end $$;

create table public.lead_stage_history (
  id          bigint generated always as identity primary key,
  lead_id     uuid not null references public.leads(id) on delete cascade,
  from_stage  text,
  to_stage    text not null,
  actor       text not null,
  at          timestamptz not null default now()
);
create trigger leads_stage before update on public.leads for each row execute function public.enforce_lead_stage();

create table public.notes (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,
  entity_id    uuid not null,
  body         text not null check (length(body) between 1 and 20000),
  created_by   text not null default public.current_actor(),
  created_at   timestamptz not null default now()
);
create index notes_entity_idx on public.notes (entity_type, entity_id, created_at desc);

create table public.reminders (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,
  entity_id    uuid not null,
  title        text not null,
  due_at       timestamptz not null,
  done_at      timestamptz,
  created_by   text not null default public.current_actor(),
  created_at   timestamptz not null default now()
);
create index reminders_due_idx on public.reminders (due_at) where done_at is null;

create table public.clients (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null unique references public.companies(id),
  status       text not null default 'active' check (status in ('active','inactive','former')),
  since        timestamptz not null default now(),
  notes        text
);
create trigger clients_audit after insert or update or delete on public.clients for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------
-- Communications
-- ---------------------------------------------------------------------
create table public.conversations (
  id                  uuid primary key default gen_random_uuid(),
  lead_id             uuid references public.leads(id),
  project_id          uuid,
  company_id          uuid references public.companies(id),
  contact_id          uuid references public.contacts(id),
  channel             text not null check (channel in ('email','platform','other')),
  subject             text not null,
  external_thread_id  text,
  status              text not null default 'open' check (status in ('open','waiting','closed')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.conversations(id) on delete cascade,
  direction         text not null check (direction in ('inbound','outbound')),
  status            text not null check (status in ('received','draft','awaiting_approval','approved','sent','rejected','failed')),
  from_addr         text,
  to_addr           text,
  subject           text,
  body              text not null,
  template_key      text,
  classification    jsonb,
  priority          text check (priority in ('low','normal','high','urgent')),
  injection_suspected boolean not null default false,
  generated_by_task uuid references public.tasks(id),
  approval_id       uuid references public.approvals(id),
  idempotency_key   text unique,
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index messages_conv_idx on public.messages (conversation_id, created_at);
create index messages_status_idx on public.messages (status, created_at desc);
create trigger messages_touch before update on public.messages for each row execute function public.touch_updated_at();
create trigger messages_transition before update on public.messages for each row execute function public.enforce_transition('message');
create trigger messages_audit after insert or update on public.messages for each row execute function public.audit_trigger();

-- An outbound message can only become 'sent' or 'approved' through an approved approval.
create or replace function public.messages_require_approval() returns trigger language plpgsql as $$
begin
  if new.direction = 'outbound' and new.status in ('approved','sent') and old.status is distinct from new.status then
    if new.approval_id is null or not exists (select 1 from public.approvals a where a.id = new.approval_id and a.status in ('approved','executed')) then
      raise exception 'outbound message % requires an approved approval before %', new.id, new.status using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger messages_approval_gate before update on public.messages for each row execute function public.messages_require_approval();

create table public.message_templates (
  key          text primary key,
  name         text not null,
  purpose      text not null,
  subject      text not null,
  body         text not null,
  approved     boolean not null default false,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Projects & production
-- ---------------------------------------------------------------------
create table public.projects (
  id               uuid primary key default gen_random_uuid(),
  opportunity_id   uuid references public.opportunities(id),
  lead_id          uuid references public.leads(id),
  client_id        uuid references public.clients(id),
  name             text not null,
  status           text not null default 'planning',
  summary          text,
  scope            text not null,
  out_of_scope     text,
  budget_minor     bigint check (budget_minor >= 0),
  currency         text not null default 'USD',
  ai_call_budget   integer not null default 60 check (ai_call_budget >= 0),
  max_qa_cycles    integer not null default 3 check (max_qa_cycles between 1 and 10),
  deadline_at      timestamptz,
  plan             jsonb,
  created_by       text not null default public.current_actor(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  delivered_at     timestamptz,
  accepted_at      timestamptz,
  check (status in ('planning','in_progress','in_qa','ready_for_delivery','delivered','revision','accepted','closed','on_hold','cancelled'))
);
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();
create trigger projects_transition before update on public.projects for each row execute function public.enforce_transition('project');
create trigger projects_audit after insert or update or delete on public.projects for each row execute function public.audit_trigger();
alter table public.conversations add constraint conversations_project_fk foreign key (project_id) references public.projects(id);

create table public.requirements (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects(id) on delete cascade,
  position              integer not null,
  description           text not null,
  acceptance_criteria   text[] not null check (cardinality(acceptance_criteria) >= 1),
  verification_method   text not null default 'qa_review' check (verification_method in ('qa_review','automated_check','client_confirmation','owner_review')),
  status                text not null default 'open' check (status in ('open','met','failed','waived')),
  unique (project_id, position)
);

create table public.milestones (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  name          text not null,
  due_at        timestamptz,
  amount_minor  bigint not null default 0 check (amount_minor >= 0),
  status        text not null default 'pending' check (status in ('pending','in_progress','done','invoiced','paid')),
  position      integer not null default 0
);

create table public.deliverables (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  requirement_id     uuid references public.requirements(id),
  work_item          text not null,                       -- stable key from the plan
  version            integer not null default 1 check (version >= 1),
  title              text not null,
  format             text not null default 'markdown' check (format in ('markdown','code','json','text','html','csv')),
  content            text not null,
  content_hash       text not null,
  storage_path       text,
  status             text not null default 'in_qa',
  produced_by_role   text not null,
  produced_by_task   uuid references public.tasks(id),
  producer_notes     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (project_id, work_item, version),
  check (status in ('in_qa','changes_requested','approved','superseded','ready_for_delivery','delivered','accepted','rejected'))
);
create trigger deliverables_touch before update on public.deliverables for each row execute function public.touch_updated_at();
create trigger deliverables_transition before update on public.deliverables for each row execute function public.enforce_transition('deliverable');
create trigger deliverables_audit after insert or update on public.deliverables for each row execute function public.audit_trigger();

create table public.qa_reviews (
  id                uuid primary key default gen_random_uuid(),
  deliverable_id    uuid not null references public.deliverables(id) on delete cascade,
  reviewer_role     text not null,
  reviewer_task     uuid references public.tasks(id),
  verdict           text not null check (verdict in ('pass','fail')),
  criteria_results  jsonb not null,                       -- [{criterion, met, evidence}]
  issues            text[] not null default '{}',
  summary           text not null,
  model             text,
  created_at        timestamptz not null default now()
);
create index qa_reviews_deliv_idx on public.qa_reviews (deliverable_id, created_at desc);

-- QA independence: the producing role/task may never review its own deliverable.
create or replace function public.qa_independence() returns trigger language plpgsql as $$
declare d record;
begin
  select produced_by_role, produced_by_task into d from public.deliverables where id = new.deliverable_id;
  if d.produced_by_role = new.reviewer_role or (new.reviewer_task is not null and d.produced_by_task = new.reviewer_task) then
    raise exception 'QA independence violated: % cannot review its own deliverable', new.reviewer_role using errcode = '42501';
  end if;
  return new;
end $$;
create trigger qa_reviews_independence before insert on public.qa_reviews for each row execute function public.qa_independence();

-- A deliverable may only become 'approved' if the latest QA review passed.
create or replace function public.deliverable_requires_qa() returns trigger language plpgsql as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if coalesce((select verdict from public.qa_reviews where deliverable_id = new.id order by created_at desc limit 1), 'none') <> 'pass' then
      raise exception 'deliverable % cannot be approved without a passing QA review', new.id using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger deliverables_qa_gate before update on public.deliverables for each row execute function public.deliverable_requires_qa();

-- ---------------------------------------------------------------------
-- Finance (integer minor units + explicit currency)
-- ---------------------------------------------------------------------
create table public.invoices (
  id             uuid primary key default gen_random_uuid(),
  number         text not null unique,
  project_id     uuid references public.projects(id),
  client_id      uuid references public.clients(id),
  milestone_id   uuid references public.milestones(id),
  issue_date     date not null default current_date,
  due_date       date not null,
  amount_minor   bigint not null check (amount_minor > 0),
  currency       text not null check (currency ~ '^[A-Z]{3,5}$'),
  status         text not null default 'draft',
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (status in ('draft','issued','partially_paid','paid','overdue','void')),
  check (due_date >= issue_date)
);
create sequence public.invoice_number_seq;
create trigger invoices_touch before update on public.invoices for each row execute function public.touch_updated_at();
create trigger invoices_transition before update on public.invoices for each row execute function public.enforce_transition('invoice');
create trigger invoices_audit after insert or update or delete on public.invoices for each row execute function public.audit_trigger();

create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid references public.invoices(id),
  amount_minor    bigint not null check (amount_minor > 0),
  currency        text not null check (currency ~ '^[A-Z]{3,5}$'),
  method          text not null check (method in ('bank_transfer','card_processor','redotpay','crypto','marketplace','cash','other')),
  external_ref    text,
  status          text not null default 'pending' check (status in ('pending','confirmed','rejected','refunded')),
  evidence_type   text check (evidence_type in ('provider_webhook_verified','provider_api_lookup','statement_line','owner_confirmed')),
  evidence_ref    text,
  evidence_note   text,
  received_at     timestamptz,
  confirmed_by    text,
  confirmed_at    timestamptz,
  created_at      timestamptz not null default now(),
  -- A payment can NEVER be confirmed without verifiable evidence and a confirmer.
  check (status <> 'confirmed' or (evidence_type is not null and evidence_ref is not null and length(evidence_ref) > 2 and confirmed_by is not null and confirmed_at is not null)),
  unique (method, external_ref)
);
create trigger payments_audit after insert or update or delete on public.payments for each row execute function public.audit_trigger();

-- Agents can never confirm payments: only the owner (or a verified provider integration).
create or replace function public.payments_confirm_guard() returns trigger language plpgsql as $$
begin
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status is distinct from 'confirmed') then
    if public.current_actor() like 'agent:%' then
      raise exception 'agents cannot confirm payments' using errcode = '42501';
    end if;
    if new.evidence_type = 'owner_confirmed' and public.current_actor() not like 'owner:%' then
      raise exception 'owner_confirmed evidence requires the owner' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger payments_guard before insert or update on public.payments for each row execute function public.payments_confirm_guard();

create table public.expenses (
  id             uuid primary key default gen_random_uuid(),
  category       text not null check (category in ('ai','infrastructure','tools','marketplace_fees','payment_fees','marketing','contractor','other')),
  description    text not null,
  amount_minor   bigint not null check (amount_minor >= 0),
  currency       text not null check (currency ~ '^[A-Z]{3,5}$'),
  incurred_on    date not null default current_date,
  project_id     uuid references public.projects(id),
  source         text not null default 'manual' check (source in ('manual','metered','provider_invoice')),
  created_at     timestamptz not null default now()
);
create trigger expenses_audit after insert or update or delete on public.expenses for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------
-- Metrics & learning
-- ---------------------------------------------------------------------
create table public.metric_snapshots (
  day         date not null,
  metric      text not null,
  dimension   text not null default 'all',
  value       numeric not null,
  computed_at timestamptz not null default now(),
  primary key (day, metric, dimension)
);

create table public.strategy_reviews (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  period_start  date not null,
  period_end    date not null,
  metrics       jsonb not null,
  summary       text not null,
  recommendations jsonb not null default '[]'::jsonb,
  proposed_settings jsonb,
  approval_id   uuid references public.approvals(id),
  task_id       uuid references public.tasks(id)
);
