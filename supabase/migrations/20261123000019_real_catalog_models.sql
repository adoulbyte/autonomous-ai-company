-- Align the model registry with the catalogs actually served (verified 2026-11-23 via /models).
insert into public.ai_models(provider_key, model, display_name, tier, capabilities, context_window, max_output_tokens) values
 ('groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)', 'standard', '{chat,json}', 128000, 8000),
 ('groq', 'qwen/qwen3.8-27b', 'Qwen 3.8 27B (Groq)', 'standard', '{chat,json}', 128000, 8000),
 ('gemini', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 'standard', '{chat,json}', 1000000, 8000),
 ('gemini', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'fast', '{chat,json}', 1000000, 8000),
 ('gemini', 'gemini-pro-latest', 'Gemini Pro (latest)', 'strong', '{chat,json}', 1000000, 8000)
on conflict (provider_key, model) do nothing;
-- Not served anymore by Groq: disable (health check re-enables automatically if they come back).
update public.ai_models set enabled = false, last_error = 'not present in provider catalog'
where provider_key = 'groq' and model in ('llama-3.3-70b-versatile', 'llama-3.1-8b-instant');
