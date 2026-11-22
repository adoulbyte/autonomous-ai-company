-- =====================================================================
-- 0007 EXECUTION: approval executor, pursuit, CRM automation hooks
-- =====================================================================
alter table public.deliverables add column produced_by_model text;
alter table public.reminders add column notified_at timestamptz;

-- Internal pursuit (no owner check). Called by the owner RPC, or by the worker
-- ONLY when executing an approved 'opportunity.pursue' approval.
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
      insert into public.companies(name, website, notes) values (o.buyer_name, null, 'Created from opportunity ' || o.url) returning id into v_company;
    end if;
  end if;
  if o.buyer_contact is not null then
    if o.buyer_contact ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      select id into v_contact from public.contacts where lower(email) = lower(o.buyer_contact) and deleted_at is null;
      if v_contact is null then
        insert into public.contacts(company_id, name, email, source, lawful_basis)
        values (v_company, o.buyer_name, o.buyer_contact, o.source_key, 'public_request') returning id into v_contact;
      end if;
    else
      v_handle := o.buyer_contact;
      select id into v_contact from public.contacts where lower(source) = lower(o.source_key) and lower(handle) = lower(v_handle) and deleted_at is null;
      if v_contact is null then
        insert into public.contacts(company_id, name, handle, source, lawful_basis)
        values (v_company, o.buyer_name, v_handle, o.source_key, 'public_request') returning id into v_contact;
      end if;
    end if;
  end if;

  insert into public.leads(opportunity_id, company_id, contact_id, title, source, score, value_minor, currency, stage)
  values (o.id, v_company, v_contact, o.title, o.source_key, o.score, o.est_revenue_minor, o.currency, 'new')
  returning id into v_lead;
  update public.leads set stage = 'qualified' where id = v_lead;
  update public.opportunities set status = 'pursuing' where id = o.id;
  perform public.enqueue_task('lead.draft_outreach', 'outreach:' || v_lead, jsonb_build_object('lead_id', v_lead), 'sales_agent',
    'lead', v_lead::text, 60, now(), 3, 200, '{}', 'Draft outreach: ' || left(o.title, 80));
  perform public.log_event('lead', v_lead::text, 'lead_created', format('Pursuing "%s"', o.title));
  return v_lead;
end $$;

create or replace function public.owner_pursue_opportunity(p_opportunity_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  perform public.assert_owner();
  v := public.pursue_opportunity(p_opportunity_id);
  -- a pending pursue approval for this opportunity is now moot: mark it decided by owner action
  update public.approvals set status = 'approved', decided_by = public.current_actor(), decided_at = now(), decision_note = 'pursued directly by owner'
  where action_type = 'opportunity.pursue' and entity_id = p_opportunity_id::text and status = 'pending';
  update public.approvals set status = 'executed', executed_at = now(), execution_result = jsonb_build_object('lead_id', v)
  where action_type = 'opportunity.pursue' and entity_id = p_opportunity_id::text and status = 'approved';
  return v;
end $$;

-- Executes approvals whose effect lives outside decide_approval. Run by the worker each tick.
create or replace function public.execute_approved_actions() returns integer
language plpgsql security definer set search_path = public as $$
declare a record; n integer := 0; v uuid;
begin
  perform set_config('app.actor', 'system:approval_executor', true);
  for a in select * from public.approvals where status = 'approved' and action_type in ('opportunity.pursue') for update skip locked loop
    begin
      if a.action_type = 'opportunity.pursue' then
        v := public.pursue_opportunity(a.entity_id::uuid);
        update public.approvals set status = 'executed', executed_at = now(), execution_result = jsonb_build_object('lead_id', v) where id = a.id;
      end if;
      n := n + 1;
    exception when others then
      update public.approvals set status = 'failed', executed_at = now(), execution_result = jsonb_build_object('error', sqlerrm) where id = a.id;
      perform public.log_event('approval', a.id::text, 'approval_execution_failed', sqlerrm, '{}'::jsonb, 'error');
    end;
  end loop;
  return n;
end $$;

-- When an outbound message to a lead is actually sent, advance the lead to 'contacted'.
create or replace function public.owner_mark_message_sent(p_message_id uuid, p_reference text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_lead uuid; v_stage text;
begin
  perform public.assert_owner();
  update public.messages set status = 'sent', sent_at = now() where id = p_message_id and status = 'approved';
  if not found then raise exception 'message must be approved before it is sent' using errcode = 'P0001'; end if;
  if p_reference is not null then insert into public.notes(entity_type, entity_id, body) values ('message', p_message_id, 'Sent: ' || p_reference); end if;
  select c.lead_id, l.stage into v_lead, v_stage from public.messages m join public.conversations c on c.id = m.conversation_id
    left join public.leads l on l.id = c.lead_id where m.id = p_message_id;
  if v_lead is not null and v_stage in ('new','qualified') then
    update public.leads set stage = 'contacted', next_follow_up_at = now() + interval '5 days' where id = v_lead;
  end if;
  perform public.log_event('message', p_message_id::text, 'message_sent', 'Outbound message marked sent by owner');
end $$;

revoke execute on function public.pursue_opportunity(uuid) from public, anon, authenticated;
revoke execute on function public.execute_approved_actions() from public, anon, authenticated;
grant execute on function public.owner_pursue_opportunity(uuid) to authenticated;
grant execute on function public.owner_mark_message_sent(uuid, text) to authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('aic-execute-approvals', '*/5 * * * *', 'select public.execute_approved_actions();');
  end if;
end $$;
