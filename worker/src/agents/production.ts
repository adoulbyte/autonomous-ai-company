import { z } from 'zod';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { sha256, untrusted } from '../sanitize.js';
import { autoApproveIfPolicy, enqueue, requestApproval } from '../queue.js';
import { getSetting, logEvent } from '../db.js';
import { skillsFor } from '../skills.js';
import { renderInvoicePdf, type PaymentInstructions } from '../email/invoice.js';
import { previewBlock, renderHtml } from '../email/template.js';
import { identity } from './comms.js';
import type { Tx } from '../db.js';

// ---------------------------------------------------------------------------
// project.plan — Project Architect
// ---------------------------------------------------------------------------
const PlanSchema = z.object({
  summary: z.string().max(1000),
  requirements: z.array(z.object({
    description: z.string().min(5).max(800),
    acceptance_criteria: z.array(z.string().min(5).max(400)).min(1).max(6),
  })).min(1).max(8),
  work_items: z.array(z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/),
    title: z.string().min(3).max(160),
    requirement_index: z.number().int().min(0),
    format: z.enum(['markdown', 'code', 'json', 'text', 'html', 'csv']),
    instructions: z.string().min(10).max(2000),
  })).min(1).max(8),
  out_of_scope: z.array(z.string().max(300)).max(10),
});

export const planProject: Handler = async (ctx) => {
  const id = String(ctx.task.input.project_id);
  const [p] = await ctx.sql`select * from public.projects where id = ${id}`;
  if (!p) throw new PermanentError('project not found');
  if (p.status !== 'planning') return finish(ctx, async () => ({ skipped: `project status ${p.status}` }));
  const res = await ctx.ai.generate({ roleKey: 'project_architect', taskId: ctx.task.id, tier: 'strong', schema: PlanSchema, maxTokens: 2500,
    messages: [{ role: 'user', content: `Turn this agreed project scope into a delivery plan. Return JSON
{summary, requirements:[{description, acceptance_criteria:[...]}], work_items:[{key, title, requirement_index, format, instructions}], out_of_scope:[...]}.
Rules: every acceptance criterion must be objectively verifiable by a reviewer reading the deliverable; at most 8 work items; each work item produces ONE
self-contained deliverable that an AI writer/developer can fully produce as text (code, documents, data, research) without access to external systems;
requirement_index refers to the requirements array; never expand scope.

Project name (trusted): ${p.name}
Budget: ${p.budget_minor ? Number(p.budget_minor) / 100 + ' ' + p.currency : 'n/a'}; deadline: ${p.deadline_at ?? 'n/a'}
${untrusted('agreed-scope', String(p.scope), 8000)}` }] });
  const plan = res.data;
  const bad = plan.work_items.find((w) => w.requirement_index >= plan.requirements.length);
  if (bad) throw new Error(`plan invalid: work item ${bad.key} references missing requirement`);
  const keys = new Set(plan.work_items.map((w) => w.key));
  if (keys.size !== plan.work_items.length) throw new Error('plan invalid: duplicate work item keys');

  return finish(ctx, async (tx) => {
    const reqIds: string[] = [];
    for (const [i, r] of plan.requirements.entries()) {
      const [row] = await tx`insert into public.requirements(project_id, position, description, acceptance_criteria)
          values (${id}, ${i}, ${r.description}, ${r.acceptance_criteria}) returning id`;
      reqIds.push(row.id);
    }
    await tx`update public.projects set plan = ${tx.json({ ...plan, model: res.model } as never)}, summary = ${plan.summary},
        out_of_scope = ${plan.out_of_scope.join('\n')}, status = 'in_progress' where id = ${id}`;
    for (const w of plan.work_items) {
      await enqueue(tx, { type: 'production.execute', key: `produce:${id}:${w.key}:v1`, role: 'specialist_worker', entityType: 'project', entityId: id,
        input: { project_id: id, work_item: w.key, version: 1 }, priority: 55, title: `Produce: ${w.title.slice(0, 80)}`, timeoutSeconds: 300 });
    }
    return { requirements: reqIds.length, work_items: plan.work_items.length, model: res.model };
  });
};

