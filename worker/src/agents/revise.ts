import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { logEvent, type Tx } from '../db.js';
import { autoApproveIfPolicy, enqueue, requestApproval } from '../queue.js';
import { sha256 } from '../sanitize.js';
import { editDesign, type Design, type EditResult } from '../render/edit.js';
import { renderHtml } from '../email/template.js';
import { identity } from './comms.js';

/**
 * creative.revise — after a delivery, the client asks for changes. Each delivered creation that has a design is edited
 * PRECISELY (same design, only what was asked); creations the request does not concern are kept identical.
 * The changed versions go through the double QA again and are re-delivered (no new invoice for a paid project).
 */
export const reviseCreatives: Handler = async (ctx) => {
  const { project_id: projectId, message_id: messageId } = ctx.task.input as { project_id: string; message_id: string };
  const [p] = await ctx.sql`select p.*, k.email as contact_email from public.projects p left join public.leads l on l.id = p.lead_id
      left join public.contacts k on k.id = l.contact_id where p.id = ${projectId}`;
  const [m] = await ctx.sql`select * from public.messages where id = ${messageId}`;
  if (!p || !m) throw new PermanentError('project or message not found');
  if (!['delivered', 'accepted'].includes(String(p.status))) return finish(ctx, async () => ({ skipped: `project ${p.status}` }));
  const latest = await ctx.sql`select distinct on (work_item) * from public.deliverables where project_id = ${projectId} order by work_item, version desc`;
  const request = `Subject: ${m.subject ?? ''}\n\n${m.body}`;
  const results: { d: Record<string, unknown>; r: EditResult | null }[] = [];
  for (const [i, d] of latest.entries()) {
    if (!d.design) { results.push({ d, r: null }); continue; }
    const r = await editDesign({ ai: ctx.ai, taskId: ctx.task.id, env: ctx.env, fetchFn: ctx.fetchFn, design: d.design as Design, from: 'client', request,
      label: latest.length > 1 ? `creation ${i + 1} of ${latest.length}: "${d.title}"` : undefined });
    results.push({ d, r });
  }
  const done = results.filter((x) => x.r?.kind === 'done');
  const question = results.find((x) => x.r?.kind === 'question')?.r as { question: string } | undefined;
  const id = await identity(ctx.sql);
  const fr = String((m.body ?? '') + (m.subject ?? '')).match(/[éèàçù]|bonjour|merci/i) != null;

  return finish(ctx, async (tx) => {
    if (!done.length) {
      // Nothing could be applied with certainty: ask a precise question instead of guessing.
      const q = question?.question ?? (fr ? 'Pour modifier exactement ce que vous souhaitez, pourriez-vous préciser la création concernée, l’élément à changer (titre, texte, couleur, photo…) et le résultat attendu ?'
        : 'To change exactly what you want, could you tell us which creation, which element (title, text, colour, photo…) and the result you expect?');
      await sendReply(tx, ctx.task.id, m, `${fr ? 'Bonjour,' : 'Hello,'}\n\n${q}`, id, `revise-q:${messageId}`, 'Question sur la modification demandée');
      return { question: true };
    }
    await tx`update public.projects set status = 'revision' where id = ${projectId}`;
    await tx`update public.projects set status = 'in_progress' where id = ${projectId}`;
    for (const { d, r } of results) {
      const version = Number(d.version) + 1;
      await tx`update public.deliverables set status = 'superseded' where id = ${d.id} and status in ('delivered','approved','changes_requested')`;
      if (r?.kind === 'done') {
        const [nd] = await tx`insert into public.deliverables(project_id, requirement_id, work_item, version, title, format, content, content_hash, status,
              produced_by_role, produced_by_task, produced_by_model, producer_notes, design)
            values (${projectId}, ${d.requirement_id ?? null}, ${d.work_item}, ${version}, ${d.title}, ${d.format}, ${r.html}, ${sha256(r.html)}, 'in_qa',
              'specialist_worker', ${ctx.task.id}, ${r.model}, ${`Modifications: ${r.changes.join(' ; ')}`}, ${tx.json(r.design as never)}) returning id`;
        await enqueue(tx, { type: 'qa.review', key: `qa:${nd.id}`, role: 'qa_reviewer', entityType: 'deliverable', entityId: nd.id,
          input: { deliverable_id: nd.id }, priority: 70, title: `QA (client changes): ${String(d.title).slice(0, 70)} v${version}`, timeoutSeconds: 300 });
      } else {
        // Not concerned by the request: the same file, with the quality reviews it already passed.
        const [nd] = await tx`insert into public.deliverables(project_id, requirement_id, work_item, version, title, format, content, content_hash, status,
              produced_by_role, produced_by_task, produced_by_model, producer_notes, design)
            values (${projectId}, ${d.requirement_id ?? null}, ${d.work_item}, ${version}, ${d.title}, ${d.format}, ${d.content}, ${d.content_hash}, 'in_qa',
              ${d.produced_by_role}, ${d.produced_by_task}, ${d.produced_by_model}, 'Unchanged (not concerned by the request)', ${d.design ? tx.json(d.design as never) : null}) returning id`;
        await tx`insert into public.qa_reviews(deliverable_id, reviewer_role, reviewer_task, verdict, criteria_results, issues, summary, model)
            select ${nd.id}, reviewer_role, reviewer_task, verdict, criteria_results, issues, summary, model from public.qa_reviews where deliverable_id = ${d.id} order by created_at`;
        await tx`update public.deliverables set status = 'approved' where id = ${nd.id}`;
      }
    }
    await logEvent(tx, 'project', projectId, 'client_revision_requested', `Client changes on "${p.name}": ${done.length} creation(s) modified precisely, ${results.length - done.length} unchanged`, {}, 'info');
    return { modified: done.length, unchanged: results.length - done.length };
  });
};

async function sendReply(tx: Tx, taskId: string, m: Record<string, unknown>, body: string, id: Awaited<ReturnType<typeof identity>>, key: string, title: string) {
  const [out] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, html, generated_by_task, idempotency_key, in_reply_to)
      values (${m.conversation_id as string}, 'outbound', 'draft', ${m.from_addr as string}, ${'Re: ' + String(m.subject ?? '').replace(/^(re:\s*)+/i, '')}, ${body}, ${renderHtml(body, id, {})},
        ${taskId}, ${key}, ${(m.email_message_id as string) ?? null}) on conflict (idempotency_key) do nothing returning id`;
  if (!out) return;
  const approvalId = await requestApproval(tx, { actionType: 'message.send', title, requestedBy: 'customer_success', reason: 'Ambiguous change request: we ask instead of guessing.',
    riskLevel: 'low', ifApproved: 'The question is emailed.', ifRejected: 'Nothing is sent.', entityType: 'message', entityId: out.id, taskId, key: `message.send:${out.id}`, payload: { message_id: out.id } });
  await tx`update public.messages set status = 'awaiting_approval', approval_id = ${approvalId} where id = ${out.id}`;
  await autoApproveIfPolicy(tx, approvalId);
}
