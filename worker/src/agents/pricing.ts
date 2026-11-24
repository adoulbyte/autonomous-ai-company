import { z } from 'zod';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { getSetting, logEvent } from '../db.js';
import { enqueue } from '../queue.js';
import { untrusted } from '../sanitize.js';

interface PricingPolicy { min_price_minor: number; min_hourly_minor: number; currency: string; never_exceed_stated_budget: boolean }

const MarketSchema = z.object({
  low_usd: z.number().nonnegative(),
  typical_usd: z.number().nonnegative(),
  high_usd: z.number().nonnegative(),
  typical_hourly_rate_usd: z.number().nonnegative(),
  rationale: z.string().max(1500),
});

/** Deterministic price decision from market evidence. Exported for unit tests. */
export function decidePrice(i: { statedBudgetMinor: number | null; aiTypicalMinor: number | null; comparablesMedianMinor: number | null;
  estHours: number | null; policy: PricingPolicy }): { priceMinor: number; basis: string[] } {
  const basis: string[] = [];
  const floor = Math.max(i.policy.min_price_minor, Math.round((i.estHours ?? 0) * i.policy.min_hourly_minor));
  basis.push(`cost floor ${floor / 100} (min ${i.policy.min_price_minor / 100}, ${i.estHours ?? '?'}h × ${i.policy.min_hourly_minor / 100}/h)`);
  let price: number;
  if (i.statedBudgetMinor && i.statedBudgetMinor > 0) {
    price = i.statedBudgetMinor; basis.push(`client stated budget ${i.statedBudgetMinor / 100}`);
  } else {
    const signals = [i.aiTypicalMinor, i.comparablesMedianMinor].filter((x): x is number => !!x && x > 0);
    price = signals.length ? Math.round(signals.reduce((a, b) => a + b, 0) / signals.length) : floor;
    if (i.aiTypicalMinor) basis.push(`market estimate ${i.aiTypicalMinor / 100}`);
    if (i.comparablesMedianMinor) basis.push(`median of comparable opportunities ${i.comparablesMedianMinor / 100}`);
  }
  if (price < floor) {
    if (i.statedBudgetMinor && i.policy.never_exceed_stated_budget) basis.push('WARNING: stated budget is below our cost floor');
    else { basis.push(`raised to cost floor`); price = floor; }
  }
  return { priceMinor: Math.round(price / 100) * 100, basis };   // whole currency units
}

export interface CatalogItem { label: Record<string, string>; price_minor: number; days: number }
export interface Catalog { currency: string; items: Record<string, CatalogItem> }
export async function getCatalog(sql: Parameters<Handler>[0]['sql']): Promise<Catalog> {
  return getSetting<Catalog>(sql, 'pricing.catalog', { currency: 'EUR', items: { website: { label: { fr: 'Site vitrine une page', en: 'One-page website' }, price_minor: 4900, days: 3 },
    social_pack: { label: { fr: 'Pack de 3 visuels', en: 'Pack of 3 visuals' }, price_minor: 4500, days: 2 } } });
}
/** The menu as text, in the client's language ("- Site vitrine une page : 49 € (3 jours)"). */
export function catalogMenu(cat: Catalog, lang: string): string {
  const day = ({ fr: 'jour', nl: 'dag', pt: 'dia' } as Record<string, string>)[lang] ?? 'day';
  return Object.values(cat.items).map((i) => `- ${i.label[lang] ?? i.label.en ?? Object.values(i.label)[0]}: ${(i.price_minor / 100).toFixed(0)} ${cat.currency === 'EUR' ? '€' : cat.currency} (${i.days} ${day}${i.days > 1 ? 's' : ''})`).join('\n');
}

