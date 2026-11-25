-- The mailbox's reputation is still young (test emails landed in spam): slower warm-up of first contacts.
update public.settings set value = jsonb_build_object('start_per_day', 10, 'step_per_day', 5, 'max_per_day', 60, 'started_at', now()),
  version = version + 1, updated_by = 'migration:0031' where key = 'prospecting.policy';
