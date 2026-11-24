-- Human replies from prospects that were classified "not applicable" by the triage model were not answered:
-- hand them to the Negotiation Agent now (machine messages — bounces, out-of-office — stay excluded).
select public.enqueue_task(p_type => 'lead.respond', p_idempotency_key => 'respond:' || m.id,
         p_input => jsonb_build_object('lead_id', c.lead_id, 'message_id', m.id), p_role_key => 'negotiation_agent',
         p_entity_type => 'lead', p_entity_id => c.lead_id::text, p_priority => 82, p_timeout_seconds => 220,
         p_title => 'Respond to client (re-routed reply)')
from public.messages m join public.conversations c on c.id = m.conversation_id join public.leads l on l.id = c.lead_id
where m.direction = 'inbound' and c.lead_id is not null and m.classification->>'automated' is null
  and coalesce(m.classification->>'category', '') <> 'spam' and l.stage not in ('won','lost','disqualified')
  and not exists (select 1 from public.tasks t where t.idempotency_key = 'respond:' || m.id);
