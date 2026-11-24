-- Launch program criteria v2 (slightly vague requests accepted; the first email asks clarifying questions):
-- re-score contactable, already-analysed opportunities once more.
select public.enqueue_task(p_type => 'opportunity.score', p_idempotency_key => 'rescore-pilot-v2:' || o.id,
         p_input => jsonb_build_object('opportunity_id', o.id), p_role_key => 'scoring_engine',
         p_entity_type => 'opportunity', p_entity_id => o.id::text, p_priority => 60,
         p_title => left('Re-score (launch program v2): ' || o.title, 120))
from public.opportunities o
where o.analysis is not null and o.status in ('rejected','monitoring')
  and o.buyer_contact ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  and (o.posted_at is null or o.posted_at > now() - interval '45 days');
