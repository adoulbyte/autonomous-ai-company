update public.sources set config = config || '{"radius_m": 1500}'::jsonb, interval_minutes = 20 where key = 'osm_businesses';
