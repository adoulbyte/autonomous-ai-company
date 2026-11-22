-- Cloudflare Workers AI (free daily allocation) on the same Cloudflare account used for hosting:
-- no additional account. base_url placeholders ${NAME} are filled from the worker environment.
alter table public.ai_providers add column request_options jsonb not null default '{"response_format": {"type": "json_object"}}'::jsonb;

insert into public.ai_providers(key, name, base_url, api_key_env, enabled, priority, free_tier, data_policy, notes, request_options) values
 ('cloudflare_ai', 'Cloudflare Workers AI', 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1', 'CLOUDFLARE_API_TOKEN',
  true, 15, true, 'Cloudflare states Workers AI does not use customer inputs/outputs to train models (verify in their terms).',
  'Free daily allocation (Neurons). Requires the Cloudflare API token to include the "Workers AI" permission.', '{}'::jsonb)
on conflict (key) do nothing;

insert into public.ai_models(provider_key, model, display_name, tier, capabilities, context_window, max_output_tokens) values
 ('cloudflare_ai', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B (Cloudflare)', 'standard', '{chat,json}', 24000, 4000),
 ('cloudflare_ai', '@cf/qwen/qwen2.5-coder-32b-instruct', 'Qwen2.5 Coder 32B (Cloudflare)', 'strong', '{chat,json,code}', 32000, 4000),
 ('cloudflare_ai', '@cf/meta/llama-3.1-8b-instruct-fast', 'Llama 3.1 8B (Cloudflare)', 'fast', '{chat,json}', 8000, 2000)
on conflict (provider_key, model) do nothing;
