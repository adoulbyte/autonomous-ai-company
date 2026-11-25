import { z } from 'zod';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { logEvent } from '../db.js';
import { allowedCountries } from '../connectors/osm.js';

const MarketingSchema = z.object({
  summary: z.string().max(1200),
  focus_categories: z.array(z.string().max(60)).max(10),
  deprioritize_categories: z.array(z.string().max(60)).max(10),
  writing_tips: z.array(z.string().max(240)).max(6),
  country_weights: z.record(z.string().max(3), z.number().int().min(0).max(5)),
  zones_per_city: z.number().int().min(1).max(5),
  geo_reason: z.string().max(600),
});

/** Real prospecting results grouped by trade, country and offer (counts only). */
export async function prospectingStats(sql: Parameters<Handler>[0]['sql']) {
  return sql`
    select coalesce(o.analysis->>'category', '?') as category, coalesce(o.analysis->>'country', '?') as country, coalesce(o.analysis->>'need', '?') as offer,
      count(distinct l.id)::int as contacted,
      count(distinct l.id) filter (where exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
         where c.lead_id = l.id and m.direction = 'inbound' and m.classification->>'automated' is null))::int as replied,
      count(distinct l.id) filter (where l.stage in ('engaged','proposal','negotiating','won'))::int as interested,
      count(distinct l.id) filter (where l.stage = 'won')::int as won,
      count(distinct l.id) filter (where l.lost_reason = 'unsubscribed')::int as unsubscribed,
      count(distinct l.id) filter (where l.lost_reason = 'email bounced')::int as bounced
    from public.leads l join public.opportunities o on o.id = l.opportunity_id
    where o.analysis->>'prospect' = 'true' and l.stage <> 'qualified'
    group by 1, 2, 3 order by 4 desc limit 60`;
}

/** marketing.review — Marketing Strategist: learns from real results which trades, places, offers and wording get replies. */
export const marketingReview: Handler = async (ctx) => {
  const stats = await prospectingStats(ctx.sql);
  const contacted = stats.reduce((a, r) => a + Number(r.contacted), 0);
  const replied = stats.reduce((a, r) => a + Number(r.replied), 0);
  const [src] = await ctx.sql`select config from public.sources where key = 'osm_businesses'`;
  const config = (src?.config ?? {}) as Record<string, unknown>;
  const countries = allowedCountries(config);
  const learning = contacted < 40;
  const res = await ctx.ai.generate({ roleKey: 'marketing_strategist', taskId: ctx.task.id, tier: 'strong', allowDowngrade: true, schema: MarketingSchema, maxTokens: 1500, temperature: 0.2,
    messages: [{ role: 'user', content: `You are the marketing strategist of a small studio that sells quick, low-cost digital services (one-page websites, social visuals,
flyers/menus as PDF, ad scripts, spreadsheets) to local businesses found in public directories (OpenStreetMap), by personalised email.
The owner is French; emails are written in the language of each country (French, English, Dutch, Portuguese).
You decide HOW we prospect:
- country_weights: how many cities of each country we explore per rotation round (0 = pause the country, max 5). ONLY these countries are allowed
  (legal for B2B email with opt-out; number of cities we know in each): ${JSON.stringify(countries)}.
- zones_per_city: how many zones of each city we explore before moving on (1 = cover many cities fast, 5 = city centre + 4 neighbourhoods, deeper).
- focus_categories / deprioritize_categories: trade tags such as "shop=bakery" (from the results below).
- writing_tips: short, concrete, honest advice for the next emails (never spammy or deceptive).
${learning ? `There are only ${contacted} contacts and ${replied} replies so far: NOT enough data to conclude. Choose an EXPLORATION plan that tests several markets
in parallel to learn quickly where people reply (France stays important but must not take all the volume); keep focus/deprioritize lists empty unless the data is clear.`
  : 'Base every choice on the real results below; with small samples, stay cautious.'}
Consider: language and cultural closeness, purchasing power vs our low prices (19-49 EUR), share of small businesses without a website, time zones, deliverability.
Return JSON {summary (in French, 3-5 sentences for the owner, explaining the plan), focus_categories, deprioritize_categories, writing_tips,
country_weights, zones_per_city, geo_reason (in French, 1-3 sentences: why this geographic plan)}.
Real results (one row per trade x country x offer; counts only): ${JSON.stringify(stats)}` }] });
  const weights = Object.fromEntries(Object.entries(res.data.country_weights).map(([k, v]) => [k.toUpperCase(), v]).filter(([k, v]) => k in countries && Number(v) > 0));
  const plan = Object.keys(weights).length ? { country_weights: weights, zones_per_city: res.data.zones_per_city } : null;
  return finish(ctx, async (tx) => {
    await tx`update public.settings set value = ${tx.json({ ...res.data, ...(plan ?? {}), learning, updated_at: new Date().toISOString(), contacted, replied } as never)} where key = 'marketing.strategy'`;
    // The geographic plan is applied to the business-directory prospecting right away.
    if (plan) await tx`update public.sources set config = config || ${tx.json(plan as never)} where key = 'osm_businesses'`;
    await logEvent(tx, 'marketing', 'strategy', 'marketing_review', res.data.summary.slice(0, 300));
    return { contacted, replied, ai: true, model: res.model, plan };
  });
};
