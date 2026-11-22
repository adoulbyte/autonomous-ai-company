import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, asRole, freshDb, OWNER_ID, registerOwner, STRANGER_ID } from './helpers.js';
import type { Sql } from '../src/db.js';

let db: Awaited<ReturnType<typeof freshDb>>; let sql: Sql;
beforeAll(async () => { db = await freshDb(); sql = db.sql; await registerOwner(sql); });
afterAll(async () => { await db.drop(); });

async function seedProjectWithDeliverable() {
  const [p] = await sql`insert into public.projects(name, scope, status) values ('P', 'scope', 'planning') returning id`;
  await sql`update public.projects set status = 'in_progress' where id = ${p.id}`;
  const [d] = await sql`insert into public.deliverables(project_id, work_item, title, content, content_hash, produced_by_role)
      values (${p.id}, 'w1', 'Doc', 'content', 'h', 'specialist_worker') returning id`;
  return { projectId: p.id as string, deliverableId: d.id as string };
}

describe('access control (RLS + grants), as PostgREST would call', () => {
  it('anonymous callers cannot read anything', async () => {
    await expect(asRole(sql, 'anon', null, (tx) => tx`select * from public.settings`)).rejects.toThrow(/permission denied/);
    await expect(asRole(sql, 'anon', null, (tx) => tx`select * from public.payments`)).rejects.toThrow(/permission denied/);
  });
  it('authenticated non-owner sees zero rows and cannot call owner RPCs', async () => {
    const rows = await asRole(sql, 'authenticated', STRANGER_ID, (tx) => tx`select * from public.settings`);
    expect(rows).toHaveLength(0);
    await expect(asRole(sql, 'authenticated', STRANGER_ID, (tx) => tx`select public.owner_set_setting('system.kill_switch', 'true')`)).rejects.toThrow(/owner authentication required/);
  });
  it('owner can read', async () => {
    const rows = await asOwner(sql, (tx) => tx`select * from public.settings`);
    expect(rows.length).toBeGreaterThan(5);
  });
  it('owner cannot write protected tables directly (must use audited RPCs)', async () => {
    await expect(asOwner(sql, (tx) => tx`update public.settings set value = 'true' where key = 'system.kill_switch'`)).rejects.toThrow(/permission denied/);
    await expect(asOwner(sql, (tx) => tx`insert into public.payments(amount_minor, currency, method, status) values (1, 'USD', 'other', 'pending')`)).rejects.toThrow(/permission denied/);
    await expect(asOwner(sql, (tx) => tx`select public.claim_tasks('x', 1, null)`)).rejects.toThrow(/permission denied/);
  });
  it('MFA enforcement: when required, aal1 sessions are not the owner', async () => {
    await sql`update public.settings set value = 'true' where key = 'security.require_mfa'`;
    const aal1 = await asRole(sql, 'authenticated', OWNER_ID, (tx) => tx`select public.is_owner() as o`, { aal: 'aal1' });
    const aal2 = await asRole(sql, 'authenticated', OWNER_ID, (tx) => tx`select public.is_owner() as o`, { aal: 'aal2' });
    expect(aal1[0].o).toBe(false); expect(aal2[0].o).toBe(true);
    await sql`update public.settings set value = 'false' where key = 'security.require_mfa'`;
  });
  it('owner setting changes are audited', async () => {
    await asOwner(sql, (tx) => tx`select public.owner_set_setting('limits.analyses_per_run', '5')`);
    const a = await sql`select actor_type, actor_id from public.audit_log where entity_type = 'settings' and entity_id = 'limits.analyses_per_run' order by id desc limit 1`;
    expect(a[0]).toMatchObject({ actor_type: 'owner', actor_id: OWNER_ID });
  });
});

