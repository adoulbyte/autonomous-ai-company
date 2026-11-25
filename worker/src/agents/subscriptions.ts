import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { untrusted } from '../sanitize.js';
import { skillsFor } from '../skills.js';
import { getSetting, logEvent, type Sql, type Tx } from '../db.js';
import { autoApproveIfPolicy, enqueue, requestApproval } from '../queue.js';
import { identity } from './comms.js';
import { renderHtml } from '../email/template.js';
import { subscriptionCta } from '../email/cta.js';
import { findPhotos, tradeProfile } from '../render/photos.js';
import { factsFromListing, PostContentSchema, renderPost, type PostContent } from '../render/site.js';
import { screenshotHtml } from '../render/screenshot.js';
import type { Design } from '../render/edit.js';
import type { AiGateway } from '../ai/gateway.js';

/**
 * Monthly subscriptions (recurring revenue): after a delivery, the client is offered a monthly pack of social-media visuals
 * made for their business. Each month is a small project through the usual circuit (production → double QA → invoice validated
 * by the owner → payment confirmed by the owner → delivery). An unpaid month pauses the subscription; one click stops it.
 */
export type Plan = { label: Record<string, string>; price_minor: number; posts: number; offer_after_days: number };
export async function getPlans(sql: Sql | Tx): Promise<Record<string, Plan>> {
  return getSetting<Record<string, Plan>>(sql, 'pricing.subscriptions', {
    social_monthly: { label: { fr: 'Pack visuels mensuel (4 visuels par mois)', en: 'Monthly visuals pack (4 visuals a month)' }, price_minor: 1900, posts: 4, offer_after_days: 3 } });
}
const LANG: Record<string, string> = { fr: 'French', en: 'English', nl: 'Dutch', pt: 'Portuguese' };
const euros = (minor: number, cur = 'EUR') => `${(minor / 100).toFixed(0)} ${cur === 'EUR' ? '€' : cur}`;

type LeadInfo = { id: string; listing: string; name: string; email: string | null; lang: string; category?: string; city?: string; dnc: boolean };
async function leadInfo(sql: Sql | Tx, leadId: string): Promise<LeadInfo | null> {
  const [l] = await sql`select l.id, o.description as listing, o.buyer_name, o.analysis, k.email, coalesce(k.do_not_contact, false) as dnc
      from public.leads l left join public.opportunities o on o.id = l.opportunity_id left join public.contacts k on k.id = l.contact_id where l.id = ${leadId}`;
  if (!l) return null;
  const a = (l.analysis ?? {}) as { language?: string; category?: string; city?: string };
  return { id: String(l.id), listing: String(l.listing ?? ''), name: String(l.buyer_name ?? ''), email: l.email ?? null, lang: a.language ?? 'fr', category: a.category, city: a.city, dnc: !!l.dnc };
}

/** One social-media visual for this business (AI writes the texts, a real photo of the trade, our designed template). */
export async function socialPostHtml(o: { ai: Pick<AiGateway, 'generate'>; taskId?: string; env: NodeJS.ProcessEnv; fetchFn?: typeof fetch; lead: LeadInfo;
  index: number; theme: string; avoid: string[]; feedback?: string[] }): Promise<{ html: string; content: PostContent; model: string; design: Design }> {
  const { lead } = o; const profile = tradeProfile(lead.category);
  const res = await o.ai.generate({ roleKey: 'specialist_worker', taskId: o.taskId, tier: 'standard', allowDowngrade: true, schema: PostContentSchema, maxTokens: 1200, temperature: 0.7,
    messages: [{ role: 'user', content: `${skillsFor('production', 'design visual social post copywriting')}
Write the texts of ONE social-media post (square visual) for this local business, ready to publish. Theme of this post: ${o.theme}.
Language: ${LANG[lead.lang] ?? 'English'} (photo_keywords in English). Use ONLY facts from the listing; never invent prices, promotions, reviews, awards or opening hours.
Make it concrete for the trade (${lead.category ?? ''}) and the city (${lead.city ?? ''}); different from these previous posts: ${JSON.stringify(o.avoid.slice(-8))}.
Return JSON {headline (max 7 words), text (one sentence), bullets (2-3 very short benefits), cta (short), photo_keywords (2-4 English stock-photo searches)}.
${o.feedback?.length ? `A quality reviewer asked for these corrections — apply ALL of them:\n${o.feedback.map((f) => `- ${f}`).join('\n')}\n` : ''}
${untrusted('business-listing', lead.listing, 2500)}` }] });
  const photos = await findPhotos([...new Set([...res.data.photo_keywords, ...profile.queries])], 6, o.env, o.fetchFn);
  const pick = photos.length ? [photos[o.index % photos.length]] : [];
  const facts = factsFromListing(lead.listing, lead.name, lead.city, lead.email);
  const design: Design = { kind: 'post', content: res.data as Record<string, unknown>, facts, photos: pick, theme: profile.theme, lang: lead.lang };
  return { html: renderPost(res.data, facts, pick, profile.theme, lead.lang), content: res.data, model: res.model, design };
}

