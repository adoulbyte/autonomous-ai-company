-- =====================================================================
-- 0008 OWNER TOOLS: manual opportunity entry (evidence-preserving)
-- =====================================================================
create or replace function public.owner_add_opportunity(p_title text, p_url text, p_text text, p_buyer text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_ev uuid; v_opp uuid; v_hash text := encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
begin
  perform public.assert_owner();
  if length(coalesce(p_text, '')) < 20 then raise exception 'evidence text too short' using errcode = 'P0001'; end if;
  insert into public.evidence(source_key, url, content_hash, title, excerpt, raw)
  values ('manual', p_url, v_hash, p_title, p_text, jsonb_build_object('entered_by', 'owner'))
  on conflict (url, content_hash) do update set fetched_at = now() returning id into v_ev;
  insert into public.opportunities(source_key, external_id, fingerprint, title, description, url, buyer_name, last_verified_at)
  values ('manual', v_hash, 'manual:' || v_hash, p_title, left(p_text, 4000), p_url, p_buyer, now())
  on conflict (source_key, external_id) do nothing returning id into v_opp;
  if v_opp is null then raise exception 'this opportunity was already added' using errcode = 'P0001'; end if;
  insert into public.opportunity_evidence(opportunity_id, evidence_id) values (v_opp, v_ev);
  perform public.enqueue_task('opportunity.analyze', 'analyze:' || v_opp, jsonb_build_object('opportunity_id', v_opp), 'research_analyst',
    'opportunity', v_opp::text, 60, now(), 3, 240, '{}', 'Analyze: ' || left(p_title, 80));
  perform public.log_event('opportunity', v_opp::text, 'opportunity_added', 'Owner added opportunity: ' || p_title);
  return v_opp;
end $$;
revoke execute on function public.owner_add_opportunity(text, text, text, text) from public, anon;
grant execute on function public.owner_add_opportunity(text, text, text, text) to authenticated;
