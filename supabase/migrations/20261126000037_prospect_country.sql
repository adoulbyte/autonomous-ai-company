-- Prospects found before this fix had no country in their analysis: recover it from the directory record they come from.
update public.opportunities o set analysis = o.analysis || jsonb_build_object('country', coalesce(e.raw->>'country', 'FR'))
from public.opportunity_evidence oe join public.evidence e on e.id = oe.evidence_id
where oe.opportunity_id = o.id and o.analysis->>'prospect' = 'true' and not (o.analysis ? 'country');
