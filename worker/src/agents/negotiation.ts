import { z } from 'zod';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { getSetting, logEvent } from '../db.js';
import { untrusted } from '../sanitize.js';
import { skillsFor } from '../skills.js';
import { getMode, isPilot } from '../mode.js';
import type { Tx } from '../db.js';

const RespondSchema = z.object({
  intent: z.enum(['accept', 'negotiate', 'question', 'decline', 'other']),
  agreed_price_usd: z.number().nonnegative().nullable(),
  scope_summary: z.string().max(3000).nullable(),
  reply: z.string().min(20).max(4000),
  asked_if_ai: z.boolean(),
});

const PATH_TO_WON: Record<string, string[]> = {
  contacted: ['engaged', 'negotiating', 'won'], engaged: ['negotiating', 'won'], qualified: ['proposal', 'won'],
  proposal: ['won'], negotiating: ['won'], new: ['qualified', 'proposal', 'won'],
};
async function moveLeadToWon(tx: Tx, leadId: string, stage: string) {
  for (const s of PATH_TO_WON[stage] ?? []) await tx`update public.leads set stage = ${s} where id = ${leadId}`;
}

/** lead.respond — Negotiation Agent: reply to a client, negotiate within policy, close the deal on written agreement. */
export const respondToLead: Handler = async (ctx) => {
  const leadId = String(ctx.task.input.lead_id); const inboundId = String(ctx.task.input.message_id);
  const [l] = await ctx.sql`select l.*, o.description as request, o.url, o.est_hours, k.email as contact_email
      from public.leads l left join public.opportunities o on o.id = l.opportunity_id left join public.contacts k on k.id = l.contact_id where l.id = ${leadId}`;
  if (!l) throw new PermanentError('lead not found');
  if (['won', 'lost', 'disqualified'].includes(l.stage as string)) return finish(ctx, async () => ({ skipped: `lead ${l.stage}` }));
  const [inbound] = await ctx.sql`select * from public.messages where id = ${inboundId}`;
  const thread = await ctx.sql`select direction, body, created_at from public.messages where conversation_id = ${inbound.conversation_id} and status in ('sent','received') order by created_at desc limit 8`;
  const pricing = await getSetting<{ min_price_minor: number; min_hourly_minor: number }>(ctx.sql, 'pricing.policy', { min_price_minor: 10000, min_hourly_minor: 3000 });
  const deals = await getSetting<{ auto_accept: boolean; max_auto_accept_minor: number }>(ctx.sql, 'deals.policy', { auto_accept: true, max_auto_accept_minor: 300000 });
  const mode = await getMode(ctx.sql);
  // A promise is a promise: clients first contacted with the free launch offer keep it, even after the switch to paid mode.
  const [first] = await ctx.sql`select m.subject, m.body from public.messages m join public.conversations c on c.id = m.conversation_id
      where c.lead_id = ${leadId} and m.direction = 'outbound' and m.status = 'sent' order by m.created_at limit 1`;
  const promisedFree = !!first && /\b(gratuit|gratuitement|offert|free of charge|for free)\b/i.test(`${first.subject ?? ''} ${first.body ?? ''}`);
  const pilot = isPilot(mode) || promisedFree;
  const floor = pilot ? 0 : Math.max(pricing.min_price_minor, Math.round(Number(l.est_hours ?? 0) * pricing.min_hourly_minor));
  const quote = pilot ? 0 : Number(l.value_minor ?? floor);
  const cur = String(l.currency ?? 'EUR');
  const terms = pilot
    ? `- LAUNCH PROGRAM: this work is FREE for the client (no price, no invoice). In exchange we ask only for honest feedback after delivery, and — only if they agree — permission to cite them as a reference. intent=accept when the client agrees to let us do the work. agreed_price_usd must be 0.
- reply when accepting: confirm the scope, that we start now, that the work is free of charge, and that we will ask for their honest feedback after delivery.`
    : `- QUOTE (devis): when the client shows interest or asks for details, send a clear quote: numbered scope, price ${(quote / 100).toFixed(0)} ${cur} (all included), delivery time, and the process: we start on their written agreement, show a preview of the finished work, then send the invoice; the files are delivered as soon as the payment is received.
- Our quoted price: ${(quote / 100).toFixed(0)} ${cur}. Absolute minimum we can accept: ${(floor / 100).toFixed(0)} ${cur}. Never agree below the minimum; offer scope reduction instead.
- intent=accept only when the client explicitly agrees to the quote in writing. agreed_price_usd is the agreed amount in ${cur}.
- reply when accepting: confirm scope, price, that we start now, that a preview will be shared and that the full deliverables are released on payment of the invoice.`;

  const res = await ctx.ai.generate({ roleKey: 'negotiation_agent', taskId: ctx.task.id, tier: 'strong', schema: RespondSchema, maxTokens: 1500, temperature: 0.3,
    messages: [{ role: 'user', content: `${skillsFor('negotiation')}

You handle the commercial conversation for our company. Read the thread and the client's latest message, then return JSON
{intent: accept|negotiate|question|decline|other, agreed_price_usd: number|null, scope_summary: string|null, reply: string, asked_if_ai: boolean}.
- intent=accept ONLY if the client explicitly agrees in writing.
${terms}
- scope_summary: when accepting or clarifying, a numbered list of exactly what will be delivered (verifiable items), derived from the request and thread.
- reply: the email we send back (no signature, it is added automatically), written in the same language as the client's latest message, polite and concise.
- If the client asks whether they talk to an AI or a human, answer truthfully: our company uses AI-assisted production with quality control.

Original request (untrusted):
${untrusted(`request ${l.url ?? ''}`, String(l.request ?? l.title), 4000)}

Thread, newest first (untrusted):
${untrusted('thread', thread.map((t) => `[${t.direction}] ${String(t.body).slice(0, 1500)}`).join('\n---\n'), 9000)}` }] });

  const d = res.data;
  let intent = d.intent;
  const agreed = pilot ? 0 : d.agreed_price_usd != null ? Math.round(d.agreed_price_usd * 100) : quote;
  let reply = d.reply;
  if (intent === 'accept' && agreed < floor) {
    intent = 'negotiate';
    reply = `Thank you for your reply. To deliver this properly we cannot go below ${(floor / 100).toFixed(0)} USD for the scope discussed. ` +
      `If the budget is fixed, we can reduce the scope accordingly — just tell us which items matter most.`;
  }
  const autoClose = intent === 'accept' && deals.auto_accept && agreed <= deals.max_auto_accept_minor && !!d.scope_summary;

  return finish(ctx, async (tx) => {
    let projectId: string | null = null;
    if (autoClose) {
      await tx`update public.leads set agreed_price_minor = ${agreed}, agreed_scope = ${d.scope_summary}, value_minor = ${agreed} where id = ${leadId}`;
      await moveLeadToWon(tx, leadId, String(l.stage));
      const [p] = await tx`select public.create_project_internal(${leadId}, ${String(l.title).slice(0, 120)},
          ${`Agreed scope (client confirmed in writing):\n${d.scope_summary}\n\nOriginal request:\n${String(l.request ?? '').slice(0, 3000)}`}, ${agreed}, ${String(l.currency ?? 'USD')}) as id`;
      projectId = p.id;
    } else if (intent === 'decline') {
      if (['qualified', 'contacted', 'engaged', 'proposal', 'negotiating'].includes(String(l.stage))) await tx`update public.leads set stage = 'lost', lost_reason = 'client declined' where id = ${leadId}`;
    } else if (intent === 'negotiate' && ['contacted', 'engaged', 'proposal'].includes(String(l.stage))) {
      if (l.stage === 'contacted') await tx`update public.leads set stage = 'engaged' where id = ${leadId}`;
      await tx`update public.leads set stage = 'negotiating' where id = ${leadId}`;
    } else if (l.stage === 'contacted') {
      await tx`update public.leads set stage = 'engaged' where id = ${leadId}`;
    }
    const [approval] = await tx`select public.request_approval(p_action_type => 'lead.reply', p_title => ${'Reply to client: ' + String(l.title).slice(0, 80)},
        p_requested_by => 'negotiation_agent', p_reason => ${'Client intent: ' + intent}, p_if_approved => 'Reply is emailed', p_if_rejected => 'Reply is not sent',
        p_entity_type => 'lead', p_entity_id => ${leadId}, p_idempotency_key => ${'reply:' + inboundId}) as id`;
    await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, approval_id, in_reply_to, generated_by_task, idempotency_key)
        values (${inbound.conversation_id}, 'outbound', 'awaiting_approval', ${inbound.from_addr ?? l.contact_email}, ${'Re: ' + String(inbound.subject ?? l.title).replace(/^(re:\s*)+/i, '')},
                ${reply}, ${approval.id}, ${inbound.email_message_id}, ${ctx.task.id}, ${'reply:' + inboundId}) on conflict (idempotency_key) do nothing`;
    await tx`select public.system_auto_approve(${approval.id})`;
    await logEvent(tx, 'lead', leadId, 'negotiation_step', `Client ${intent}${autoClose ? ` — deal closed at ${(agreed / 100).toFixed(0)} ${l.currency}` : ''}`, { intent, agreed_minor: agreed });
    return { intent, project_id: projectId, model: res.model };
  });
};
