-- =====================================================================
-- 0022 CONTINUOUS B2B PROSPECTING (local businesses that publish a professional email)
-- =====================================================================
alter table public.sources drop constraint if exists sources_kind_check;
alter table public.sources add constraint sources_kind_check check (kind in ('api','rss','manual','inbound','directory'));

insert into public.sources(key, name, kind, connector, description, config, enabled, interval_minutes, max_items_per_run, terms_notes) values
 ('osm_businesses', 'Entreprises locales (OpenStreetMap)', 'directory', 'osm_businesses',
  'Local businesses (shops, craftsmen, restaurants, offices, health, tourism...) that publish a professional email address. Without a website: offer a showcase site; with a website: ad scripts, PDF/Excel documents, simple visuals. One city per run, rotating across France.',
  '{"cursor": 0, "radius_m": 6000}', true, 30, 40,
  'OpenStreetMap open data (ODbL) via the public Overpass API, one small query per run. Only business addresses the business published; chains and public bodies excluded. B2B prospecting on legitimate interest: relevant offer, sender identified, one-click opt-out honoured permanently.')
on conflict (key) do nothing;

insert into public.settings(key, value, description) values
 ('prospecting.policy', jsonb_build_object('start_per_day', 20, 'step_per_day', 10, 'max_per_day', 120, 'started_at', now()),
  'First contacts per day: starts low and grows every day (mailbox warm-up), never above the maximum.')
on conflict (key) do nothing;

-- Follow up until a reply, within reason: 3 follow-ups, spaced out, then stop (beyond that it is spam and gets the mailbox blocked).
update public.settings set value = value || '{"max_followups": 3, "followup_after_days": 4}'::jsonb, version = version + 1, updated_by = 'migration:0022'
where key = 'comms.policy';

create or replace function public.pursue_opportunity(p_opportunity_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare o public.opportunities; v_company uuid; v_contact uuid; v_lead uuid; v_handle text; v_kind text;
begin
  select * into o from public.opportunities where id = p_opportunity_id for update;
  if o.id is null then raise exception 'opportunity not found' using errcode = 'P0002'; end if;
  select id into v_lead from public.leads where opportunity_id = o.id;
  if v_lead is not null then return v_lead; end if;
  select kind into v_kind from public.sources where key = o.source_key;
  if o.status in ('scored','monitoring','rejected') then update public.opportunities set status = 'shortlisted' where id = o.id;
  elsif o.status <> 'shortlisted' then raise exception 'opportunity must be scored first (status %)', o.status using errcode = 'P0001'; end if;
  if o.buyer_name is not null then
    select id into v_company from public.companies where lower(name) = lower(o.buyer_name) and deleted_at is null limit 1;
    if v_company is null then
      insert into public.companies(name, notes) values (o.buyer_name, 'Created from opportunity ' || o.url) returning id into v_company;
    end if;
  end if;
  if o.buyer_contact is not null then
    if o.buyer_contact ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      select id into v_contact from public.contacts where lower(email) = lower(o.buyer_contact) and deleted_at is null;
      if v_contact is null then
        insert into public.contacts(company_id, name, email, source, lawful_basis) values (v_company, o.buyer_name, o.buyer_contact, o.source_key, case when v_kind = 'directory' then 'legitimate_interest' else 'public_request' end) returning id into v_contact;
      end if;
    else
      v_handle := o.buyer_contact;
      select id into v_contact from public.contacts where lower(source) = lower(o.source_key) and lower(handle) = lower(v_handle) and deleted_at is null;
      if v_contact is null then
        insert into public.contacts(company_id, name, handle, source, lawful_basis) values (v_company, o.buyer_name, v_handle, o.source_key, 'public_request') returning id into v_contact;
      end if;
    end if;
  end if;
  insert into public.leads(opportunity_id, company_id, contact_id, title, source, score, value_minor, currency, stage)
  values (o.id, v_company, v_contact, o.title, o.source_key, o.score, o.est_revenue_minor, o.currency, 'new') returning id into v_lead;
  update public.leads set stage = 'qualified' where id = v_lead;
  update public.opportunities set status = 'pursuing' where id = o.id;
  if v_kind = 'directory' and coalesce(public.setting('business.mode')->>'mode', 'paid') = 'free_pilot' then
    -- Proactive proposal in the launch program: no price to compute, write the first email directly.
    perform public.enqueue_task('lead.draft_outreach', 'outreach:' || v_lead, jsonb_build_object('lead_id', v_lead), 'sales_agent',
      'lead', v_lead::text, 64, now(), 3, 300, '{}', 'Prospecting email: ' || left(o.title, 80));
  else
    perform public.enqueue_task('pricing.quote', 'quote:' || v_lead, jsonb_build_object('lead_id', v_lead), 'pricing_analyst',
      'lead', v_lead::text, 62, now(), 3, 200, '{}', 'Market pricing: ' || left(o.title, 80));
  end if;
  perform public.log_event('lead', v_lead::text, 'lead_created', format('Pursuing "%s"', o.title));
  return v_lead;
end $$;
revoke execute on function public.pursue_opportunity(uuid) from public, anon, authenticated;