const THEMES = ['what makes this business special (its know-how)', 'a typical product or service, shown appetisingly', 'an invitation to visit or to get in touch',
  'a practical tip related to the trade', 'the people and the welcome (without names)', 'a seasonal idea for this month'];

const OFFER: Record<string, (name: string, label: string, price: string) => string> = {
  fr: (n, l, p) => `Bonjour,\n\nMerci encore pour votre confiance. Pour que vos clients vous voient régulièrement sur les réseaux sociaux, nous proposons un pack simple : ${l.toLowerCase()}, prêts à publier, à vos couleurs et adaptés à votre activité, pour ${p} par mois.\n\nSans engagement : chaque mois, vous ne payez qu’une fois les visuels prêts, et vous arrêtez quand vous voulez, en un clic.\n\nVoici un exemple préparé pour ${n} (ci-dessous).`,
  en: (n, l, p) => `Hello,\n\nThank you again for your trust. To help your customers see you regularly on social media, we offer a simple pack: ${l.toLowerCase()}, ready to post, in your colours and adapted to your business, for ${p} a month.\n\nNo commitment: each month you only pay once the visuals are ready, and you can stop whenever you like, in one click.\n\nHere is an example prepared for ${n} (below).`,
  nl: (n, l, p) => `Goedendag,\n\nNogmaals bedankt voor uw vertrouwen. Om uw klanten u regelmatig op sociale media te laten zien, bieden we een eenvoudig pakket: ${l.toLowerCase()}, klaar om te posten, in uw kleuren, voor ${p} per maand.\n\nZonder verplichting: u betaalt elke maand pas als de visuals klaar zijn, en u stopt wanneer u wilt, met één klik.\n\nHieronder een voorbeeld voor ${n}.`,
  pt: (n, l, p) => `Olá,\n\nObrigado mais uma vez pela sua confiança. Para que os seus clientes o vejam regularmente nas redes sociais, propomos um pack simples: ${l.toLowerCase()}, prontos a publicar, com as suas cores, por ${p} por mês.\n\nSem compromisso: paga cada mês só quando os visuais estão prontos e pode parar quando quiser, com um clique.\n\nEis um exemplo preparado para ${n} (abaixo).`,
};

