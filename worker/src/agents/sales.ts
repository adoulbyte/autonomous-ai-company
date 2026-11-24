import { z } from 'zod';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { detectInjection, untrusted } from '../sanitize.js';
import { getSetting, logEvent } from '../db.js';
import { skillsFor } from '../skills.js';
import { getMode, isPilot } from '../mode.js';
import { autoApproveIfPolicy, enqueue, requestApproval } from '../queue.js';

const EmailReviewSchema = z.object({ score: z.number().min(0).max(10), issues: z.array(z.string().max(300)).max(10), verdict: z.enum(['send', 'rewrite']) });

const OutreachSchema = z.object({
  subject: z.string().min(3).max(160),
  body: z.string().min(80).max(4000),
  claims_made: z.array(z.string().max(200)).max(10),
  questions_for_buyer: z.array(z.string().max(300)).max(6),
});

/** Phrases that would misrepresent the business. Drafts containing them are rejected deterministically. */
const FORBIDDEN = [
  /\b\d+\+?\s*years? of experience\b/i, /\bour (happy |satisfied )?clients include\b/i, /\btestimonial/i,
  /\bguarantee(d)? (results|success|ranking)/i, /\b(as|I am) a (senior|human) (developer|engineer|consultant)\b/i,
  /\baward[- ]winning\b/i, /\btrusted by\b/i, /\blimited time\b/i, /\bact now\b/i,
];
/** Classic spam-filter triggers in a cold email (subject words, links, shouting). */
export function spamSignals(subject: string, body: string): string[] {
  const v: string[] = [];
  if (/\b(free|gratuit|gratuite|offert|offerte|gratis|promo|discount|urgent|winner|100 ?%)\b|[€$%!]/i.test(subject)) v.push('spam-trigger word or symbol in the subject');
  if (subject.length > 70 || /[A-Z]{5,}/.test(subject)) v.push('subject too long or shouting');
  if (/https?:\/\/|www\./i.test(body)) v.push('links in a first-contact email');
  if ((body.match(/!/g) ?? []).length > 1) v.push('exclamation marks');
  return v;
}

export function outreachViolations(body: string, disclosure: string): string[] {
  const v = FORBIDDEN.filter((p) => p.test(body)).map((p) => `forbidden claim pattern ${p}`);
  if (disclosure && !body.includes(disclosure.slice(0, 30))) v.push('missing AI-assistance disclosure');
  return v;
}

