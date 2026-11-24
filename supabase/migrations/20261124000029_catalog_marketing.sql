-- Quick-service menu: small, fast deliverables at low fixed prices (editable in Settings).
insert into public.settings(key, value, description) values
 ('pricing.catalog', '{
   "currency": "EUR",
   "items": {
     "website":      {"label": {"fr": "Site vitrine une page", "en": "One-page showcase website", "nl": "Website van één pagina", "pt": "Site de apresentação de uma página"}, "price_minor": 4900, "days": 3},
     "social_post":  {"label": {"fr": "Visuel pour réseaux sociaux", "en": "Social media visual", "nl": "Visual voor sociale media", "pt": "Visual para redes sociais"}, "price_minor": 1900, "days": 1},
     "social_pack":  {"label": {"fr": "Pack de 3 visuels", "en": "Pack of 3 visuals", "nl": "Pakket van 3 visuals", "pt": "Pacote de 3 visuais"}, "price_minor": 4500, "days": 2},
     "flyer_pdf":    {"label": {"fr": "Flyer ou menu en PDF", "en": "Flyer or menu (PDF)", "nl": "Flyer of menu (PDF)", "pt": "Folheto ou menu em PDF"}, "price_minor": 2900, "days": 1},
     "ad_scripts":   {"label": {"fr": "3 scénarios publicitaires", "en": "3 ad scripts", "nl": "3 advertentiescripts", "pt": "3 roteiros publicitários"}, "price_minor": 2500, "days": 1},
     "spreadsheet":  {"label": {"fr": "Tableau Excel sur mesure", "en": "Custom Excel spreadsheet", "nl": "Excel-sheet op maat", "pt": "Folha Excel à medida"}, "price_minor": 2900, "days": 1}
   }
 }', 'Quick-service menu with fixed prices, proposed to local businesses.')
on conflict (key) do nothing;

-- Floors that allow the quick-service menu (the smallest item is 19 EUR).
update public.settings set value = value || '{"min_price_minor": 1900, "min_hourly_minor": 1500}'::jsonb, version = version + 1, updated_by = 'migration:0029'
where key = 'pricing.policy';

-- Marketing Strategist: learns from real results which trades, places, offers and wording get replies.
insert into public.agent_roles(key, name, department, objective, supervisor, model_tier, allowed_tools, task_types, permissions, input_schema, output_schema, quality_rules, max_output_tokens, daily_call_budget, retry_max, timeout_seconds, is_ai) values
 ('marketing_strategist','Marketing Strategist','Sales','Analyse prospecting results (sent, replies, interest, deals by trade, country and offer) and steer targeting, offers and email wording toward what converts.','executive_strategist','strong',
  '{llm,db}','{marketing.review}','{settings.marketing}',
  '{}','{"summary":"string","focus_categories":"string[]","deprioritize_categories":"string[]","writing_tips":"string[]"}',
  '{"only cite numbers present in the data","never recommend deceptive or spammy tactics","respect the opt-out and legal rules"}',1500,20,2,240,true)
on conflict (key) do nothing;
insert into public.settings(key, value, description) values
 ('marketing.strategy', '{"summary": "Pas encore assez de résultats : la stratégie s’affinera avec les premières réponses.", "focus_categories": [], "deprioritize_categories": [], "writing_tips": [], "updated_at": null}',
  'Latest guidance from the Marketing Strategist (used by the prospecting and sales agents).')
on conflict (key) do nothing;
