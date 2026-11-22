-- =====================================================================
-- 0015 AUTONOMOUS EMAIL CHANNEL, NEGOTIATION, DEAL ACCEPTANCE, INVOICE
--      PAYMENT INSTRUCTIONS, PREVIEW-BEFORE-PAYMENT
-- =====================================================================

insert into public.settings(key, value, description, critical) values
  ('business.identity', '{
     "company_name": "Autonomous AI Studio",
     "sender_name": "Autonomous AI Studio",
     "tagline": "Software, automation, data & research — delivered with independent quality control",
     "website": "",
     "signature": "Autonomous AI Studio\nSoftware · Automation · Data · Research",
     "ai_disclosure": "Prepared with AI assistance.",
     "reply_language": "match_client"
   }', 'How the company presents itself in emails, invoices and proposals.', true),
  ('finance.payment_instructions', '{
     "enabled": false,
     "text": "Payment details will be provided shortly.",
     "beneficiary": "", "iban": "", "bic": "", "bank": "", "reference_hint": "Please use the invoice number as payment reference."
   }', 'Payment coordinates printed on every invoice (e.g. IBAN). Set enabled=true once filled.', true),
  ('comms.policy', '{
     "daily_send_cap": 40, "max_outreach_per_day": 15, "max_followups": 2, "followup_after_days": 4,
     "require_email_contact_for_outreach": true
   }', 'Email sending limits and follow-up rules (protects deliverability and reputation).', true),
  ('deals.policy', '{
     "auto_accept": true, "min_margin_over_floor_pct": 0, "max_auto_accept_minor": 300000,
     "require_written_acceptance": true
   }', 'When the negotiation agent may accept a deal on its own.', true)
on conflict (key) do nothing;

-- Full autonomy for routine client communication (owner keeps payment validation + kill switch).
update public.settings set value = value || '{
  "message.send": "auto", "payment.request.send": "auto", "delivery.send": "auto", "deal.accept": "auto", "lead.reply": "auto"
}'::jsonb, version = version + 1, updated_by = 'migration:0015' where key = 'autonomy.policy';

-- Email transport metadata
alter table public.messages add column if not exists email_message_id text;
alter table public.messages add column if not exists in_reply_to text;
alter table public.messages add column if not exists send_attempts integer not null default 0;
alter table public.messages add column if not exists last_error text;
alter table public.messages add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.messages add column if not exists html text;
create unique index if not exists messages_email_message_id_uq on public.messages(email_message_id) where email_message_id is not null;
create index if not exists messages_outbox_idx on public.messages(created_at) where direction = 'outbound' and status = 'approved';

create table if not exists public.mailbox_state (
  mailbox     text primary key,
  last_uid    bigint not null default 0,
  last_poll_at timestamptz,
  last_error  text
);
alter table public.mailbox_state enable row level security;
create policy owner_read on public.mailbox_state for select to authenticated using (public.is_owner());
grant select on public.mailbox_state to authenticated;

-- Negotiation state on leads
alter table public.leads add column if not exists agreed_price_minor bigint;
alter table public.leads add column if not exists agreed_scope text;

-- Roles
insert into public.agent_roles(key, name, department, objective, supervisor, model_tier, allowed_tools, task_types, permissions, input_schema, output_schema, quality_rules, max_output_tokens, daily_call_budget, retry_max, timeout_seconds, is_ai) values
 ('negotiation_agent','Negotiation Agent','Sales','Answer client replies professionally, clarify scope, negotiate within the pricing policy and close the deal when the client agrees in writing.','owner','strong',
  '{llm,email}','{lead.respond}','{messages.draft,deals.accept}',
  '{"lead_id":"uuid","message_id":"uuid"}','{"intent":"enum","reply":"string","agreed_price":"number|null","scope":"string|null"}',
  '{"never accept below the price floor","never promise what the system cannot deliver","confirm scope in writing before accepting","be truthful about AI assistance if asked"}',1500,150,3,200,true),
 ('mail_clerk','Mail Clerk','Client Relations','Send approved emails and import replies from the company mailbox. Deterministic.','owner','none',
  '{email}','{comms.send,comms.poll_inbox}','{messages.send,messages.receive}','{}','{}','{}',0,0,3,180,false)
on conflict (key) do nothing;

-- Internal project creation (used by the negotiation agent when the deal policy allows it).
create or replace function public.create_project_internal(p_lead_id uuid, p_name text, p_scope text, p_budget_minor bigint, p_currency text)
returns uuid language plpgsql security definer set search_path = public as $$
declare l public.leads; v_client uuid; v_project uuid;
begin
  select * into l from public.leads where id = p_lead_id for update;
  if l.id is null then raise exception 'lead not found' using errcode = 'P0002'; end if;
  select id into v_project from public.projects where lead_id = l.id;
  if v_project is not null then return v_project; end if;
  if l.company_id is not null then
    insert into public.clients(company_id) values (l.company_id) on conflict (company_id) do nothing;
    select id into v_client from public.clients where company_id = l.company_id;
  end if;
  insert into public.projects(opportunity_id, lead_id, client_id, name, scope, budget_minor, currency)
  values (l.opportunity_id, l.id, v_client, p_name, p_scope, p_budget_minor, upper(p_currency)) returning id into v_project;
  perform public.enqueue_task('project.plan', 'project.plan:' || v_project, jsonb_build_object('project_id', v_project),
    'project_architect', 'project', v_project::text, 70, now(), 3, 300, '{}', 'Plan project: ' || p_name);
  perform public.log_event('project', v_project::text, 'project_created', format('Deal closed — project "%s" started (%s %s)', p_name, p_budget_minor / 100.0, p_currency));
  return v_project;
end $$;
revoke execute on function public.create_project_internal(uuid, text, text, bigint, text) from public, anon, authenticated;

-- Deal is completed (closed) when the client has the delivery and the invoice is paid.
create or replace function public.close_deal_after_delivery() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' and public.project_is_paid(new.id) then
    update public.opportunities set status = 'won' where id = new.opportunity_id and status = 'pursuing';
    perform public.log_event('project', new.id::text, 'deal_completed', format('Deal completed: "%s" delivered and paid', new.name));
  end if;
  return new;
end $$;
drop trigger if exists projects_close_deal on public.projects;
create trigger projects_close_deal after update of status on public.projects for each row execute function public.close_deal_after_delivery();

-- Owner confirms a payment (the ONLY manual step). Delivery then happens automatically.
-- (owner_record_payment / owner_confirm_payment already exist and trigger invoice → paid → project.deliver)
