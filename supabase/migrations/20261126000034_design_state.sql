-- Each designed creation keeps its exact design (texts, colours, fonts, photos, facts) so that a requested change is applied
-- precisely to it — never regenerated from scratch.
alter table public.deliverables add column if not exists design jsonb;