// ---------------------------------------------------------------------------
// production.execute — Specialist Worker (producer)
// ---------------------------------------------------------------------------
const DeliverableSchema = z.object({
  title: z.string().min(3).max(200),
  content: z.string().min(50).max(60000),
  notes: z.string().max(1500),
  limitations: z.array(z.string().max(300)).max(10),
});

export const produceDeliverable: Handler = async (ctx) => {
  const { project_id, work_item, version, feedback } = ctx.task.input as { project_id: string; work_item: string; version: number; feedback?: string[] };
  const [p] = await ctx.sql`select * from public.projects where id = ${project_id}`;
  if (!p) throw new PermanentError('project not found');
  if (!['in_progress', 'revision'].includes(p.status as string)) return finish(ctx, async () => ({ skipped: `project ${p.status}` }));
  const plan = p.plan as z.infer<typeof PlanSchema>;
  const item = plan.work_items.find((w) => w.key === work_item);
  if (!item) throw new PermanentError(`work item ${work_item} not in plan`);
  const [req] = await ctx.sql`select id, description, acceptance_criteria from public.requirements where project_id = ${project_id} and position = ${item.requirement_index}`;
  const existing = await ctx.sql`select id from public.deliverables where project_id = ${project_id} and work_item = ${work_item} and version = ${version}`;
  if (existing.length) return finish(ctx, async () => ({ skipped: 'version already produced', deliverable_id: existing[0].id }));
  const prev = version > 1 ? await ctx.sql`select content from public.deliverables where project_id = ${project_id} and work_item = ${work_item} and version = ${version - 1}` : [];

  const res = await ctx.ai.generate({ roleKey: 'specialist_worker', taskId: ctx.task.id, tier: 'standard', schema: DeliverableSchema, maxTokens: 4000,
    messages: [{ role: 'user', content: `${skillsFor('production', `${item.format} ${item.title} ${item.instructions}`)}

Produce the complete deliverable for this work item, to a standard a demanding paying client accepts without changes. Return JSON {title, content, notes, limitations}.
content must be the full, final deliverable in ${item.format} format — no placeholders, no "TODO", no lorem ipsum, no "insert X here".
Be honest in limitations about anything you could not verify or do.

Project: ${p.name}
Work item: ${item.title}
Instructions: ${item.instructions}
Requirement: ${req?.description}
Acceptance criteria (the QA agent will check each one):
${(req?.acceptance_criteria as string[] | undefined ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n')}
${feedback?.length ? `\nThis is revision v${version}. The independent QA reviewer rejected the previous version for these reasons — fix ALL of them:\n${feedback.map((f) => `- ${f}`).join('\n')}\n\n${untrusted('previous-version', String(prev[0]?.content ?? ''), 15000)}` : ''}
${untrusted('project-scope', String(p.scope), 5000)}` }] });

  return finish(ctx, async (tx) => {
    if (version > 1) {
      await tx`update public.deliverables set status = 'superseded' where project_id = ${project_id} and work_item = ${work_item}
          and version < ${version} and status in ('changes_requested','approved')`;
    }
    const [d] = await tx`insert into public.deliverables(project_id, requirement_id, work_item, version, title, format, content, content_hash,
          status, produced_by_role, produced_by_task, produced_by_model, producer_notes)
        values (${project_id}, ${req?.id ?? null}, ${work_item}, ${version}, ${res.data.title}, ${item.format}, ${res.data.content}, ${sha256(res.data.content)},
          'in_qa', 'specialist_worker', ${ctx.task.id}, ${res.model}, ${[res.data.notes, ...res.data.limitations.map((l) => 'Limitation: ' + l)].join('\n')})
        returning id`;
    await enqueue(tx, { type: 'qa.review', key: `qa:${d.id}`, role: 'qa_reviewer', entityType: 'deliverable', entityId: d.id,
      input: { deliverable_id: d.id }, priority: 58, title: `QA: ${res.data.title.slice(0, 80)} v${version}`, timeoutSeconds: 300 });
    if (p.status === 'revision') await tx`update public.projects set status = 'in_progress' where id = ${project_id}`;
    return { deliverable_id: d.id, version, model: res.model, chars: res.data.content.length };
  });
};

