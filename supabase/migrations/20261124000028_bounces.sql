-- An approved email can still be cancelled before sending (do-not-contact, automated address).
insert into public.state_transitions(entity, from_state, to_state) values ('message','approved','rejected') on conflict do nothing;
-- Automated messages (bounces / out-of-office) are not client replies.
update public.messages set classification = coalesce(classification, '{}'::jsonb) || '{"automated": "bounce"}'::jsonb
where direction = 'inbound' and (from_addr ~* '(mailer-daemon|postmaster)' or subject ~* '(undeliverable|delivery status notification|non remis|failure)');
-- Never answer an automated address.
update public.messages set status = 'rejected', last_error = 'automated address: never answered'
where direction = 'outbound' and status in ('draft','awaiting_approval','approved') and to_addr ~* '(mailer-daemon|postmaster|no-?reply)@';
-- Prospects whose address bounced: stop contacting them.
with b as (select distinct c.lead_id from public.messages m join public.conversations c on c.id = m.conversation_id
           where m.direction = 'inbound' and m.classification->>'automated' = 'bounce' and c.lead_id is not null)
update public.contacts set do_not_contact = true where id in (select l.contact_id from public.leads l join b on b.lead_id = l.id);
with b as (select distinct c.lead_id from public.messages m join public.conversations c on c.id = m.conversation_id
           where m.direction = 'inbound' and m.classification->>'automated' = 'bounce' and c.lead_id is not null)
update public.leads set stage = 'lost', lost_reason = 'email bounced', next_follow_up_at = null
where id in (select lead_id from b) and stage not in ('won','lost','disqualified');