/** subscription.offer — a few days after a delivery: the monthly pack, with a sample visual made for the client. */
export const offerSubscription: Handler = async (ctx) => {
  const leadId = String(ctx.task.input.lead_id);
  const lead = await leadInfo(ctx.sql, leadId);
  if (!lead) throw new PermanentError('lead not found');
  const [already] = await ctx.sql`select 1 from public.subscriptions where lead_id = ${leadId}`;
  if (already || lead.dnc || !lead.email) return finish(ctx, async () => ({ skipped: already ? 'already subscribed' : 'not contactable' }));
  const plans = await getPlans(ctx.sql); const plan = plans.social_monthly;
  if (!plan) return finish(ctx, async () => ({ skipped: 'no plan configured' }));
  let sample: { html: string; model: string } | null = null;
  try { sample = await socialPostHtml({ ai: ctx.ai, taskId: ctx.task.id, env: ctx.env, fetchFn: ctx.fetchFn, lead, index: 0, theme: THEMES[0], avoid: [] }); }
  catch { sample = null; }   // the offer still goes out, without the example
  const shot = sample ? await screenshotHtml(sample.html, ctx.env, 'post') : null;
  const id = await identity(ctx.sql);
  const label = plan.label[lead.lang] ?? plan.label.en ?? ''; const price = euros(plan.price_minor);
  const body = (OFFER[lead.lang] ?? OFFER.en)(lead.name, label, price);
  const img = shot ? `<div style="margin:6px 0 18px"><img src="cid:sample-post" alt="" width="300" style="display:block;width:300px;max-width:100%;border:1px solid #e7e4dd;border-radius:10px"></div>` : '';
  const html = renderHtml(body, id, { preheader: label, blocks: img, cta: subscriptionCta(ctx.mail?.address ?? '', lead.lang, price) });
  return finish(ctx, async (tx) => {
    const [conv] = await tx`insert into public.conversations(lead_id, contact_id, channel, subject)
        values (${leadId}, (select contact_id from public.leads where id = ${leadId}), 'email', ${label}) returning id`;
    const [out] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, html, attachments, generated_by_task, idempotency_key)
        values (${conv.id}, 'outbound', 'draft', ${lead.email}, ${label}, ${body}, ${html},
          ${tx.json((shot ? [{ filename: 'exemple.jpg', content_b64: shot.desktop.toString('base64'), contentType: 'image/jpeg', cid: 'sample-post' }] : []) as never)},
          ${ctx.task.id}, ${'sub-offer:' + leadId}) on conflict (idempotency_key) do nothing returning id`;
    if (!out) return { skipped: 'already offered' };
    const approvalId = await requestApproval(tx, { actionType: 'message.send', title: `Offre d’abonnement : ${lead.name.slice(0, 80)}`, requestedBy: 'sales_agent',
      reason: 'Delivered client: monthly pack offer with a sample visual.', riskLevel: 'low', ifApproved: 'The offer is emailed.', ifRejected: 'Nothing is sent.',
      entityType: 'message', entityId: out.id, taskId: ctx.task.id, key: `message.send:${out.id}`, payload: { message_id: out.id } });
    await tx`update public.messages set status = 'awaiting_approval', approval_id = ${approvalId} where id = ${out.id}`;
    await autoApproveIfPolicy(tx, approvalId);
    await tx`update public.leads set quote = coalesce(quote, '{}'::jsonb) || ${tx.json({ subscription_offered_at: new Date().toISOString() } as never)} where id = ${leadId}`;
    return { offered: true, sample: !!shot };
  });
};

/** The client clicked "subscribe": the subscription starts now (first month produced at the next cycle). */
export async function startSubscription(tx: Tx, leadId: string): Promise<void> {
  const plans = await getPlans(tx); const plan = plans.social_monthly; if (!plan) return;
  await tx`insert into public.subscriptions(lead_id, plan_key, price_minor, currency, status, next_cycle_at)
      values (${leadId}, 'social_monthly', ${plan.price_minor}, 'EUR', 'active', now())
      on conflict (lead_id, plan_key) do update set status = 'active', cancelled_at = null, paused_reason = null, next_cycle_at = least(public.subscriptions.next_cycle_at, now())`;
  await logEvent(tx, 'lead', leadId, 'subscription_started', `New monthly subscription (${euros(plan.price_minor)}/month)`);
}
export async function stopSubscriptions(tx: Tx, leadId: string, reason: string): Promise<void> {
  await tx`update public.subscriptions set status = 'cancelled', cancelled_at = now(), paused_reason = ${reason} where lead_id = ${leadId} and status <> 'cancelled'`;
}

const MONTH = (d: Date, lang: string) => d.toLocaleDateString(({ fr: 'fr-FR', nl: 'nl-NL', pt: 'pt-PT' } as Record<string, string>)[lang] ?? 'en-GB', { month: 'long', year: 'numeric' });

/** subscription.cycle — one month of an active subscription: a small project with N visuals, through the usual circuit. */
export const subscriptionCycle: Handler = async (ctx) => {
  const subId = String(ctx.task.input.subscription_id);
  const [s] = await ctx.sql`select * from public.subscriptions where id = ${subId}`;
  if (!s || s.status !== 'active') return finish(ctx, async () => ({ skipped: `subscription ${s?.status ?? 'missing'}` }));
  const lead = await leadInfo(ctx.sql, String(s.lead_id));
  const plans = await getPlans(ctx.sql); const plan = plans[String(s.plan_key)];
  const [prev] = await ctx.sql`select id, public.project_is_paid(id) as paid, status from public.projects where subscription_id = ${subId} order by cycle desc nulls last limit 1`;
  return finish(ctx, async (tx) => {
    if (!lead || lead.dnc || !plan) { await stopSubscriptions(tx, String(s.lead_id), 'client not contactable'); return { stopped: true }; }
    // No payment, no next month: the subscription pauses until the previous month is paid.
    if (prev && !prev.paid && prev.status !== 'cancelled') {
      await tx`update public.subscriptions set status = 'paused', paused_reason = 'previous month not paid yet' where id = ${subId}`;
      await logEvent(tx, 'subscription', subId, 'subscription_paused', `Subscription paused: previous month not paid (${lead.name})`, {}, 'warning');
      return { paused: true };
    }
    const cycle = Number(s.cycles) + 1;
    const month = MONTH(new Date(), lead.lang);
    const name = `${(plan.label.fr ?? 'Pack visuels').replace(/\s*\(.*\)$/, '')} — ${month} — ${lead.name}`.slice(0, 120);
    const [first] = await tx`select client_id, opportunity_id from public.projects where lead_id = ${s.lead_id} order by created_at limit 1`;
    const [p] = await tx`insert into public.projects(opportunity_id, lead_id, client_id, name, scope, budget_minor, currency, subscription_id, cycle)
        values (${first?.opportunity_id ?? null}, ${s.lead_id}, ${first?.client_id ?? null}, ${name},
          ${`Monthly subscription, month ${cycle}: ${plan.posts} social-media visuals ready to post for ${lead.name} (${lead.category ?? ''}, ${lead.city ?? ''}).`},
          ${s.price_minor}, ${s.currency}, ${subId}, ${cycle}) returning id`;
    const plan_ = {
      summary: `${plan.posts} visuels pour ${month}`, out_of_scope: [],
      requirements: [{ description: `${plan.posts} social-media visuals for ${lead.name}, ready to post`, acceptance_criteria: [
        'Each visual shows the business name', `All texts are in correct ${LANG[lead.lang] ?? 'English'} without spelling mistakes`,
        'No invented facts (prices, promotions, reviews, awards, opening hours)', 'Each visual has a different message from the others'] }],
      work_items: Array.from({ length: plan.posts }, (_, i) => ({ key: `post-${i + 1}`, title: `Visuel ${i + 1} — ${month}`, requirement_index: 0, format: 'social',
        instructions: `Visual ${i + 1} of ${plan.posts}. Theme: ${THEMES[(cycle * plan.posts + i) % THEMES.length]}.` })),
    };
    await tx`insert into public.requirements(project_id, position, description, acceptance_criteria) values (${p.id}, 0, ${plan_.requirements[0].description}, ${plan_.requirements[0].acceptance_criteria})`;
    await tx`update public.projects set plan = ${tx.json(plan_ as never)}, summary = ${plan_.summary}, status = 'in_progress' where id = ${p.id}`;
    for (const w of plan_.work_items) await enqueue(tx, { type: 'production.execute', key: `produce:${p.id}:${w.key}:v1`, role: 'specialist_worker', entityType: 'project', entityId: p.id,
      input: { project_id: p.id, work_item: w.key, version: 1 }, priority: 55, title: `Produce: ${w.title.slice(0, 80)}`, timeoutSeconds: 300 });
    await tx`update public.subscriptions set cycles = ${cycle}, next_cycle_at = next_cycle_at + interval '1 month' where id = ${subId}`;
    await logEvent(tx, 'subscription', subId, 'subscription_cycle', `Month ${cycle} started for ${lead.name}`);
    return { project_id: p.id, cycle };
  });
};

/** Production of one visual of a subscription month (called by production.execute for format "social"). */
export async function produceSocialDeliverable(ctx: Parameters<Handler>[0], project: Record<string, unknown>, item: { key: string; title: string; instructions: string }, feedback?: string[]) {
  const lead = await leadInfo(ctx.sql, String(project.lead_id));
  if (!lead) throw new PermanentError('lead not found');
  const previous = await ctx.sql`select d.content from public.deliverables d join public.projects p on p.id = d.project_id
      where p.subscription_id = ${project.subscription_id ?? null} and d.format = 'social' order by d.created_at desc limit 12`;
  const avoid = previous.map((d) => String(d.content).match(/<h1>([^<]*)<\/h1>/)?.[1] ?? '').filter(Boolean);
  const index = Number(item.key.replace(/\D/g, '') || 1) - 1 + Number(project.cycle ?? 0) * 4;
  const theme = item.instructions.match(/Theme: ([^.]+)/)?.[1] ?? THEMES[index % THEMES.length];
  const r = await socialPostHtml({ ai: ctx.ai, taskId: ctx.task.id, env: ctx.env, fetchFn: ctx.fetchFn, lead, index, theme, avoid, feedback });
  return { model: r.model, design: r.design, data: { title: item.title, content: r.html, notes: `Headline: ${r.content.headline}`, limitations: [] as string[] } };
}

