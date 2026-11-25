-- Monthly subscriptions offered to delivered clients (recurring revenue).
-- Each month is a small project that goes through the usual circuit: production → double QA → invoice validated by the
-- owner → payment confirmed by the owner → automatic delivery. No payment, no next month.
create table if not exists public.subscriptions (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references public.leads(id) on delete cascade,
  plan_key       text not null,
  price_minor    bigint not null check (price_minor >= 0),
  currency       text not null default 'EUR',
  status         text not null default 'active' check (status in ('active','paused','cancelled')),
  started_at     timestamptz not null default now(),
  next_cycle_at  timestamptz not null default now(),
  cycles         integer not null default 0,
  paused_reason  text,
  cancelled_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (lead_id, plan_key)
);
create trigger subscriptions_touch before update on public.subscriptions for each row execute function public.touch_updated_at();
alter table public.subscriptions enable row level security;
create policy owner_read on public.subscriptions for select to authenticated using (public.is_owner());
grant select on public.subscriptions to authenticated;

alter table public.projects add column if not exists subscription_id uuid references public.subscriptions(id);
alter table public.projects add column if not exists cycle integer;

-- Social-media visuals are delivered as images (JPEG) rendered from a designed template.
alter table public.deliverables drop constraint if exists deliverables_format_check;
alter table public.deliverables add constraint deliverables_format_check
  check (format in ('markdown','code','json','text','html','csv','pdf','spreadsheet','svg','social'));

insert into public.settings(key, value, description) values
 ('pricing.subscriptions', '{
   "social_monthly": {"label": {"fr": "Pack visuels mensuel (4 visuels par mois)", "en": "Monthly visuals pack (4 visuals a month)", "nl": "Maandelijks visualpakket (4 visuals per maand)", "pt": "Pack mensal de visuais (4 visuais por mês)"},
                      "price_minor": 1900, "posts": 4, "offer_after_days": 3}
 }', 'Monthly subscriptions offered to delivered clients (editable).')
on conflict (key) do nothing;
