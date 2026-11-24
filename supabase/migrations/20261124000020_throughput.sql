-- Throughput: unreachable postings (no published email) are parked without spending AI calls,
-- and the worker may chain extra runs when there is a backlog (bounded per day).
insert into public.state_transitions(entity, from_state, to_state) values ('opportunity','discovered','monitoring')
  on conflict do nothing;

insert into public.settings(key, value, description) values
  ('worker.schedule', '{"max_runs_per_day": 6, "chain_when_backlog": true}',
   'Worker runs: at most this many full runs per 24h (GitHub Actions free minutes), chaining an extra run when work is waiting.')
on conflict (key) do nothing;

-- Re-evaluation of already-analysed opportunities (e.g. after the launch program changed the criteria).
insert into public.state_transitions(entity, from_state, to_state) values ('opportunity','rejected','analyzing')
  on conflict do nothing;

-- One-off: re-score contactable, already-analysed opportunities under the launch-program criteria.
select public.enqueue_task(p_type => 'opportunity.score', p_idempotency_key => 'rescore-pilot:' || o.id,
         p_input => jsonb_build_object('opportunity_id', o.id), p_role_key => 'scoring_engine',
         p_entity_type => 'opportunity', p_entity_id => o.id::text, p_priority => 60,
         p_title => left('Re-score (launch program): ' || o.title, 120))
from public.opportunities o
where o.analysis is not null and o.status in ('rejected','monitoring')
  and o.buyer_contact ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  and (o.posted_at is null or o.posted_at > now() - interval '45 days');
