import type { Handler } from './context.js';
import { finish } from './context.js';
import { getSetting, logEvent, type Sql } from '../db.js';
import { enqueue } from '../queue.js';
import { renderHtml, renderText, type Identity } from '../email/template.js';
import { scrubSecrets } from '../sanitize.js';

export async function identity(sql: Sql): Promise<Identity> {
  return getSetting<Identity>(sql, 'business.identity', { company_name: 'Autonomous AI Studio', sender_name: 'Autonomous AI Studio', tagline: '', website: '', signature: 'Autonomous AI Studio', ai_disclosure: 'Prepared with AI assistance.' });
}

/** comms.send — send every approved outbound email (policy-approved or owner-approved), within daily caps. */
export const sendOutbox: Handler = async (ctx) => {
  if (!ctx.mail) return finish(ctx, async () => ({ skipped: 'no mailbox configured (GMAIL_ADDRESS / GMAIL_APP_PASSWORD)' }));
  const policy = await getSetting<{ daily_send_cap: number }>(ctx.sql, 'comms.policy', { daily_send_cap: 40 });
  const [{ n: sentToday }] = await ctx.sql`select count(*)::int as n from public.messages where direction = 'outbound' and status = 'sent' and sent_at >= date_trunc('day', now())`;
  const budget = Math.max(0, policy.daily_send_cap - sentToday);
  const queue = await ctx.sql`select m.*, c.subject as conv_subject, c.lead_id from public.messages m join public.conversations c on c.id = m.conversation_id
      where m.direction = 'outbound' and m.status = 'approved' and m.to_addr ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' and m.send_attempts < 5
      order by m.created_at limit ${budget}`;
  const id = await identity(ctx.sql);
  let sent = 0, failed = 0;
  for (const m of queue) {
    const dnc = await ctx.sql`select 1 from public.contacts where lower(email) = lower(${m.to_addr}) and do_not_contact`;
    if (dnc.length) { await ctx.sql`update public.messages set status = 'rejected', last_error = 'recipient is do-not-contact' where id = ${m.id}`; continue; }
    const prev = await ctx.sql`select email_message_id from public.messages where conversation_id = ${m.conversation_id} and email_message_id is not null order by created_at`;
    const refs = prev.map((p) => p.email_message_id as string);
    try {
      const attachments = ((m.attachments as { filename: string; content_b64: string; contentType?: string }[]) ?? [])
        .map((a) => ({ filename: a.filename, content: Buffer.from(a.content_b64, 'base64'), contentType: a.contentType }));
      const r = await ctx.mail.send({ from: `"${id.sender_name}" <${ctx.mail.address}>`, to: m.to_addr, subject: m.subject ?? m.conv_subject,
        text: renderText(m.body, id), html: (m.html as string | null) ?? renderHtml(m.body, id, { preheader: String(m.subject ?? '') }),
        inReplyTo: m.in_reply_to ?? refs.at(-1) ?? null, references: refs, attachments });
      await ctx.sql.begin(async (tx) => {
        await tx`select set_config('app.actor', 'agent:mail_clerk', true)`;
        await tx`update public.messages set status = 'sent', sent_at = now(), email_message_id = ${r.messageId}, from_addr = ${ctx.mail!.address}, send_attempts = send_attempts + 1 where id = ${m.id}`;
        if (m.lead_id) await tx`update public.leads set stage = 'contacted', next_follow_up_at = now() + interval '4 days' where id = ${m.lead_id} and stage in ('new','qualified')`;
        await logEvent(tx, 'message', String(m.id), 'email_sent', `Email sent to ${m.to_addr}: ${m.subject ?? ''}`);
      });
      sent++;
    } catch (e) {
      failed++;
      const err = scrubSecrets((e as Error).message).slice(0, 500);
      await ctx.sql`update public.messages set send_attempts = send_attempts + 1, last_error = ${err},
          status = case when send_attempts + 1 >= 5 then 'failed' else status end where id = ${m.id}`;
      await logEvent(ctx.sql, 'message', String(m.id), 'email_send_failed', `Email to ${m.to_addr} failed: ${err}`, {}, 'error');
    }
  }
  return finish(ctx, async () => ({ sent, failed, remaining_today: budget - sent }));
};