export const draftOutreach: Handler = async (ctx) => {
  const leadId = String(ctx.task.input.lead_id);
  const [lead] = await ctx.sql`select l.*, o.url as opp_url, o.title as opp_title, o.analysis, o.source_key, c.email as contact_email,
      c.handle as contact_handle, c.do_not_contact, co.name as company_name
    from public.leads l left join public.opportunities o on o.id = l.opportunity_id
    left join public.contacts c on c.id = l.contact_id left join public.companies co on co.id = l.company_id where l.id = ${leadId}`;
  if (!lead) throw new PermanentError('lead not found');
  if (lead.do_not_contact) throw new PermanentError('contact is marked do-not-contact');
  const existing = await ctx.sql`select m.id from public.messages m join public.conversations cv on cv.id = m.conversation_id
      where cv.lead_id = ${leadId} and m.direction = 'outbound' and m.status <> 'rejected' limit 1`;
  if (existing.length) return finish(ctx, async () => ({ skipped: 'outreach draft already exists', message_id: existing[0].id }));

  const evidence = await ctx.sql`select e.excerpt, e.url from public.evidence e join public.opportunity_evidence oe on oe.evidence_id = e.id
      where oe.opportunity_id = ${lead.opportunity_id} order by e.fetched_at desc limit 1`;
  const profile = await getSetting<{ name: string; positioning: string; skills: string[]; disclosure: string }>(ctx.sql, 'business.profile', {} as never);
  const mode = await getMode(ctx.sql);
  const offerTerms = isPilot(mode)
    ? `Offer (trusted): as part of our launch program we will do this work FREE OF CHARGE, with the same quality standards (independent double quality review). In exchange we only ask for honest feedback once it is delivered — and, only if they agree, permission to mention them as a reference. Make clear there is no obligation and no hidden cost. Do not mention a price. If the request leaves important points open (scope, format, access, deadline), ask at most 3 short, precise questions so the work can start right away.`
    : `Our price for this work (trusted, set by our market analysis): ${lead.value_minor ? (Number(lead.value_minor) / 100).toFixed(0) + ' ' + lead.currency : 'to be confirmed after scoping'}.
Payment terms (trusted): the work is fully produced and quality-checked first; deliverables are released once the invoice is paid.`;

  const prompt = `${skillsFor('sales')}

Write a first reply to a public request for paid work. Return JSON: {subject, body, claims_made: string[], questions_for_buyer: string[]}.
Rules (mandatory):
- Reference the buyer's actual request specifically; propose a concrete first step and ask 1-3 clarifying questions.
- Honest only: do NOT claim years of experience, past clients, testimonials, awards, certifications or a portfolio. Do NOT pretend to be a human individual.
- No pressure tactics or urgency. 120-220 words. Plain text, no markdown.
- claims_made lists every factual claim you make about our company.

Our company (trusted): ${JSON.stringify({ name: profile.name, positioning: profile.positioning, skills: profile.skills })}
${offerTerms}
Analyst summary (trusted, generated by our system): ${JSON.stringify((lead.analysis as Record<string, unknown> | null)?.rationale ?? '')}

${untrusted(`buyer-request ${evidence[0]?.url ?? lead.opp_url}`, String(evidence[0]?.excerpt ?? lead.opp_title), 5000)}`;

  const a = (lead.analysis ?? {}) as { prospect?: boolean; need?: string; language?: string; category?: string; city?: string; website?: string | null };
  const isProspect = a.prospect === true;
  const lang = ({ fr: 'French', en: 'English', nl: 'Dutch', pt: 'Portuguese' } as Record<string, string>)[a.language ?? 'fr'] ?? 'English';
  const optOut = ({ French: 'Si vous ne souhaitez plus recevoir de message de notre part, répondez simplement STOP.', English: 'If you prefer not to hear from us again, just reply STOP.',
    Dutch: 'Wilt u geen berichten meer van ons ontvangen? Antwoord dan gewoon STOP.', Portuguese: 'Se preferir não receber mais mensagens nossas, basta responder STOP.' } as Record<string, string>)[lang];
  const prospectPrompt = `${skillsFor('sales')}

Write a short, warm, professional first email (B2B prospecting) to a local business that we have never spoken to. Language: ${lang}.
Return JSON: {subject, body, claims_made: string[], questions_for_buyer: string[]}.
Context (trusted): the business published this professional email address publicly (OpenStreetMap / their listing). Mention that briefly and honestly.
What we propose (trusted): ${a.need === 'website'
    ? `a simple, modern showcase website (presentation, services, opening hours, contact, map), mobile friendly, ready in a few days. They have no website listed.`
    : `one quick, useful deliverable for their activity, chosen to fit their trade: e.g. ad scripts for social media, a flyer or menu as PDF, a price list or planning in Excel, simple visuals. They already have a website (${a.website ?? ''}).`}
${isPilot(mode) ? `Offer (trusted): we are launching our studio, so we do it FREE OF CHARGE, with no obligation, in exchange for an honest review once delivered. We show a preview first.`
    : `Offer (trusted): describe concretely what we would create for THIS business (e.g. the sections of their site, or 2-3 ad ideas adapted to their trade) as a short example of our approach.
Then: free quote with no obligation on simple reply; they see a preview of the finished work before receiving the invoice; files delivered on payment. Do NOT state a price in this first email.`}
Rules (mandatory):
- 90-150 words, plain text, no markdown, polite (${lang === 'French' ? '"vous"' : lang === 'Dutch' ? '"u"' : 'formal'}). Personalise with the business name, its trade (${a.category ?? ''}) and city (${a.city ?? ''}).
- One clear next step: reply "oui" / "yes" to start, or ask one simple question (e.g. which services to highlight).
- Honest only: no years of experience, past clients, testimonials, awards or portfolio. Do NOT pretend to be a human individual.
- No pressure or urgency. End the body with this exact opt-out sentence: "${optOut}"
- Deliverability (mandatory): no links, no attachments, no prices, no ALL CAPS, no exclamation marks, no emojis; the subject is short (max 7 words), natural and
  personal, and must NOT contain words like free/gratuit/offert/gratis/promo/offer/discount/urgent/%/€.
- claims_made lists every factual claim you make about our company.

Our company (trusted): ${JSON.stringify({ name: profile.name, positioning: profile.positioning })}
${untrusted(`business-listing ${lead.opp_url}`, String(evidence[0]?.excerpt ?? lead.opp_title), 2000)}`;
  const reviewFocus = isProspect
    ? `relevance and personalisation for this business, ${lang} language quality, professionalism and warmth, honesty (no invented claims), presence of the opt-out sentence, and a clear single next step`
    : `relevance to the client's request, professionalism and tone, clarity and concision, honesty (no invented claims), and a clear next step`;
  const basePrompt = isProspect ? prospectPrompt : prompt;
  let res = await ctx.ai.generate({ roleKey: 'sales_agent', taskId: ctx.task.id, tier: 'standard', schema: OutreachSchema,
    messages: [{ role: 'user', content: basePrompt }], maxTokens: 900, temperature: 0.4 });
  // Independent quality review of the email before it can be sent; one rewrite if it is not excellent.
  for (let round = 0; round < 2; round++) {
    const review = await ctx.ai.generate({ roleKey: 'qa_reviewer', taskId: ctx.task.id, tier: 'standard', schema: EmailReviewSchema, maxTokens: 500, temperature: 0,
      avoidModel: res.model, messages: [{ role: 'user', content: `${isProspect ? 'Context: a short first-contact email to a local business (no quote, no contract terms at this stage; the offer is free in exchange for an honest review).' : skillsFor('sales')}

Review this outreach email as a demanding senior account manager. Score 1-10 for: ${reviewFocus}. Return JSON {score, issues: string[], verdict: "send"|"rewrite"}.
Verdict "send" only if score >= ${isProspect ? 7 : 8} and no honesty issue.
Subject: ${res.data.subject}
${untrusted('email-draft', res.data.body, 4000)}
${untrusted(isProspect ? 'business-listing' : 'client-request', String(evidence[0]?.excerpt ?? lead.opp_title), 2500)}` }] });
    if (review.data.score >= (isProspect ? 7 : 8) && (review.data.verdict === 'send' || isProspect)) break;
    if (round === 1) throw new Error(`outreach draft below quality bar after rewrite (score ${review.data.score}): ${review.data.issues.join('; ')}`);
    res = await ctx.ai.generate({ roleKey: 'sales_agent', taskId: ctx.task.id, tier: 'standard', schema: OutreachSchema, maxTokens: 900, temperature: 0.3,
      messages: [{ role: 'user', content: `${basePrompt}\n\nA reviewer rejected your previous draft. Fix every issue:\n${review.data.issues.map((i) => `- ${i}`).join('\n')}\n\nPrevious draft:\n${res.data.body}` }] });
  }
  const body = res.data.body.trim();   // signature + AI disclosure are appended by the email template
  const violations = outreachViolations(`${body}\n${profile.disclosure}`, profile.disclosure);
  if (isProspect) violations.push(...spamSignals(res.data.subject, body));
  if (violations.length) throw new Error(`draft rejected by compliance gate: ${violations.join('; ')}`); // retryable: new draft
  const to = lead.contact_email ?? lead.contact_handle ?? lead.opp_url;

  return finish(ctx, async (tx) => {
    const [conv] = await tx`insert into public.conversations(lead_id, company_id, contact_id, channel, subject)
        values (${leadId}, ${lead.company_id}, ${lead.contact_id}, ${lead.contact_email ? 'email' : 'platform'}, ${res.data.subject}) returning id`;
    const [msg] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, generated_by_task, idempotency_key,
          classification)
        values (${conv.id}, 'outbound', 'draft', ${to}, ${res.data.subject}, ${body}, ${ctx.task.id}, ${'outreach:' + leadId},
          ${tx.json({ claims_made: res.data.claims_made, questions: res.data.questions_for_buyer, model: res.model } as never)}) returning id`;
    const approvalId = await requestApproval(tx, {
      actionType: 'message.send', title: `Send first message: ${String(lead.title).slice(0, 90)}`, requestedBy: 'sales_agent',
      reason: isProspect ? `Prospecting: ${lead.title}. The business published this professional email address.` : `Lead "${lead.title}" was approved for pursuit. This is the first reply to the buyer's public request.`,
      evidence: [{ type: 'url', value: lead.opp_url }, { type: 'claims', value: res.data.claims_made }],
      expectedBenefit: `Opens a conversation for a lead valued at ${lead.value_minor ? (Number(lead.value_minor) / 100).toFixed(0) + ' ' + lead.currency : 'an unknown amount'}.`,
      risk: 'External communication under your business identity. Check tone, accuracy and that the recipient published this contact channel.',
      riskLevel: 'medium', entityType: 'message', entityId: msg.id, taskId: ctx.task.id, key: `message.send:${msg.id}`,
      ifApproved: lead.contact_email ? `The email is sent automatically from the company mailbox to ${lead.contact_email} at the next cycle; the lead moves to Contacted and follow-ups are scheduled.` : `No email address: the message targets ${to} and cannot be sent automatically.`,
      ifRejected: 'Message is discarded; the lead stays Qualified. You can edit and resubmit a draft from Communications.',
      payload: { message_id: msg.id },
    });
    await tx`update public.messages set status = 'awaiting_approval', approval_id = ${approvalId} where id = ${msg.id}`;
    const auto = await autoApproveIfPolicy(tx, approvalId);
    return { message_id: msg.id, approval_id: approvalId, auto_approved: auto, model: res.model };
  });
};