// ---------------------------------------------------------------------------
// qa.review — independent Quality Assurance Agent
// ---------------------------------------------------------------------------
const PLACEHOLDER = /\b(TODO|TBD|FIXME|lorem ipsum)\b|\[(insert|your|placeholder)[^\]]*\]|<insert[^>]*>/i;
export function staticChecks(content: string, format: string): string[] {
  const issues: string[] = [];
  if (content.trim().length < 200) issues.push('Deliverable is too short to be complete (< 200 characters).');
  if (PLACEHOLDER.test(content)) issues.push(`Contains placeholder text: "${content.match(PLACEHOLDER)?.[0]}".`);
  if (format === 'json') { try { JSON.parse(content); } catch { issues.push('Declared JSON format but content is not valid JSON.'); } }
  if (format === 'markdown' && /^#{1,6}\s*$/m.test(content)) issues.push('Markdown contains empty headings.');
  if ((content.match(/```/g) ?? []).length % 2 !== 0) issues.push('Unbalanced code fences.');
  const fake = content.match(/https?:\/\/(www\.)?(example\.(com|org|net)|placeholder\.[a-z]+|via\.placeholder\.com|your-?domain\.[a-z]+)[^\s)"']*/i);
  if (fake) issues.push(`References a placeholder/fictitious URL (${fake[0]}); deliverables must not contain fake links or images.`);
  return issues;
}

const QaSchema = z.object({
  criteria_results: z.array(z.object({ criterion: z.string().max(400), met: z.boolean(), evidence: z.string().max(600) })).min(1),
  issues: z.array(z.string().max(500)).max(15),
  summary: z.string().max(1000),
});

export const reviewDeliverable: Handler = async (ctx) => {
  const id = String(ctx.task.input.deliverable_id);
  const [d] = await ctx.sql`select d.*, r.acceptance_criteria, r.description as requirement, p.max_qa_cycles, p.name as project_name
      from public.deliverables d join public.projects p on p.id = d.project_id left join public.requirements r on r.id = d.requirement_id where d.id = ${id}`;
  if (!d) throw new PermanentError('deliverable not found');
  if (d.status !== 'in_qa') return finish(ctx, async () => ({ skipped: `deliverable ${d.status}` }));
  const criteria = (d.acceptance_criteria as string[] | null) ?? ['Deliverable fully addresses the work item.'];
  const staticIssues = staticChecks(String(d.content), String(d.format));
  const policy = await getSetting<{ reviewers_required: number }>(ctx.sql, 'qa.policy', { reviewers_required: 2 });
  const prior = await ctx.sql`select verdict, model from public.qa_reviews where deliverable_id = ${id} order by created_at`;
  const reviewNo = prior.length + 1;
  const avoid = [d.produced_by_model as string, ...prior.map((p) => p.model as string)].filter(Boolean);

  const res = await ctx.ai.generate({ roleKey: 'qa_reviewer', taskId: ctx.task.id, tier: 'strong', schema: QaSchema, maxTokens: 1800,
    avoidModel: avoid, temperature: 0,
    messages: [{ role: 'user', content: `${skillsFor('qa', `${d.format} ${d.title}`)}

You are independent QA reviewer #${reviewNo} of ${policy.reviewers_required}. You did NOT produce this deliverable and you have not seen other reviews. The client pays only for flawless work: check it strictly against EACH acceptance criterion, and also flag factual errors, fake links/images, unfinished parts, unclear writing or anything a demanding client would reject.
A criterion is met only if the deliverable itself demonstrates it — quote or point to the exact part as evidence. Do not give the benefit of the doubt.
Return JSON {criteria_results:[{criterion, met, evidence}], issues:[...], summary}. Include every criterion below exactly once.

Requirement: ${d.requirement ?? 'n/a'}
Acceptance criteria:
${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
Automated static checks found: ${staticIssues.length ? staticIssues.join(' ') : 'no issues'}

${untrusted(`deliverable ${d.title} v${d.version} (${d.format})`, String(d.content), 40000)}` }] });

  const qa = res.data;
  const allMet = qa.criteria_results.length >= criteria.length && qa.criteria_results.every((c) => c.met);
  const verdict: 'pass' | 'fail' = allMet && staticIssues.length === 0 ? 'pass' : 'fail';
  const issues = [...staticIssues, ...qa.issues, ...qa.criteria_results.filter((c) => !c.met).map((c) => `Unmet: ${c.criterion} — ${c.evidence}`)];

  return finish(ctx, async (tx) => {
    await tx`insert into public.qa_reviews(deliverable_id, reviewer_role, reviewer_task, verdict, criteria_results, issues, summary, model)
        values (${id}, 'qa_reviewer', ${ctx.task.id}, ${verdict}, ${tx.json(qa.criteria_results as never)}, ${issues}, ${qa.summary}, ${res.model})`;
    if (verdict === 'pass' && reviewNo < policy.reviewers_required) {
      await enqueue(tx, { type: 'qa.review', key: `qa:${id}:${reviewNo + 1}`, role: 'qa_reviewer', entityType: 'deliverable', entityId: id,
        input: { deliverable_id: id }, priority: 58, title: `QA #${reviewNo + 1}: ${String(d.title).slice(0, 70)} v${d.version}`, timeoutSeconds: 300 });
      return { verdict, review: reviewNo, next: 'second independent review', model: res.model };
    }
    if (verdict === 'pass') {
      await tx`update public.deliverables set status = 'approved' where id = ${id}`;
      if (d.requirement_id) await tx`update public.requirements set status = 'met' where id = ${d.requirement_id}`;
      await maybePrepareDelivery(tx, String(d.project_id));
      return { verdict, deliverable_id: id, model: res.model };
    }
    await tx`update public.deliverables set status = 'changes_requested' where id = ${id}`;
    const cycles = Number(d.version);
    if (cycles < Number(d.max_qa_cycles)) {
      await enqueue(tx, { type: 'production.execute', key: `produce:${d.project_id}:${d.work_item}:v${cycles + 1}`, role: 'specialist_worker',
        entityType: 'project', entityId: String(d.project_id), priority: 60, timeoutSeconds: 300,
        input: { project_id: d.project_id, work_item: d.work_item, version: cycles + 1, feedback: issues.slice(0, 12) },
        title: `Revise: ${String(d.title).slice(0, 70)} v${cycles + 1}` });
      await logEvent(tx, 'deliverable', id, 'qa_failed', `QA rejected "${d.title}" v${d.version}; sent back for correction`, { issues: issues.slice(0, 5) }, 'warning');
    } else {
      await tx`update public.projects set status = 'on_hold' where id = ${d.project_id} and status in ('in_progress','in_qa')`;
      await requestApproval(tx, {
        actionType: 'project.escalation', title: `QA limit reached: ${String(d.title).slice(0, 90)}`, requestedBy: 'qa_reviewer',
        reason: `Deliverable failed QA ${cycles} times (limit ${d.max_qa_cycles}). Project put on hold.`, evidence: issues.slice(0, 10),
        risk: 'Delivering this would likely not meet the client\'s acceptance criteria.', riskLevel: 'high',
        ifApproved: 'Acknowledges the escalation. Resume the project manually (Projects page) after adjusting scope or criteria.',
        ifRejected: 'Project stays on hold.', entityType: 'project', entityId: String(d.project_id), taskId: ctx.task.id, key: `qa-escalation:${id}`,
      });
    }
    return { verdict, deliverable_id: id, issues: issues.length, model: res.model };
  });
};

async function maybePrepareDelivery(tx: Tx, projectId: string) {
  const [p] = await tx`select plan from public.projects where id = ${projectId}`;
  const items = ((p?.plan as { work_items?: { key: string }[] } | null)?.work_items ?? []).map((w) => w.key);
  if (!items.length) return;
  const approved = await tx`select id, work_item from public.deliverables where project_id = ${projectId} and status = 'approved' order by id`;
  const done = new Set(approved.map((r) => r.work_item as string));
  if (items.every((k) => done.has(k))) {
    const versionKey = sha256(approved.map((r) => r.id).join(',')).slice(0, 16);
    await enqueue(tx, { type: 'project.prepare_delivery', key: `deliver:${projectId}:${versionKey}`, role: 'project_manager',
      entityType: 'project', entityId: projectId, input: { project_id: projectId }, priority: 65, title: 'Prepare delivery package' });
  }
}

// ---------------------------------------------------------------------------
// project.prepare_delivery — Project Manager: work is done and QA-approved → request payment.
// Deliverables are NOT released until the invoice is paid (enforced by the database).
// ---------------------------------------------------------------------------
export const prepareDelivery: Handler = async (ctx) => {
  const projectId = String(ctx.task.input.project_id);
  const [p] = await ctx.sql`select p.*, l.contact_id, l.id as lead_id, c.email as contact_email from public.projects p
      left join public.leads l on l.id = p.lead_id left join public.contacts c on c.id = l.contact_id where p.id = ${projectId}`;
  if (!p) throw new PermanentError('project not found');
  if (!['in_progress', 'in_qa'].includes(p.status as string)) return finish(ctx, async () => ({ skipped: `project ${p.status}` }));
  const items = ((p.plan as { work_items: { key: string; title: string }[] }).work_items);
  const dels = await ctx.sql`select distinct on (work_item) id, work_item, title, version, status, content_hash from public.deliverables
      where project_id = ${projectId} order by work_item, version desc`;
  const notApproved = items.filter((w) => !dels.find((d) => d.work_item === w.key && d.status === 'approved'));
  if (notApproved.length) throw new Error(`not all deliverables approved: ${notApproved.map((w) => w.key).join(', ')}`);

  return finish(ctx, async (tx) => {
    if (p.status === 'in_progress') await tx`update public.projects set status = 'in_qa' where id = ${projectId}`;
    await tx`update public.projects set status = 'ready_for_delivery' where id = ${projectId}`;
    for (const d of dels) await tx`update public.deliverables set status = 'ready_for_delivery' where id = ${d.id} and status = 'approved'`;
    let [inv] = await tx`select * from public.invoices where project_id = ${projectId} and status <> 'void' order by created_at limit 1`;
    if (!inv && Number(p.budget_minor ?? 0) > 0) {
      [inv] = await tx`insert into public.invoices(number, project_id, client_id, due_date, amount_minor, currency, notes)
          values ('INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.invoice_number_seq')::text, 5, '0'), ${projectId}, ${p.client_id},
                  current_date + 7, ${p.budget_minor}, ${p.currency}, 'Payment due before release of the deliverables.') returning *`;
    }
    if (inv && inv.status === 'draft') await tx`update public.invoices set status = 'issued' where id = ${inv.id}`;
    if (!inv) {   // zero-price project: deliver immediately
      await enqueue(tx, { type: 'project.deliver', key: `deliver-free:${projectId}`, role: 'project_manager', entityType: 'project', entityId: projectId,
        input: { project_id: projectId }, priority: 85, title: 'Deliver (no payment due)' });
      return { deliverables: dels.length, invoice: null };
    }
    const manifest = dels.map((d) => `- ${d.title}`).join('\n');
    const id = await identity(ctx.sql);
    const pay = await getSetting<PaymentInstructions>(ctx.sql, 'finance.payment_instructions', { enabled: false, text: '', beneficiary: '', iban: '', bic: '', bank: '', reference_hint: '' });
    const full = await tx`select title, content, format from public.deliverables where project_id = ${projectId} and status = 'ready_for_delivery' order by work_item`;
    const previews = full.map((d) => { const c = String(d.content); const cut = Math.max(400, Math.min(1500, Math.floor(c.length * 0.25)));
      return previewBlock(String(d.title), c.slice(0, cut) + (c.length > cut ? '\n…' : ''), `Preview of ${Math.round((cut / c.length) * 100)}% — full version released on payment. Passed two independent quality reviews.`); }).join('');
    const [client] = await tx`select co.name from public.clients cl join public.companies co on co.id = cl.company_id where cl.id = ${p.client_id}`;
    const pdf = await renderInvoicePdf({ number: inv.number, issue_date: String(inv.issue_date instanceof Date ? inv.issue_date.toISOString().slice(0, 10) : inv.issue_date),
      due_date: String(inv.due_date instanceof Date ? inv.due_date.toISOString().slice(0, 10) : inv.due_date), amount_minor: Number(inv.amount_minor), currency: String(inv.currency),
      client_name: client?.name ?? 'Client', client_email: p.contact_email ?? null, project_name: String(p.name),
      lines: [{ description: String(p.name), amount_minor: Number(inv.amount_minor) }] }, id, pay);
    const [conv] = await tx`insert into public.conversations(lead_id, project_id, contact_id, channel, subject)
        values (${p.lead_id}, ${projectId}, ${p.contact_id}, 'email', ${'Your project is ready: ' + p.name}) returning id`;
    const body = `Hello,\n\nGood news: the work for "${p.name}" is complete and has passed our independent quality review (${dels.length} deliverable${dels.length > 1 ? 's' : ''}):\n\n${manifest}\n\nInvoice ${inv.number}: ${(Number(inv.amount_minor) / 100).toFixed(2)} ${inv.currency}, due ${inv.due_date instanceof Date ? inv.due_date.toISOString().slice(0, 10) : inv.due_date}.\nThe deliverables are released automatically as soon as payment is received.\n\nThis message was prepared by an AI-assisted business system.`;
    const html = renderHtml(body, id, { preheader: `Your project is ready — preview inside`, blocks: previews });
    const attachments = [{ filename: `${inv.number}.pdf`, content_b64: pdf.toString('base64'), contentType: 'application/pdf' }];
    const [msg] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, html, attachments, generated_by_task, idempotency_key)
        values (${conv.id}, 'outbound', 'draft', ${p.contact_email}, ${'Invoice ' + inv.number + ' — ' + p.name}, ${body}, ${html}, ${tx.json(attachments as never)}, ${ctx.task.id}, ${'payreq:' + projectId + ':' + inv.id}) returning id`;
    const approvalId = await requestApproval(tx, {
      actionType: 'payment.request.send', title: `Send invoice ${inv.number}: ${String(p.name).slice(0, 80)}`, requestedBy: 'project_manager',
      reason: 'All deliverables passed independent QA. Requesting payment before releasing them.', evidence: dels.map((d) => ({ deliverable: d.title, version: d.version })),
      expectedBenefit: `Collect ${(Number(inv.amount_minor) / 100).toFixed(2)} ${inv.currency}.`, risk: 'Client-facing payment request.', riskLevel: 'low',
      ifApproved: 'The payment request is sent. Deliverables are released automatically once the payment is confirmed.',
      ifRejected: 'Nothing is sent; the invoice stays open.', entityType: 'project', entityId: projectId, taskId: ctx.task.id,
      key: `payreq:${projectId}:${inv.id}`, payload: { message_id: msg.id, invoice_id: inv.id }, costMinor: 0, currency: String(inv.currency),
    });
    await tx`update public.messages set status = 'awaiting_approval', approval_id = ${approvalId} where id = ${msg.id}`;
    // The invoice must carry real payment coordinates before it can go out automatically.
    const auto = pay.enabled ? await autoApproveIfPolicy(tx, approvalId) : false;
    if (!pay.enabled) await logEvent(tx, 'invoice', String(inv.id), 'payment_details_missing', `Invoice ${inv.number} is ready but payment details are not configured (Settings → finance.payment_instructions). It will be sent once they are.`, {}, 'warning');
    return { deliverables: dels.length, invoice: inv.number, message_id: msg.id, auto_approved: auto };
  });
};

// ---------------------------------------------------------------------------
// project.deliver — runs only after the invoice is paid (scheduled by the DB trigger).
// ---------------------------------------------------------------------------
export const deliverProject: Handler = async (ctx) => {
  const projectId = String(ctx.task.input.project_id);
  const [paid] = await ctx.sql`select public.project_is_paid(${projectId}) as ok`;
  if (!paid.ok) throw new PermanentError('invoice not paid — delivery refused');
  const [p] = await ctx.sql`select p.*, l.contact_id, l.id as lead_id, c.email as contact_email from public.projects p
      left join public.leads l on l.id = p.lead_id left join public.contacts c on c.id = l.contact_id where p.id = ${projectId}`;
  if (!p) throw new PermanentError('project not found');
  if (p.status !== 'ready_for_delivery') return finish(ctx, async () => ({ skipped: `project ${p.status}` }));
  const dels = await ctx.sql`select id, title, format, content from public.deliverables where project_id = ${projectId} and status = 'ready_for_delivery' order by work_item`;

  return finish(ctx, async (tx) => {
    const body = `Hello,\n\nThank you for your payment. Here are the deliverables for "${p.name}":\n\n` +
      dels.map((d) => `===== ${d.title} =====\n\n${d.content}`).join('\n\n') +
      `\n\nIf anything needs adjustment within the agreed scope, just reply to this message.\n\nThis message was prepared by an AI-assisted business system.`;
    const [conv] = await tx`insert into public.conversations(lead_id, project_id, contact_id, channel, subject)
        values (${p.lead_id}, ${projectId}, ${p.contact_id}, 'email', ${'Delivery: ' + p.name}) returning id`;
    const ext: Record<string, string> = { markdown: 'md', code: 'txt', json: 'json', text: 'txt', html: 'html', csv: 'csv' };
    const files = dels.map((d, i) => ({ filename: `${String(i + 1).padStart(2, '0')}-${String(d.title).replace(/[^\w.-]+/g, '_').slice(0, 60)}.${ext[d.format as string] ?? 'txt'}`,
      content_b64: Buffer.from(String(d.content), 'utf8').toString('base64'), contentType: 'text/plain' }));
    const shortBody = `Hello,\n\nThank you for your payment. Please find attached the complete deliverables for "${p.name}" (${dels.length} file${dels.length > 1 ? 's' : ''}).\n\nIf anything needs adjustment within the agreed scope, simply reply to this email.`;
    const [msg] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, attachments, generated_by_task, idempotency_key)
        values (${conv.id}, 'outbound', 'draft', ${p.contact_email}, ${'Delivery: ' + p.name}, ${files.length ? shortBody : body}, ${tx.json(files as never)}, ${ctx.task.id}, ${'delivery:' + projectId}) returning id`;
    const approvalId = await requestApproval(tx, {
      actionType: 'delivery.send', title: `Deliver (paid): ${String(p.name).slice(0, 90)}`, requestedBy: 'project_manager',
      reason: 'Invoice paid; releasing QA-approved deliverables.', evidence: dels.map((d) => ({ deliverable: d.title })),
      riskLevel: 'low', ifApproved: 'The delivery is sent to the client.', ifRejected: 'Delivery is held.',
      entityType: 'project', entityId: projectId, taskId: ctx.task.id, key: `delivery:${projectId}`, payload: { message_id: msg.id },
    });
    await tx`update public.messages set status = 'awaiting_approval', approval_id = ${approvalId} where id = ${msg.id}`;
    for (const d of dels) await tx`update public.deliverables set status = 'delivered' where id = ${d.id}`;
    await tx`update public.projects set status = 'delivered', delivered_at = now() where id = ${projectId}`;
    const auto = await autoApproveIfPolicy(tx, approvalId);
    return { delivered: dels.length, message_id: msg.id, auto_approved: auto };
  });
};
