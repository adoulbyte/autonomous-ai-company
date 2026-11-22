-- =====================================================================
-- 0014 PAYMENT-FIRST DELIVERY, DUAL QA, MARKET PRICING, POLICY AUTONOMY
-- =====================================================================

-- ---- Settings ------------------------------------------------------
insert into public.settings(key, value, description, critical) values
  ('qa.policy', '{"reviewers_required": 2, "max_qa_cycles": 4}',
   'Independent QA reviews that must ALL pass before a deliverable is approved.', true),
  ('pricing.policy', '{"min_price_minor": 10000, "min_hourly_minor": 3000, "currency": "USD", "never_exceed_stated_budget": true}',
   'Floors for market-based pricing. The Pricing Analyst studies the market; these only prevent selling below cost.', true)
on conflict (key) do nothing;

update public.settings set value = value
  || '{"opportunity.pursue": "auto", "delivery.send": "approval", "payment.request.send": "approval"}'::jsonb,
  version = version + 1, updated_by = 'migration:0014'
where key = 'autonomy.policy';

alter table public.leads add column if not exists quote jsonb;
alter table public.projects alter column max_qa_cycles set default 4;

-- ---- New agent role: Pricing Analyst --------------------------------
insert into public.agent_roles(key, name, department, objective, supervisor, model_tier, allowed_tools, task_types, permissions, input_schema, output_schema, quality_rules, max_output_tokens, daily_call_budget, retry_max, timeout_seconds, is_ai) values
 ('pricing_analyst','Pricing Analyst','Finance','Study the market for each lead (stated budget, comparable opportunities, typical rates for the skills and scope) and set an evidence-based price above the cost floor.','executive_strategist','standard',
  '{llm,db}','{pricing.quote}','{leads.price}',
  '{"lead_id":"uuid"}','{"price_minor":"int","low":"number","typical":"number","high":"number","rationale":"string"}',
  '{"never exceed a stated client budget","never go below the policy floor","explain the evidence used"}',900,120,3,150,true)
on conflict (key) do nothing;
update public.agent_roles set task_types = array_append(task_types, 'project.deliver') where key = 'project_manager' and not ('project.deliver' = any(task_types));

-- ---- Policy-based auto-approval (worker only, never the browser) ----
-- Approves an approval ONLY if autonomy.policy marks its action type "auto". Audited as policy:auto.
create or replace function public.system_auto_approve(p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare a public.approvals; mode text;
begin
  select * into a from public.approvals where id = p_id for update;
  if a.id is null or a.status <> 'pending' then return false; end if;
  mode := coalesce(public.setting('autonomy.policy') ->> a.action_type, 'approval');
  if mode <> 'auto' then return false; end if;
  perform set_config('app.actor', 'policy:auto', true);
  update public.approvals set status = 'approved', decided_by = 'policy:auto', decided_at = now(),
         decision_note = 'auto-approved by autonomy policy' where id = p_id;
  update public.tasks set status = 'pending' where approval_id = p_id and status = 'awaiting_approval';
  update public.messages set status = 'approved' where approval_id = p_id and status = 'awaiting_approval';
  perform public.log_event('approval', p_id::text, 'approval_auto_granted', 'Auto-approved by policy: ' || a.title);
  return true;
end $$;
revoke execute on function public.system_auto_approve(uuid) from public, anon, authenticated;

-- ---- Pursuit now starts with market pricing, then outreach ----------
create or replace function public.pursue_opportunity(p_opportunity_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare o public.opportunities; v_company uuid; v_contact uuid; v_lead uuid; v_handle text;
begin
  select * into o from public.opportunities where id = p_opportunity_id for update;
  if o.id is null then raise exception 'opportunity not found' using errcode = 'P0002'; end if;
  select id into v_lead from public.leads where opportunity_id = o.id;
  if v_lead is not null then return v_lead; end if;
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
        insert into public.contacts(company_id, name, email, source, lawful_basis) values (v_company, o.buyer_name, o.buyer_contact, o.source_key, 'public_request') returning id into v_contact;
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
  perform public.enqueue_task('pricing.quote', 'quote:' || v_lead, jsonb_build_object('lead_id', v_lead), 'pricing_analyst',
    'lead', v_lead::text, 62, now(), 3, 200, '{}', 'Market pricing: ' || left(o.title, 80));
  perform public.log_event('lead', v_lead::text, 'lead_created', format('Pursuing "%s"', o.title));
  return v_lead;
end $$;
revoke execute on function public.pursue_opportunity(uuid) from public, anon, authenticated;

-- ---- PAYMENT BEFORE DELIVERY (enforced by the database) -------------
create or replace function public.project_is_paid(p_project_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.invoices i where i.project_id = p_project_id and i.status = 'paid')
      or coalesce((select budget_minor from public.projects where id = p_project_id), 0) = 0
$$;

create or replace function public.require_payment_before_delivery() returns trigger language plpgsql as $$
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' and not public.project_is_paid(new.id) then
    raise exception 'delivery blocked: the invoice for this project is not paid yet' using errcode = '42501';
  end if;
  return new;
end $$;
create or replace function public.require_payment_before_deliverable_release() returns trigger language plpgsql as $$
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' and not public.project_is_paid(new.project_id) then
    raise exception 'delivery blocked: the invoice for this project is not paid yet' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger deliverables_payment_gate before update on public.deliverables for each row execute function public.require_payment_before_deliverable_release();
create trigger projects_payment_gate before update on public.projects for each row execute function public.require_payment_before_delivery();

-- When an invoice becomes paid, delivery is scheduled automatically.
create or replace function public.invoice_paid_schedule_delivery() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' and new.project_id is not null then
    perform public.enqueue_task('project.deliver', 'deliver-paid:' || new.project_id || ':' || new.id, jsonb_build_object('project_id', new.project_id, 'invoice_id', new.id),
      'project_manager', 'project', new.project_id::text, 85, now(), 5, 120, '{}', 'Deliver after payment: ' || new.number);
    perform public.log_event('invoice', new.id::text, 'invoice_paid', format('Invoice %s paid — delivery scheduled', new.number), '{}'::jsonb, 'info');
  end if;
  return new;
end $$;
create trigger invoices_paid_delivery after update of status on public.invoices for each row execute function public.invoice_paid_schedule_delivery();

grant execute on function public.project_is_paid(uuid) to authenticated;
grant execute on function public.require_payment_before_delivery() to authenticated;
grant execute on function public.require_payment_before_deliverable_release() to authenticated;
