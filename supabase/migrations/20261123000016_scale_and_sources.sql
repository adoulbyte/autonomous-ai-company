-- =====================================================================
-- 0016 Larger prospecting capacity, more sources
-- history-rewritten: the company identity is configured in Settings (database), not in the code.
-- =====================================================================
-- Gmail allows ~500 recipients/day on a standard account; stay under it with a safety margin.
update public.settings set value = value || '{"daily_send_cap": 400, "max_outreach_per_day": 250, "followup_after_days": 3}'::jsonb,
  version = version + 1, updated_by = 'migration:0016' where key = 'comms.policy';
update public.settings set value = '600' where key = 'limits.daily_ai_calls';
update public.settings set value = '12' where key = 'limits.analyses_per_run';
update public.agent_roles set daily_call_budget = greatest(daily_call_budget, 400) where key in ('research_analyst', 'sales_agent', 'pricing_analyst', 'negotiation_agent', 'communications');
update public.agent_roles set daily_call_budget = greatest(daily_call_budget, 300) where key in ('specialist_worker', 'qa_reviewer', 'project_architect');

-- More legitimate sources of paid work with published contacts.
insert into public.sources(key, name, kind, connector, description, config, enabled, interval_minutes, max_items_per_run, terms_notes) values
 ('hn_who_is_hiring', 'Hacker News — Who is hiring (contract / freelance)', 'api', 'hn_hiring',
  'Monthly "Ask HN: Who is hiring?" thread; keeps only posts offering CONTRACT, FREELANCE or PART-TIME work, which a service company can answer.',
  '{"max_thread_age_days": 75}', true, 240, 60,
  'Official public HN Search API (hn.algolia.com). Contact only via channels the poster published.'),
 ('remotive_contract', 'Remotive — contract & freelance remote jobs', 'api', 'remotive',
  'Remote contract/freelance jobs in software, data and AI from the Remotive public API.',
  '{"categories": ["software-dev", "data", "devops"], "job_types": ["contract", "freelance"]}', true, 720, 40,
  'Remotive public API: max a few requests per day, link back to Remotive as the source (we store the source URL).'),
 ('wwr_contract', 'We Work Remotely — contract jobs (RSS)', 'rss', 'wwr_rss',
  'Remote programming jobs RSS feed; keeps contract positions.',
  '{"feeds": ["https://weworkremotely.com/categories/remote-programming-jobs.rss", "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss"]}', true, 360, 40,
  'Public RSS feed published for syndication; low frequency.')
on conflict (key) do nothing;
