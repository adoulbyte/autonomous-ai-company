-- Second strong-tier model so QA/planning can fall back (and differ from the producer's model when possible).
-- If Cloudflare does not serve it, the gateway disables it automatically on the first 404.
insert into public.ai_models(provider_key, model, display_name, tier, capabilities, context_window, max_output_tokens) values
 ('cloudflare_ai', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (Cloudflare)', 'strong', '{chat,json}', 128000, 4000)
on conflict (provider_key, model) do nothing;
