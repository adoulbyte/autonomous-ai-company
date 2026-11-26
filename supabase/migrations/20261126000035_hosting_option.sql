-- Option "site en ligne": the website is published by us (Cloudflare Pages, free) and connected to a domain name bought
-- on demand, in the client's name, once the client has paid. 89 EUR the first year, then 49 EUR a year.
update public.settings set value = jsonb_set(value, '{items,website_online}', '{
  "label": {"fr": "Site en ligne + nom de domaine (puis 49 €/an)", "en": "Website online + domain name (then 49 €/year)",
            "nl": "Website online + domeinnaam (daarna 49 €/jaar)", "pt": "Site online + nome de domínio (depois 49 €/ano)"},
  "price_minor": 8900, "days": 4}'::jsonb, true), version = version + 1, updated_by = 'migration:0035'
where key = 'pricing.catalog';

insert into public.settings(key, value, description) values
 ('hosting.plan', '{"renewal_minor": 4900, "currency": "EUR", "remind_days_before": 30}', 'Hosting + domain renewal for the "website online" option (yearly).')
on conflict (key) do nothing;

create table if not exists public.hosted_sites (
  id                   uuid primary key default gen_random_uuid(),
  lead_id              uuid not null references public.leads(id) on delete cascade unique,
  project_id           uuid references public.projects(id),
  pages_project        text not null,
  url                  text not null,
  domain               text,
  domain_status        text not null default 'none' check (domain_status in ('none','to_buy','connected','declined')),
  status               text not null default 'online' check (status in ('online','suspended','closed')),
  online_at            timestamptz not null default now(),
  renews_at            timestamptz not null default (now() + interval '1 year'),
  renewal_requested_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger hosted_sites_touch before update on public.hosted_sites for each row execute function public.touch_updated_at();
alter table public.hosted_sites enable row level security;
create policy owner_read on public.hosted_sites for select to authenticated using (public.is_owner());
grant select on public.hosted_sites to authenticated;
