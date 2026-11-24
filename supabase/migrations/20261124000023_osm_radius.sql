update public.sources set config = config || '{"radius_m": 1500}'::jsonb where key = 'osm_businesses';