describe('approvals are enforced by the backend', () => {
  it('only the owner can decide; decisions release gated tasks', async () => {
    const [{ id: approvalId }] = await sql`select public.request_approval('test.action', 'Do X', 'sales_agent', 'because', 'X happens', 'X does not happen') as id`;
    const [{ id: taskId }] = await sql`select public.enqueue_task(p_type => 'x.gated', p_idempotency_key => 'gated-1', p_approval_id => ${approvalId}) as id`;
    expect((await sql`select status from public.tasks where id = ${taskId}`)[0].status).toBe('awaiting_approval');
    expect(await sql`select * from public.claim_tasks('w', 5, ${['x.gated'] as never})`).toHaveLength(0);
    await expect(asRole(sql, 'authenticated', STRANGER_ID, (tx) => tx`select public.decide_approval(${approvalId}, true, null)`)).rejects.toThrow(/only the owner/);
    await asOwner(sql, (tx) => tx`select public.decide_approval(${approvalId}, true, 'ok')`);
    expect((await sql`select status from public.tasks where id = ${taskId}`)[0].status).toBe('pending');
    await expect(asOwner(sql, (tx) => tx`select public.decide_approval(${approvalId}, false, null)`)).rejects.toThrow(/already approved/);
  });
  it('rejection cancels gated tasks; expired approvals cannot be approved', async () => {
    const [{ id: a1 }] = await sql`select public.request_approval('test.action', 'Do Y', 'x', 'r', 'y', 'n') as id`;
    const [{ id: t1 }] = await sql`select public.enqueue_task(p_type => 'x.gated', p_idempotency_key => 'gated-2', p_approval_id => ${a1}) as id`;
    await asOwner(sql, (tx) => tx`select public.decide_approval(${a1}, false, 'no')`);
    expect((await sql`select status from public.tasks where id = ${t1}`)[0].status).toBe('cancelled');
    const [{ id: a2 }] = await sql`select public.request_approval('test.action', 'Old', 'x', 'r', 'y', 'n') as id`;
    await sql`update public.approvals set expires_at = now() - interval '1 minute' where id = ${a2}`;
    const r = await asOwner(sql, (tx) => tx`select (public.decide_approval(${a2}, true, null)).status as s`);
    expect(r[0].s).toBe('expired');
  });
  it('outbound messages cannot be approved or sent without an approved approval', async () => {
    const [c] = await sql`insert into public.conversations(channel, subject) values ('email', 's') returning id`;
    const [m] = await sql`insert into public.messages(conversation_id, direction, status, body) values (${c.id}, 'outbound', 'draft', 'hello') returning id`;
    await sql`update public.messages set status = 'awaiting_approval' where id = ${m.id}`;
    await expect(sql`update public.messages set status = 'approved' where id = ${m.id}`).rejects.toThrow(/requires an approved approval/);
    await expect(asOwner(sql, (tx) => tx`select public.owner_mark_message_sent(${m.id}, null)`)).rejects.toThrow(/must be approved/);
  });
  it('agent-proposed critical setting changes apply only after approval', async () => {
    const [{ id }] = await sql`select public.request_approval(p_action_type => 'settings.change', p_title => 'weights', p_requested_by => 'executive_strategist',
        p_reason => 'r', p_if_approved => 'a', p_if_rejected => 'b', p_payload => ${sql.json({ key: 'limits.max_deferrals', value: 7 } as never)}) as id`;
    expect((await sql`select value from public.settings where key = 'limits.max_deferrals'`)[0].value).not.toBe(7);
    await asOwner(sql, (tx) => tx`select public.decide_approval(${id}, true, null)`);
    expect((await sql`select value from public.settings where key = 'limits.max_deferrals'`)[0].value).toBe(7);
    expect((await sql`select status from public.approvals where id = ${id}`)[0].status).toBe('executed');
  });
});