/** comms.poll_inbox — import new replies, link them to conversations, and route them to the right agent. */
export const pollInbox: Handler = async (ctx) => {
  if (!ctx.mail) return finish(ctx, async () => ({ skipped: 'no mailbox configured' }));
  const box = ctx.mail.address.toLowerCase();
  const [state] = await ctx.sql`insert into public.mailbox_state(mailbox) values (${box}) on conflict (mailbox) do update set mailbox = excluded.mailbox returning *`;
  let mails;
  try { mails = await ctx.mail.fetchSince(Number(state.last_uid), 50); }
  catch (e) { await ctx.sql`update public.mailbox_state set last_error = ${scrubSecrets((e as Error).message).slice(0, 300)}, last_poll_at = now() where mailbox = ${box}`; throw e; }
  return finish(ctx, async (tx) => {
    let imported = 0, maxUid = Number(state.last_uid);
    for (const m of mails) {
      maxUid = Math.max(maxUid, m.uid);
      if (!m.from || m.from === box) continue;
      if (m.messageId && (await tx`select 1 from public.messages where email_message_id = ${m.messageId}`).length) continue;
      const ids = [m.inReplyTo, ...m.references].filter(Boolean) as string[];
      type Conv = { id: string; lead_id: string | null };
      let conv: Conv | undefined;
      if (ids.length) conv = (await tx<Conv[]>`select c.id, c.lead_id from public.messages x join public.conversations c on c.id = x.conversation_id where x.email_message_id = any(${ids}) limit 1`)[0];
      if (!conv) conv = (await tx<Conv[]>`select c.id, c.lead_id from public.conversations c join public.contacts k on k.id = c.contact_id where lower(k.email) = ${m.from} order by c.updated_at desc limit 1`)[0];
      if (!conv) conv = (await tx<Conv[]>`insert into public.conversations(channel, subject) values ('email', ${m.subject}) returning id, lead_id`)[0];
      const [msg] = await tx`insert into public.messages(conversation_id, direction, status, from_addr, to_addr, subject, body, email_message_id, in_reply_to)
          values (${conv!.id}, 'inbound', 'received', ${m.from}, ${box}, ${m.subject}, ${m.text || '(empty)'}, ${m.messageId}, ${m.inReplyTo}) returning id`;
      await tx`update public.conversations set updated_at = now(), status = 'open' where id = ${conv!.id}`;
      await enqueue(tx, { type: 'comms.triage', key: `comms.triage:${msg.id}`, role: 'communications', entityType: 'message', entityId: msg.id,
        input: { message_id: msg.id }, priority: 80, title: `Triage email from ${m.from}` });
      imported++;
    }
    await tx`update public.mailbox_state set last_uid = ${maxUid}, last_poll_at = now(), last_error = null where mailbox = ${box}`;
    return { imported, last_uid: maxUid };
  });
};

/** lead.followup — polite, deterministic follow-up when a contacted lead has not replied (bounded). */
export const followUp: Handler = async (ctx) => {
  const leadId = String(ctx.task.input.lead_id);
  const policy = await getSetting<{ max_followups: number; followup_after_days: number }>(ctx.sql, 'comms.policy', { max_followups: 2, followup_after_days: 4 });
  const [l] = await ctx.sql`select l.*, k.email from public.leads l left join public.contacts k on k.id = l.contact_id where l.id = ${leadId}`;
  if (!l || l.stage !== 'contacted' || !l.email || l.follow_ups_sent >= policy.max_followups) return finish(ctx, async () => ({ skipped: 'not eligible' }));
  const [conv] = await ctx.sql`select id, subject from public.conversations where lead_id = ${leadId} order by created_at limit 1`;
  if (!conv) return finish(ctx, async () => ({ skipped: 'no conversation' }));
  const n = Number(l.follow_ups_sent) + 1;
  const body = n === 1
    ? `Hello,\n\nI wanted to make sure my previous message reached you about "${l.title}". We can start right away and share a preview before any payment.\n\nWould you like us to go ahead?`
    : `Hello,\n\nA last short note about "${l.title}": if the need is still open, simply reply and we will take it from there. Otherwise, no worries — we will not follow up again.`;
  return finish(ctx, async (tx) => {
    const [approval] = await tx`select public.request_approval(p_action_type => 'message.send', p_title => ${'Follow-up #' + n + ': ' + String(l.title).slice(0, 80)},
        p_requested_by => 'sales_agent', p_reason => 'No reply after the follow-up delay', p_if_approved => 'Follow-up is emailed', p_if_rejected => 'No follow-up',
        p_entity_type => 'lead', p_entity_id => ${leadId}, p_idempotency_key => ${'followup:' + leadId + ':' + n}) as id`;
    await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, approval_id, idempotency_key)
        values (${conv.id}, 'outbound', 'awaiting_approval', ${l.email}, ${'Re: ' + conv.subject}, ${body}, ${approval.id}, ${'followup:' + leadId + ':' + n}) on conflict (idempotency_key) do nothing`;
    await tx`select public.system_auto_approve(${approval.id})`;
    await tx`update public.leads set follow_ups_sent = ${n}, next_follow_up_at = ${n < policy.max_followups ? new Date(Date.now() + policy.followup_after_days * 86_400_000) : null} where id = ${leadId}`;
    return { followup: n };
  });
};
