-- Extra free-tier models so planning/QA have several independent strong reviewers.
-- Models a provider does not serve are disabled automatically (catalog sync / first 404).
insert into public.ai_models(provider_key, model, display_name, tier, capabilities, context_window, max_output_tokens) values
 ('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 'strong', '{chat,json}', 128000, 8000),
 ('groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B (Groq)', 'fast', '{chat,json}', 128000, 4000),
 ('gemini', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 'strong', '{chat,json}', 1000000, 8000)
on conflict (provider_key, model) do nothing;
-- Gemini & Groq become preferred over Cloudflare for quality; Cloudflare stays as fallback.
update public.ai_providers set priority = 12 where key = 'gemini';
update public.ai_providers set priority = 14 where key = 'groq';
update public.ai_providers set priority = 16 where key = 'cloudflare_ai';
