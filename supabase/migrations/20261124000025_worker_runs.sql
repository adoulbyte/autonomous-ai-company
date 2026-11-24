update public.settings set value = value || '{"max_runs_per_day": 7}'::jsonb where key = 'worker.schedule';
