-- Prospect replies: a "read" state so the dashboard counter shows only NEW real replies, and resets once they are read.
alter table public.messages add column if not exists read_at timestamptz;

-- Delivery failures recorded before the bounce rules were complete ("Adresse introuvable", "Address not found"…) are not replies.
update public.messages set classification = coalesce(classification, '{}'::jsonb)
    || jsonb_build_object('automated', 'bounce', 'category', 'other', 'intent', 'not_applicable', 'summary', 'Delivery failure (address does not exist)')
  where direction = 'inbound' and coalesce(classification->>'automated', '') = ''
    and (from_addr ilike '%mailer-daemon%' or from_addr ilike '%postmaster%'
      or subject ~* '(delivery status notification|undeliverable|undelivered|returned mail|non remis|non distribu|adresse introuvable|address not found)'
      or body ~* '(adresse introuvable|address not found|user unknown|does not exist|n''existe pas|550[ -]5\.1\.1)');

-- What was already in the mailbox has been seen by the owner.
update public.messages set read_at = now() where direction = 'inbound' and read_at is null;

create index if not exists messages_unread_inbound_idx on public.messages (created_at) where direction = 'inbound' and read_at is null;

create or replace function public.owner_mark_inbound_read(p_ids uuid[] default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform public.assert_owner();
  update public.messages set read_at = now()
    where direction = 'inbound' and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.owner_mark_inbound_read(uuid[]) from public;
grant execute on function public.owner_mark_inbound_read(uuid[]) to authenticated;
