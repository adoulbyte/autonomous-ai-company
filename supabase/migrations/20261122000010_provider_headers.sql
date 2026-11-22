-- Provider-specific HTTP headers (e.g. GitHub's API version headers). Never secrets.
alter table public.ai_providers add column extra_headers jsonb not null default '{}'::jsonb;
update public.ai_providers set extra_headers = '{"accept": "application/vnd.github+json", "x-github-api-version": "2022-11-28"}'::jsonb
where key = 'github_models';
update public.sources set config = jsonb_set(config, '{max_thread_age_days}', '75') where key = 'hn_seeking_freelancer';
