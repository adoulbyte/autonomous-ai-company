import { z } from 'zod';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { logEvent } from '../db.js';

const MarketingSchema = z.object({
  summary: z.string().max(1200),
  focus_categories: z.array(z.string().max(60)).max(10),
  deprioritize_categories: z.array(z.string().max(60)).max(10),
  writing_tips: z.array(z.string().max(240)).max(6),
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
  if (contacted < 40) {
    return finish(ctx, async (tx) => {
      const summary = `${contacted} entreprises contactées, ${replied} réponse(s) : pas encore assez de données pour réorienter la prospection (minimum 40 contacts). La stratégie actuelle continue.`;
      await tx`update public.settings set value = value || ${tx.json({ summary, updated_at: new Date().toISOString() } as never)} where key = 'marketing.strategy'`;
      return { contacted, replied, ai: false };
    });
  }
  const res = await ctx.ai.generate({ roleKey: 'marketing_strategist', taskId: ctx.task.id, tier: 'strong', schema: MarketingSchema, maxTokens: 1200, temperature: 0.2,
    messages: [{ role: 'user', content: `You are the marketing strategist of a small studio that sells quick, low-cost digital services (one-page websites, social visuals,
flyers/menus as PDF, ad scripts, spreadsheets) to local businesses found in public directories, by personalised email.
Analyse these REAL results (one row per trade x country x offer). Only cite numbers present below; with small samples, say so and stay cautious.
Return JSON {summary (in French, 3-5 sentences for the owner), focus_categories (trade tags like "shop=bakery" that respond best),
deprioritize_categories (tags with many contacts and no interest), writing_tips (short, concrete, honest advice for the next emails; never spammy or deceptive)}.
Results: ${JSON.stringify(stats)}` }] });
  return finish(ctx, async (tx) => {
    await tx`update public.settings set value = ${tx.json({ ...res.data, updated_at: new Date().toISOString(), contacted, replied } as never)} where key = 'marketing.strategy'`;
    await logEvent(tx, 'marketing', 'strategy', 'marketing_review', res.data.summary.slice(0, 300));
    return { contacted, replied, ai: true, model: res.model };
  });
};