describe('data integrity guards', () => {
  it('payments cannot be confirmed without evidence', async () => {
    await expect(sql`insert into public.payments(amount_minor, currency, method, status, confirmed_by, confirmed_at) values (100, 'USD', 'other', 'confirmed', 'x', now())`).rejects.toThrow(/check constraint/);
  });
  it('agents can never confirm payments, even with evidence', async () => {
    await expect(sql.begin(async (tx) => {
      await tx`select set_config('app.actor', 'agent:finance_agent', true)`;
      await tx`insert into public.payments(amount_minor, currency, method, status, evidence_type, evidence_ref, confirmed_by, confirmed_at)
               values (100, 'USD', 'other', 'confirmed', 'statement_line', 'line-123', 'agent', now())`;
    })).rejects.toThrow(/agents cannot confirm payments/);
  });
  it('invalid state transitions are rejected', async () => {
    const { projectId } = await seedProjectWithDeliverable();
    await expect(sql`update public.projects set status = 'closed' where id = ${projectId}`).rejects.toThrow(/invalid project transition/);
  });
  it('deliverables cannot be approved without a passing independent QA review', async () => {
    const { deliverableId } = await seedProjectWithDeliverable();
    await expect(sql`update public.deliverables set status = 'approved' where id = ${deliverableId}`).rejects.toThrow(/passing QA/);
    await expect(sql`insert into public.qa_reviews(deliverable_id, reviewer_role, verdict, criteria_results, summary) values (${deliverableId}, 'specialist_worker', 'pass', '[]', 'self')`)
      .rejects.toThrow(/independence/);
    await sql`insert into public.qa_reviews(deliverable_id, reviewer_role, verdict, criteria_results, summary) values (${deliverableId}, 'qa_reviewer', 'pass', '[]', 'ok')`;
    await sql`update public.deliverables set status = 'approved' where id = ${deliverableId}`;
  });
  it('opportunities cannot advance without evidence', async () => {
    await sql`insert into public.opportunities(source_key, external_id, fingerprint, title, description, url) values ('manual', 'm1', 'fp-m1', 't', 'd', 'https://e.x')`;
    await expect(sql`update public.opportunities set status = 'analyzing' where external_id = 'm1'`).rejects.toThrow(/no evidence/);
  });
  it('audit and event logs are append-only', async () => {
    await expect(sql`delete from public.audit_log`).rejects.toThrow(/append-only/);
    await expect(sql`update public.events set message = 'x'`).rejects.toThrow(/append-only/);
  });
  it('contacts are deduplicated case-insensitively', async () => {
    await sql`insert into public.contacts(email) values ('Ann@Example.com')`;
    await expect(sql`insert into public.contacts(email) values ('ann@example.com')`).rejects.toThrow(/duplicate key/);
  });
  it('money is integer minor units with explicit currency', async () => {
    const [r] = await sql`insert into public.expenses(category, description, amount_minor, currency) values ('ai', 'x', 150, 'USD') returning amount_minor`;
    expect(typeof r.amount_minor === 'string' ? BigInt(r.amount_minor) : r.amount_minor).toBe(150n); // bigint storage, never floats
    await expect(sql`insert into public.expenses(category, description, amount_minor, currency) values ('ai', 'x', 100, 'usd')`).rejects.toThrow(/check constraint/);
  });
});

describe('owner tools', () => {
  it('manual opportunities keep evidence and queue analysis; non-owners refused', async () => {
    await expect(asRole(sql, 'authenticated', STRANGER_ID, (tx) => tx`select public.owner_add_opportunity('t', 'https://x', ${'x'.repeat(30)}, null)`)).rejects.toThrow(/owner authentication/);
    const [{ id }] = await asOwner(sql, (tx) => tx`select public.owner_add_opportunity('Referral: data cleanup', 'mailto:ref', ${'A referral asked for a CSV cleanup script, budget 300 USD.'}, 'Ref Co') as id`);
    expect((await sql`select count(*)::int n from public.opportunity_evidence where opportunity_id = ${id}`)[0].n).toBe(1);
    expect((await sql`select status from public.tasks where idempotency_key = ${'analyze:' + id}`)[0].status).toBe('pending');
  });
});

describe('delivery → invoice automation', () => {
  it('prepares exactly one draft invoice when a project is delivered', async () => {
    const [p] = await sql`insert into public.projects(name, scope, budget_minor, currency) values ('Inv test', 'scope', 50000, 'USD') returning id`;
    for (const s of ['in_progress', 'in_qa', 'ready_for_delivery', 'delivered']) await sql`update public.projects set status = ${s} where id = ${p.id}`;
    let inv = await sql`select status, amount_minor, currency from public.invoices where project_id = ${p.id}`;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ status: 'draft', currency: 'USD' });
    expect(Number(inv[0].amount_minor)).toBe(50000);
    await sql`update public.projects set status = 'accepted' where id = ${p.id}`;
    inv = await sql`select id from public.invoices where project_id = ${p.id}`;
    expect(inv).toHaveLength(1);
  });
});