export const quoteLead: Handler = async (ctx) => {
  const leadId = String(ctx.task.input.lead_id);
  const [l] = await ctx.sql`select l.*, o.analysis, o.business_model, o.skills, o.est_hours, o.description, o.url, o.title as opp_title
      from public.leads l left join public.opportunities o on o.id = l.opportunity_id where l.id = ${leadId}`;
  if (!l) throw new PermanentError('lead not found');
  // Local businesses from directories: fixed prices from the quick-service menu (fast, low cost), no market estimate needed.
  if ((l.analysis as { prospect?: boolean } | null)?.prospect) {
    const cat = await getCatalog(ctx.sql);
    const need = (l.analysis as { need?: string }).need === 'website' ? 'website' : 'social_pack';
    const item = cat.items[need];
    return finish(ctx, async (tx) => {
      const quote = { price_minor: item.price_minor, currency: cat.currency, basis: [`quick-service menu: ${need}`], catalog: need };
      await tx`update public.leads set value_minor = ${item.price_minor}, currency = ${cat.currency}, quote = ${tx.json(quote as never)} where id = ${leadId}`;
      await enqueue(tx, { type: 'lead.draft_outreach', key: `outreach:${leadId}`, role: 'sales_agent', entityType: 'lead', entityId: leadId,
        input: { lead_id: leadId }, priority: 60, title: `Draft outreach: ${String(l.title).slice(0, 80)}`, timeoutSeconds: 200 });
      return quote;
    });
  }
  const policy = await getSetting<PricingPolicy>(ctx.sql, 'pricing.policy', { min_price_minor: 10000, min_hourly_minor: 3000, currency: 'USD', never_exceed_stated_budget: true });
  const comps = await ctx.sql`select est_revenue_minor from public.opportunities
      where id <> ${l.opportunity_id} and est_revenue_minor > 0 and business_model = ${l.business_model ?? 'other'}
        and skills && ${(l.skills as string[] | null) ?? []}::text[] order by discovered_at desc limit 25`;
  const vals = comps.map((c) => Number(c.est_revenue_minor)).sort((a, b) => a - b);
  const median = vals.length >= 3 ? vals[Math.floor(vals.length / 2)] : null;
  const stated = (l.analysis as { stated_budget_usd?: number | null } | null)?.stated_budget_usd;

  const res = await ctx.ai.generate({ roleKey: 'pricing_analyst', taskId: ctx.task.id, tier: 'standard', schema: MarketSchema, maxTokens: 700,
    messages: [{ role: 'user', content: `You are a pricing analyst. Estimate the realistic MARKET price an independent professional/small agency would charge for this work
(market of the client's country — e.g. France for a French local business — mid-level quality). All amounts in ${policy.currency}
(the JSON keys keep the _usd suffix but the values are in ${policy.currency}). Return JSON {low_usd, typical_usd, high_usd, typical_hourly_rate_usd, rationale}.
Base it on scope, skills and effort; mention the evidence you used. Do not invent facts about the client.
Skills: ${JSON.stringify(l.skills ?? [])}; estimated effort: ${l.est_hours ?? 'unknown'} hours; business model: ${l.business_model ?? 'unknown'}.
${untrusted(`request ${l.url}`, String(l.description ?? l.opp_title), 5000)}` }] });

  const d = decidePrice({ statedBudgetMinor: stated ? Math.round(stated * 100) : null, aiTypicalMinor: Math.round(res.data.typical_usd * 100) || null,
    comparablesMedianMinor: median, estHours: l.est_hours == null ? null : Number(l.est_hours), policy });

  return finish(ctx, async (tx) => {
    const quote = { price_minor: d.priceMinor, currency: policy.currency, basis: d.basis, market: res.data, comparables: vals.length, model: res.model };
    await tx`update public.leads set value_minor = ${d.priceMinor}, currency = ${policy.currency}, quote = ${tx.json(quote as never)} where id = ${leadId}`;
    await logEvent(tx, 'lead', leadId, 'lead_priced', `Priced "${String(l.title).slice(0, 60)}" at ${d.priceMinor / 100} ${policy.currency}`, { basis: d.basis });
    await enqueue(tx, { type: 'lead.draft_outreach', key: `outreach:${leadId}`, role: 'sales_agent', entityType: 'lead', entityId: leadId,
      input: { lead_id: leadId }, priority: 60, title: `Draft outreach: ${String(l.title).slice(0, 80)}`, timeoutSeconds: 200 });
    return quote;
  });
};
