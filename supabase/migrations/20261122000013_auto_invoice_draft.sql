-- =====================================================================
-- 0013 When a project is delivered, automatically prepare a DRAFT invoice
-- for the agreed price (internal action; issuing it to the client stays an
-- owner decision). Idempotent: never creates a second non-void invoice.
-- =====================================================================
create or replace function public.project_delivered_draft_invoice() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv_number text;
begin
  if new.status in ('delivered','accepted') and old.status is distinct from new.status
     and coalesce(new.budget_minor, 0) > 0
     and not exists (select 1 from public.invoices i where i.project_id = new.id and i.status <> 'void') then
    inv_number := 'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.invoice_number_seq')::text, 5, '0');
    insert into public.invoices(number, project_id, client_id, due_date, amount_minor, currency, notes)
    values (inv_number, new.id, new.client_id, current_date + 14, new.budget_minor, new.currency,
            'Prepared automatically when the project was delivered. Review and click "Issue" when you send it to the client.');
    perform public.log_event('invoice', new.id::text, 'invoice_draft_prepared',
      format('Draft invoice %s prepared for "%s" (%s %s) — review and send it', inv_number, new.name, new.budget_minor / 100.0, new.currency),
      jsonb_build_object('project_id', new.id, 'number', inv_number), 'warning');
  end if;
  return new;
end $$;
create trigger projects_delivered_invoice after update of status on public.projects
  for each row execute function public.project_delivered_draft_invoice();
