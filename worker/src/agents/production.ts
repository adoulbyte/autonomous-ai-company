import { z } from 'zod';
import { factsFromListing, renderSite, SiteContentSchema, type SiteContent } from '../render/site.js';
import { tradeProfile, type Photo } from '../render/photos.js';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { PermanentError } from '../errors.js';
import { sha256, untrusted } from '../sanitize.js';
import { autoApproveIfPolicy, enqueue, requestApproval } from '../queue.js';
import { getSetting, logEvent } from '../db.js';
import { skillsFor } from '../skills.js';
import { renderMarkdownPdf, excelCsv } from '../email/document.js';
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
    format: z.enum(['markdown', 'code', 'json', 'text', 'html', 'csv', 'pdf', 'spreadsheet', 'svg']),
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
Formats: html = complete single-file website; pdf = a document written in Markdown that is delivered as a PDF (flyer, menu, price list, guide);
spreadsheet = CSV with ";" separator delivered for Excel (planning, price list, stock, budget); svg = a simple visual (social post, banner, logo idea);
markdown/text = written content (ad scripts, texts); code/json/csv for technical work.

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

  // A website ordered after a mockup: the final site is built from the mockup the client approved (same design and photos),
  // with the texts updated from what the client sent us. Same engine as the mockup, so the result matches what they saw.
  const fromMockup = item.format === 'html' && p.lead_id ? await siteFromMockup(ctx, String(p.lead_id), feedback) : null;
  const res: { data: z.infer<typeof DeliverableSchema>; model: string } = fromMockup ?? await ctx.ai.generate({ roleKey: 'specialist_worker', taskId: ctx.task.id, tier: 'standard', schema: DeliverableSchema, maxTokens: 4000,
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

/** Projects for French-speaking clients get French emails and invoices. */
async function projectIsFrench(sql: Tx | Parameters<Handler>[0]['sql'], projectId: string): Promise<boolean> {
  const [r] = await sql`select o.analysis->>'language' as lang from public.projects p join public.leads l on l.id = p.lead_id
      left join public.opportunities o on o.id = l.opportunity_id where p.id = ${projectId}`;
  return r?.lang === 'fr';
}

/** Turn a deliverable into the file the client actually uses (PDF, Excel-ready CSV, website, SVG...). */
export async function deliverableFile(d: Record<string, unknown>, i: number, projectName: string) {
  const base = `${String(i + 1).padStart(2, '0')}-${String(d.title).replace(/[^\w.-]+/g, '_').replace(/_(html|pdf|csv|svg|md)$/i, '').slice(0, 60)}`;
  const text = String(d.content);
  switch (String(d.format)) {
    case 'pdf': return { filename: `${base}.pdf`, content_b64: (await renderMarkdownPdf(text, projectName)).toString('base64'), contentType: 'application/pdf' };
    case 'spreadsheet': return { filename: `${base}.csv`, content_b64: excelCsv(text).toString('base64'), contentType: 'text/csv' };
    case 'html': return { filename: `${base}.html`, content_b64: Buffer.from(text, 'utf8').toString('base64'), contentType: 'text/html' };
    case 'svg': return { filename: `${base}.svg`, content_b64: Buffer.from(text, 'utf8').toString('base64'), contentType: 'image/svg+xml' };
    default: {
      const ext: Record<string, string> = { markdown: 'md', code: 'txt', json: 'json', text: 'txt', csv: 'csv' };
      return { filename: `${base}.${ext[String(d.format)] ?? 'txt'}`, content_b64: Buffer.from(text, 'utf8').toString('base64'), contentType: 'text/plain' };
    }
  }
}

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
  if (format === 'html' && !/<html[\s>]/i.test(content)) issues.push('Website must be a complete HTML document (<html>...</html>).');
  if (format === 'html' && !/name=["']viewport["']/i.test(content)) issues.push('Website is not mobile friendly (missing viewport meta tag).');
  if (format === 'svg' && !/<svg[\s\S]*<\/svg>\s*$/i.test(content.trim())) issues.push('Visual must be a single complete SVG document.');
  if (format === 'spreadsheet' && content.trim().split('\n').length < 2) issues.push('Spreadsheet needs a header row and at least one data row.');
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
      await enqueue(tx, { type: 'project.deliver', key: `deliver-free:${projectId}:${sha256(dels.map((d) => d.id).join(',')).slice(0, 12)}`, role: 'project_manager', entityType: 'project', entityId: projectId,
        input: { project_id: projectId }, priority: 85, title: 'Deliver (no payment due)' });
      return { deliverables: dels.length, invoice: null };
    }
    const manifest = dels.map((d) => `- ${d.title}`).join('\n');
    const id = await identity(ctx.sql);
    const fr = await projectIsFrench(tx, projectId);
    const due = inv.due_date instanceof Date ? inv.due_date.toISOString().slice(0, 10) : String(inv.due_date);
    const amount = `${(Number(inv.amount_minor) / 100).toFixed(2)} ${inv.currency}`;
    const pay = await getSetting<PaymentInstructions>(ctx.sql, 'finance.payment_instructions', { enabled: false, text: '', beneficiary: '', iban: '', bic: '', bank: '', reference_hint: '' });
    const full = await tx`select title, content, format from public.deliverables where project_id = ${projectId} and status = 'ready_for_delivery' order by work_item`;
    const previews = full.map((d) => { const c = String(d.content); const cut = Math.max(400, Math.min(1500, Math.floor(c.length * 0.25)));
      return previewBlock(String(d.title), c.slice(0, cut) + (c.length > cut ? '\n…' : ''), fr ? `Aperçu de ${Math.round((cut / c.length) * 100)} % — version complète envoyée dès réception du paiement. Validé par deux contrôles qualité indépendants.` : `Preview of ${Math.round((cut / c.length) * 100)}% — full version released on payment. Passed two independent quality reviews.`); }).join('');
    const [client] = await tx`select co.name from public.clients cl join public.companies co on co.id = cl.company_id where cl.id = ${p.client_id}`;
    const pdf = await renderInvoicePdf({ number: inv.number, issue_date: String(inv.issue_date instanceof Date ? inv.issue_date.toISOString().slice(0, 10) : inv.issue_date),
      due_date: String(inv.due_date instanceof Date ? inv.due_date.toISOString().slice(0, 10) : inv.due_date), amount_minor: Number(inv.amount_minor), currency: String(inv.currency),
      client_name: client?.name ?? 'Client', client_email: p.contact_email ?? null, project_name: String(p.name),
      lines: [{ description: String(p.name), amount_minor: Number(inv.amount_minor) }] }, id, pay, fr ? 'fr' : 'en');
    const [conv] = await tx`insert into public.conversations(lead_id, project_id, contact_id, channel, subject)
        values (${p.lead_id}, ${projectId}, ${p.contact_id}, 'email', ${'Your project is ready: ' + p.name}) returning id`;
    const body = fr
      ? `Bonjour,\n\nBonne nouvelle : le travail pour « ${p.name} » est terminé et a été validé par notre contrôle qualité indépendant (${dels.length} livrable${dels.length > 1 ? 's' : ''}) :\n\n${manifest}\n\nVous trouverez ci-dessous un aperçu, et en pièce jointe la facture ${inv.number} : ${amount}, à régler avant le ${due}.\nLes fichiers complets vous sont envoyés automatiquement dès réception du paiement.`
      : `Hello,\n\nGood news: the work for "${p.name}" is complete and has passed our independent quality review (${dels.length} deliverable${dels.length > 1 ? 's' : ''}):\n\n${manifest}\n\nInvoice ${inv.number}: ${amount}, due ${due}.\nThe deliverables are released automatically as soon as payment is received.\n\nThis message was prepared by an AI-assisted business system.`;
    const html = renderHtml(body, id, { preheader: fr ? 'Votre projet est prêt — aperçu à l’intérieur' : `Your project is ready — preview inside`, blocks: previews });
    const attachments = [{ filename: `${inv.number}.pdf`, content_b64: pdf.toString('base64'), contentType: 'application/pdf' }];
    const [msg] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, html, attachments, generated_by_task, idempotency_key)
        values (${conv.id}, 'outbound', 'draft', ${p.contact_email}, ${(fr ? 'Facture ' : 'Invoice ') + inv.number + ' — ' + p.name}, ${body}, ${html}, ${tx.json(attachments as never)}, ${ctx.task.id}, ${'payreq:' + projectId + ':' + inv.id}) returning id`;
    const approvalId = await requestApproval(tx, {
      actionType: 'payment.request.send', title: `Valider et envoyer la facture ${inv.number} (${amount}) — ${String(p.name).slice(0, 70)}`, requestedBy: 'project_manager',
      reason: 'Le travail est terminé et validé par deux contrôles qualité. La facture et un aperçu sont prêts à partir chez le client.', evidence: dels.map((d) => ({ livrable: d.title, version: d.version })),
      expectedBenefit: `Encaisser ${amount}.`, risk: 'Envoi de la facture au client.', riskLevel: 'low',
      ifApproved: 'La facture (PDF) et l’aperçu partent automatiquement depuis la boîte Gmail. Dès que tu confirmes le paiement dans Finances, les fichiers complets sont livrés.',
      ifRejected: 'Rien n’est envoyé ; la facture reste en attente.', entityType: 'project', entityId: projectId, taskId: ctx.task.id,
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
    const files = await Promise.all(dels.map((d, i) => deliverableFile(d, i, String(p.name))));
    const free = Number(p.budget_minor ?? 0) === 0;
    const fr = await projectIsFrench(tx, projectId);
    const n = `${dels.length} fichier${dels.length > 1 ? 's' : ''}`;
    const shortBody = fr
      ? (free ? `Bonjour,\n\nComme promis, vous trouverez en pièces jointes le travail complet pour « ${p.name} » (${n}), offert. Chaque livrable a été validé par deux contrôles qualité indépendants.\n\nSi un détail est à ajuster, répondez simplement à ce message.\n\nQuand vous aurez un moment, votre avis honnête nous aiderait beaucoup : une note de 1 à 5 et quelques mots sur ce qui vous a plu ou ce qui pourrait être amélioré. Nous ne publierons jamais rien sans votre accord explicite.`
              : `Bonjour,\n\nMerci pour votre paiement. Vous trouverez en pièces jointes le travail complet pour « ${p.name} » (${n}).\n\nSi un ajustement est nécessaire dans le cadre convenu, répondez simplement à ce message.`)
      : free
      ? `Hello,\n\nAs promised, please find attached the complete deliverables for "${p.name}" (${dels.length} file${dels.length > 1 ? 's' : ''}), free of charge. Each one passed two independent quality reviews.\n\nIf anything needs adjusting, just reply and we will fix it.\n\nWhen you have a moment, we would really value your honest feedback: a rating from 1 to 5 and a few words on what worked and what could be better. If you are happy for us to mention you as a reference, just say so — we will never publish anything without your explicit agreement.`
      : `Hello,\n\nThank you for your payment. Please find attached the complete deliverables for "${p.name}" (${dels.length} file${dels.length > 1 ? 's' : ''}).\n\nIf anything needs adjustment within the agreed scope, simply reply to this email.`;
    const [msg] = await tx`insert into public.messages(conversation_id, direction, status, to_addr, subject, body, attachments, generated_by_task, idempotency_key)
        values (${conv.id}, 'outbound', 'draft', ${p.contact_email}, ${(fr ? 'Livraison : ' : 'Delivery: ') + p.name}, ${files.length ? shortBody : body}, ${tx.json(files as never)}, ${ctx.task.id}, ${'delivery:' + projectId + ':' + ctx.task.id}) returning id`;
    const approvalId = await requestApproval(tx, {
      actionType: 'delivery.send', title: `Livraison : ${String(p.name).slice(0, 90)}`, requestedBy: 'project_manager',
      reason: 'Invoice paid; releasing QA-approved deliverables.', evidence: dels.map((d) => ({ deliverable: d.title })),
      riskLevel: 'low', ifApproved: 'The delivery is sent to the client.', ifRejected: 'Delivery is held.',
      entityType: 'project', entityId: projectId, taskId: ctx.task.id, key: `delivery:${projectId}:${ctx.task.id}`, payload: { message_id: msg.id },
    });
    await tx`update public.messages set status = 'awaiting_approval', approval_id = ${approvalId} where id = ${msg.id}`;
    for (const d of dels) await tx`update public.deliverables set status = 'delivered' where id = ${d.id}`;
    await tx`update public.projects set status = 'delivered', delivered_at = now() where id = ${projectId}`;
    const auto = await autoApproveIfPolicy(tx, approvalId);
    return { delivered: dels.length, message_id: msg.id, auto_approved: auto };
  });
};

const FinalSiteSchema = SiteContentSchema.extend({
  phone: z.string().max(40).nullable().optional(), hours: z.string().max(200).nullable().optional(), address: z.string().max(200).nullable().optional(),
});

async function siteFromMockup(ctx: Parameters<Handler>[0], leadId: string, feedback?: string[]): Promise<{ data: z.infer<typeof DeliverableSchema>; model: string } | null> {
  const [l] = await ctx.sql`select l.quote, o.analysis, o.description as listing, o.buyer_name, k.email from public.leads l
      left join public.opportunities o on o.id = l.opportunity_id left join public.contacts k on k.id = l.contact_id where l.id = ${leadId}`;
  const q = (l?.quote ?? {}) as { mockup_content?: SiteContent; mockup_photos?: Photo[]; mockup_html?: string; need?: string };
  if (!q.mockup_content || (q.need && q.need !== 'website')) return null;
  const a = (l.analysis ?? {}) as { language?: string; category?: string; city?: string };
  const lang = a.language ?? 'fr';
  const thread = await ctx.sql`select m.body from public.messages m join public.conversations c on c.id = m.conversation_id
      where c.lead_id = ${leadId} and m.direction = 'inbound' and m.classification->>'automated' is null order by m.created_at desc limit 6`;
  const r = await ctx.ai.generate({ roleKey: 'specialist_worker', taskId: ctx.task.id, tier: 'standard', allowDowngrade: true, schema: FinalSiteSchema, maxTokens: 3000, temperature: 0.3,
    messages: [{ role: 'user', content: `${skillsFor('production', 'html website vitrine copywriting')}
The client ordered their one-page website after approving our mockup. Update the mockup texts below with the information the client sent us
(their real services, descriptions, opening hours, phone, address, wishes). Keep the same JSON keys and the same tone; keep what the client did not change.
Language: ${lang}. Never invent facts (prices, reviews, years, names) that are not in the mockup, the listing or the client's messages.
Return JSON with the same keys as the mockup texts, plus optional phone, hours, address (only if the client gave them).
${feedback?.length ? `The quality reviewer asked for these corrections — apply ALL of them:\n${feedback.map((f) => `- ${f}`).join('\n')}\n` : ''}
${untrusted('mockup-texts', JSON.stringify(q.mockup_content), 8000)}
${untrusted('business-listing', String(l.listing ?? ''), 2000)}
${untrusted('client-messages', thread.map((t) => String(t.body).slice(0, 2000)).join('\n---\n'), 8000)}` }] });
  const facts = factsFromListing(String(l.listing ?? ''), String(l.buyer_name ?? ''), a.city, l.email);
  const photos = q.mockup_photos?.length ? q.mockup_photos
    : [...new Set([...(q.mockup_html ?? '').matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]))].map((url) => ({ url, thumb: url, credit: null }));
  const { phone, hours, address, ...content } = r.data;
  const html = renderSite(content, { ...facts, phone: phone ?? facts.phone, hours: hours ?? facts.hours, address: address ?? facts.address }, photos, tradeProfile(a.category).theme, lang);
  return { model: r.model, data: { title: `Site vitrine — ${facts.name}`, content: html,
    notes: 'Built from the mockup approved by the client (same design and photos), with the information they sent.', limitations: [] } };
}
