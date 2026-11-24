update public.sources set config = config || '{"radius_m": 4000}'::jsonb where key = 'osm_businesses';
