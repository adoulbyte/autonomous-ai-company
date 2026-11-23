import { z } from 'zod';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { logEvent } from '../db.js';
import { enqueue } from '../queue.js';
import { untrusted } from '../sanitize.js';
import { skillsFor } from '../skills.js';

const FeedbackSchema = z.object({
  rating: z.number().int().min(1).max(5).nullable(),
  comment: z.string().max(3000).nullable(),
  permission_to_publish: z.boolean(),
  wants_changes: z.boolean(),
  change_request: z.string().max(3000).nullable(),
  reply: z.string().min(10).max(2500),
});

/** feedback.capture — Customer Success: record honest feedback; turn change requests into a new production cycle. */
export const captureFeedback: Handler = async (ctx) => {
  const { message_id: messageId, project_id: projectId } = ctx.task.input as { message_id: string; project_id: string };
  const [m] = await ctx.sql`select * from public.messages where id = ${messageId}`;
  const [p] = await ctx.sql`select * from public.projects where id = ${projectId}`;
  if (!m || !p) throw new PermanentError('message or project not found');
  const res = await ctx.ai.generate({ roleKey: 'customer_success', taskId: ctx.task.id, tier: 'standard', schema: FeedbackSchema, maxTokens: 900, temperature: 0.2,
    messages: [{ role: 'user', content: `${skillsFor('sales')}

A client replied after we delivered their project "${p.name}". Extract their feedback and write our reply. Return JSON
{rating: 1-5|null (only if they gave or clearly implied one), comment: string|null (their words, faithfully), permission_to_publish: boolean (true ONLY if they explicitly allow us to cite/publish it),
 wants_changes: boolean, change_request: string|null (precise list of what to change), reply: string (no signature)}.
reply: thank them sincerely; if they want changes, confirm we are making them and will send an updated version; never pressure them for a positive review.
${untrusted('client-reply', `Subject: ${m.subject ?? ''}\n\n${m.body}`, 6000)}` }] });
  const f = res.data;

  return finish(ctx, async (tx) => {
    await tx`insert into public.client_feedback(project_id, message_id, rating, comment, permission_to_publish, wants_changes, change_request, author)
        values (${projectId}, ${messageId}, ${f.rating}, ${f.comment}, ${f.permission_to_publish}, ${f.wants_changes}, ${f.change_request}, ${m.from_addr})`;
    if (f.wants_changes && f.change_request && ['delivered', 'accepted'].includes(String(p.status))) {
      if (p.status === 'accepted') throw new PermanentError('project already accepted');
      await tx`update public.projects set status = 'revision' where id = ${projectId}`;
      const latest = await tx`select distinct on (work_item) work_item, version, id from public.deliverables where project_id = ${projectId} order by work_item, version desc`;
      for (const d of latest) {
        await tx`update public.deliverables set status = 'changes_requested' where id = ${d.id} and status = 'delivered'`;
        await enqueue(tx, { type: 'production.execute', key: `produce:${projectId}:${d.work_item}:v${Number(d.version) + 1}`, role: 'specialist_worker',
          entityType: 'project', entityId: projectId, priority: 70, timeoutSeconds: 300,
          input: { project_id: projectId, work_item: d.work_item, version: Number(d.version) + 1, feedback: [`CLIENT CHANGE REQUEST: ${f.change_request}`] },
          title: `Client revision: ${d.work_item} v${Number(d.version) + 1}` });
      }
      await logEvent(tx, 'project', projectId, 'client_revision_requested', `Client requested changes on "${p.name}" — new version in production`, { request: f.change_request }, 'warning');
    } else if (p.status === 'delivered' && !f.wants_changes) {
      await tx`update public.projects set status = 'accepted', accepted_at = now() where id = ${projectId}`;
      await tx`update public.projects set status = 'closed' where id = ${projectId}`;
      if (f.permission_to_publish && f.comment) {
        await tx`insert into public.portfolio_items(project_id, client_permission_at, public_text) values (${projectId}, now(), ${f.comment})`;
      }
      await logEvent(tx, 'project', projectId, 'client_feedback', `Feedback for "${p.name}": ${f.rating ? f.rating + '/5' : 'no rating'}${f.permission_to_publish ? ' (may be published)' : ''}`, { rating: f.rating });
    }
    const [approval] = await tx`select public.request_approval(p_action_type => 'lead.reply', p_title => ${'Reply to client feedback: ' + String(p.name).slice(0, 70)},
        p_requested_by => 'customer_success', p_reason => 'Client replied after delivery', p_if_approved => 'Reply is emailed', p_if_rejected => 'No reply',
        p_entity_type => 'project', p_entity_id => ${projectId}, p_idempotency_key => ${'fb-reply:' + messageId}) as id`;
    await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, approval_id, in_reply_to, generated_by_task, idempotency_key)
        values (${m.conversation_id}, 'outbound', 'awaiting_approval', ${m.from_addr}, ${'Re: ' + String(m.subject ?? p.name).replace(/^(re:\s*)+/i, '')}, ${f.reply},
                ${approval.id}, ${m.email_message_id}, ${ctx.task.id}, ${'fb-reply:' + messageId}) on conflict (idempotency_key) do nothing`;
    await tx`select public.system_auto_approve(${approval.id})`;
    return { rating: f.rating, wants_changes: f.wants_changes, permission_to_publish: f.permission_to_publish };
  });
};
