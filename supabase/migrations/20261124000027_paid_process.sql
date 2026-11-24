-- Paid process: prospecting with a concrete example → reply → quote (devis) → written agreement → work + double QA
-- → invoice prepared → OWNER validates the invoice → sent automatically → OWNER confirms payment → automatic delivery.
update public.settings set value = value || '{"mode": "paid"}'::jsonb, version = version + 1, updated_by = 'migration:0027' where key = 'business.mode';
update public.settings set value = value || '{"payment.request.send": "approval", "payment.confirm": "owner", "delivery.send": "auto"}'::jsonb,
  version = version + 1, updated_by = 'migration:0027' where key = 'autonomy.policy';
-- French market: prices in euros, floors that cover the work.
update public.settings set value = value || '{"currency": "EUR", "min_price_minor": 15000, "min_hourly_minor": 2500}'::jsonb,
  version = version + 1, updated_by = 'migration:0027' where key = 'pricing.policy';
update public.settings set value = '"EUR"'::jsonb, version = version + 1, updated_by = 'migration:0027' where key = 'finance.base_currency';