/** Bounce = the address does not exist; autoreply = out-of-office. Both are machine-generated. */
export function classifyAutomated(from: string, subject: string, body: string): 'bounce' | 'autoreply' | null {
  const f = from.toLowerCase(); const s = subject.toLowerCase();
  if (/mailer-daemon|postmaster|mail delivery (sub)?system/.test(f) || /(undeliverable|undelivered|delivery status notification|delivery has failed|mail delivery failed|returned mail|non remis|non distribu|échec de (la )?(remise|distribution)|adresse introuvable)/.test(s)) return 'bounce';
  if (/(automatic reply|auto(matic)?[- ]?reply|réponse automatique|absence|out of office|en congé|congés)/.test(s) || /^(no-?reply|noreply)@/.test(f) || /\bauto-submitted:\s*auto/i.test(body)) return 'autoreply';
  return null;
}

const TriageSchema = z.object({
  category: z.enum(['client', 'prospect_reply', 'opportunity', 'billing', 'spam', 'vendor', 'legal', 'other']),
  intent: z.enum(['positive', 'neutral', 'negative', 'question', 'unsubscribe', 'not_applicable']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  summary: z.string().max(600),
  reply_draft: z.string().max(3000).nullable(),
});

/** comms.triage — Client Communication Agent: classify inbound and draft (never send) a reply. */
export const triageMessage: Handler = async (ctx) => {
  const id = String(ctx.task.input.message_id);
  const [m] = await ctx.sql`select m.*, c.lead_id, c.project_id, pr.status as project_status from public.messages m join public.conversations c on c.id = m.conversation_id
      left join public.projects pr on pr.id = c.project_id where m.id = ${id}`;
  if (!m) throw new PermanentError('message not found');
  if (m.classification) return finish(ctx, async () => ({ skipped: 'already classified' }));
  const injection = detectInjection(`${m.subject ?? ''}\n${m.body}`);
  const profile = await getSetting<{ disclosure: string }>(ctx.sql, 'business.profile', {} as never);
  // Automated messages (bounces, out-of-office) are never treated as a client reply and never answered.
  const auto = classifyAutomated(String(m.from_addr ?? ''), String(m.subject ?? ''), String(m.body ?? ''));
  if (auto) return finish(ctx, async (tx) => {
    await tx`update public.messages set classification = ${tx.json({ category: 'other', intent: 'not_applicable', priority: 'low', summary: auto === 'bounce' ? 'Delivery failure (address does not exist)' : 'Automatic reply (out of office)', automated: auto } as never)} where id = ${id}`;
    if (auto === 'bounce' && m.lead_id) {
      // The published address does not work: stop contacting it and close the lead.
      await tx`update public.contacts set do_not_contact = true where id = (select contact_id from public.leads where id = ${m.lead_id})`;
      await tx`update public.leads set stage = 'lost', lost_reason = 'email bounced', next_follow_up_at = null where id = ${m.lead_id} and stage not in ('won','lost','disqualified')`;
    }
    return { automated: auto };
  });
  // A plain STOP / unsubscribe reply is always honoured, without depending on any AI model.
  const optOut = /^\s*(stop|unsubscribe|remove me|d[ée]sabonn|d[ée]sinscri|ne plus (me )?(contacter|recevoir)|afmelden|uitschrijven|cancelar|remover|n[ãa]o quero)/i.test(String(m.body));
  const res = optOut
    ? { model: 'rule:opt-out', data: { category: 'prospect_reply', intent: 'unsubscribe', priority: 'normal', summary: 'Opt-out request (STOP)', reply_draft: null } as z.infer<typeof TriageSchema> }
    : await ctx.ai.generate({ roleKey: 'communications', taskId: ctx.task.id, tier: 'fast', allowDowngrade: true, schema: TriageSchema,
    messages: [{ role: 'user', content: `Classify this inbound message and, if a reply is appropriate, draft a short honest reply ending with "${profile.disclosure}".
Return JSON {category, intent, priority, summary, reply_draft|null}.\n\n${untrusted('inbound-message', `Subject: ${m.subject ?? ''}\nFrom: ${m.from_addr ?? ''}\n\n${m.body}`, 6000)}` }],
    maxTokens: 900 });
  const d = res.data;
  return finish(ctx, async (tx) => {
    await tx`update public.messages set classification = ${tx.json({ ...d, model: res.model } as never)}, priority = ${injection ? 'high' : d.priority},
        injection_suspected = ${injection} where id = ${id}`;
    if (d.intent === 'unsubscribe' && m.from_addr) {
      // Opt-out is permanent, whichever conversation it arrives in.
      await tx`update public.contacts set do_not_contact = true where lower(email) = lower(${m.from_addr})`;
      await tx`update public.leads set stage = 'lost', lost_reason = 'unsubscribed' where stage in ('contacted','engaged','proposal','negotiating','qualified','new')
          and contact_id in (select id from public.contacts where lower(email) = lower(${m.from_addr}))`;
      await logEvent(tx, 'message', id, 'unsubscribed', `${m.from_addr} asked not to be contacted again: honoured permanently`);
    } else if (injection) {
      await logEvent(tx, 'message', id, 'injection_suspected', `Inbound message from ${m.from_addr ?? 'unknown'} looks like a prompt-injection attempt — no automatic reply`, {}, 'warning');
    } else if (m.project_status && ['delivered', 'accepted', 'revision', 'ready_for_delivery'].includes(m.project_status) && d.category !== 'spam') {
      await enqueue(tx, { type: 'feedback.capture', key: `feedback:${id}`, role: 'customer_success', entityType: 'project', entityId: String(m.project_id),
        input: { message_id: id, project_id: m.project_id }, priority: 84, title: `Client feedback: ${String(m.subject ?? '').slice(0, 70)}` });
    } else if (m.lead_id && d.category !== 'spam' && d.intent !== 'not_applicable' && ['prospect_reply', 'client', 'opportunity', 'billing'].includes(d.category)) {
      // Only a real reply from the prospect reaches the Negotiation Agent (the triage verdict decides).
      if (d.intent === 'unsubscribe') {
        await tx`update public.contacts set do_not_contact = true where id = (select contact_id from public.leads where id = ${m.lead_id})`;
        const [lead] = await tx`select stage from public.leads where id = ${m.lead_id}`;
        if (['contacted', 'engaged', 'proposal', 'negotiating', 'qualified'].includes(lead?.stage)) await tx`update public.leads set stage = 'lost', lost_reason = 'unsubscribed' where id = ${m.lead_id}`;
      } else {
        await enqueue(tx, { type: 'lead.respond', key: `respond:${id}`, role: 'negotiation_agent', entityType: 'lead', entityId: String(m.lead_id),
          input: { lead_id: m.lead_id, message_id: id }, priority: 82, title: `Respond to client: ${String(m.subject ?? '').slice(0, 70)}`, timeoutSeconds: 220 });
      }
    } else if (d.category !== 'spam') {
      await logEvent(tx, 'message', id, 'inbound_needs_review', `New inbound email (${d.category}) from ${m.from_addr ?? 'unknown'}: ${d.summary.slice(0, 160)}`, {}, d.priority === 'urgent' || d.priority === 'high' ? 'warning' : 'info');
    }
    return { category: d.category, intent: d.intent, priority: d.priority, injection_suspected: injection };
  });
};
