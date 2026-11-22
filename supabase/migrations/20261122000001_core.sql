-- =====================================================================
-- 0001 CORE: extensions, owner, settings, audit log, events, transitions
-- =====================================================================
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------
-- Owner (single-owner system; no multi-tenancy by design)
-- ---------------------------------------------------------------------
create table public.app_owner (
  singleton   boolean primary key default true check (singleton),
  user_id     uuid not null unique,
  email       text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Settings (business rules, weights, limits). Every change is audited.
-- ---------------------------------------------------------------------
create table public.settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  critical     boolean not null default false, -- critical rules: agents may only propose changes via approvals
  version      integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   text not null default 'system'
);

create or replace function public.setting(p_key text) returns jsonb
language sql stable as $$ select value from public.settings where key = p_key $$;

-- ---------------------------------------------------------------------
-- Owner check used by every RLS policy and owner-only RPC.
-- Optional MFA enforcement (Supabase aal2) controlled by settings.
-- ---------------------------------------------------------------------
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_owner o where o.user_id = auth.uid())
     and (
       coalesce((select (value)::text::boolean from public.settings where key = 'security.require_mfa'), false) = false
       or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     )
$$;

-- ---------------------------------------------------------------------
-- Audit log (append-only) and event log (append-only, feeds the UI)
-- ---------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_type   text not null,               -- owner | agent | system | worker
  actor_id     text,
  action       text not null,               -- insert | update | delete | rpc name
  entity_type  text not null,
  entity_id    text,
  before       jsonb,
  after        jsonb
);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id, at desc);
create index audit_log_at_idx on public.audit_log (at desc);

create table public.events (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  actor_type     text not null default 'system',
  actor_id       text,
  entity_type    text not null,
  entity_id      text,
  event_type     text not null,
  severity       text not null default 'info' check (severity in ('debug','info','warning','error','critical')),
  message        text,
  payload        jsonb not null default '{}'::jsonb,
  correlation_id text
);
create index events_occurred_idx on public.events (occurred_at desc);
create index events_entity_idx on public.events (entity_type, entity_id, occurred_at desc);
create index events_severity_idx on public.events (severity, occurred_at desc) where severity in ('warning','error','critical');

-- Current actor, set per transaction by the worker (`set local app.actor = 'agent:qa'`)
-- or derived from the JWT for owner calls.
create or replace function public.current_actor() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('app.actor', true), ''),
    case when auth.uid() is not null then 'owner:' || auth.uid()::text else 'system' end)
$$;

create or replace function public.log_event(
  p_entity_type text, p_entity_id text, p_event_type text,
  p_message text default null, p_payload jsonb default '{}'::jsonb, p_severity text default 'info')
returns void language plpgsql security definer set search_path = public as $$
declare a text := public.current_actor();
begin
  insert into public.events(actor_type, actor_id, entity_type, entity_id, event_type, message, payload, severity)
  values (split_part(a, ':', 1), nullif(split_part(a, ':', 2), ''), p_entity_type, p_entity_id, p_event_type, p_message, coalesce(p_payload, '{}'::jsonb), p_severity);
end $$;

-- Generic audit trigger: records full before/after rows.
create or replace function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare a text := public.current_actor(); rid text;
begin
  if tg_op = 'DELETE' then rid := (to_jsonb(old) ->> 'id'); else rid := coalesce(to_jsonb(new) ->> 'id', to_jsonb(new) ->> 'key'); end if;
  insert into public.audit_log(actor_type, actor_id, action, entity_type, entity_id, before, after)
  values (split_part(a, ':', 1), nullif(split_part(a, ':', 2), ''), lower(tg_op), tg_table_name, rid,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- Append-only protection for logs (even table owners must not rewrite history casually).
create or replace function public.forbid_mutation() returns trigger language plpgsql as $$
begin
  if current_setting('app.allow_log_retention', true) = 'on' and tg_op = 'DELETE' then return old; end if;
  raise exception 'append-only table %: % not allowed', tg_table_name, tg_op using errcode = '42501';
end $$;
create trigger audit_log_append_only before update or delete on public.audit_log for each row execute function public.forbid_mutation();
create trigger events_append_only before update or delete on public.events for each row execute function public.forbid_mutation();

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger settings_audit after insert or update or delete on public.settings for each row execute function public.audit_trigger();
create trigger settings_touch before update on public.settings for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- State machines: allowed transitions per entity, enforced by trigger.
-- ---------------------------------------------------------------------
create table public.state_transitions (
  entity      text not null,
  from_state  text not null,
  to_state    text not null,
  primary key (entity, from_state, to_state)
);

create or replace function public.enforce_transition() returns trigger
language plpgsql as $$
declare ent text := tg_argv[0];
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from public.state_transitions t
                   where t.entity = ent and t.from_state = old.status and t.to_state = new.status) then
      raise exception 'invalid % transition: % -> %', ent, old.status, new.status using errcode = 'P0001';
    end if;
    perform public.log_event(ent, new.id::text, 'status_changed',
      format('%s %s: %s → %s', ent, left(new.id::text, 8), old.status, new.status),
      jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end $$;
