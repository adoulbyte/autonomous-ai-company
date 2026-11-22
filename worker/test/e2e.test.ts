import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, freshDb, registerOwner } from './helpers.js';
import { fakeFetch, HN_ITEM, HN_SEARCH, type Responder } from './fakes.js';
import type { Sql } from '../src/db.js';
import { runWorker } from '../src/runtime.js';
import { computeMetrics } from '../src/agents/intelligence.js';

let db: Awaited<ReturnType<typeof freshDb>>; let sql: Sql;
const env = { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv;
const DISCLOSURE = 'This message was prepared by an AI-assisted business system and reviewed by its owner.';
let producerCalls = 0;

const ai: Responder = (prompt) => {
  if (prompt.includes('Analyze this potential business opportunity')) return { body: {
    is_real_request: true, business_model: 'freelance', revenue_mechanism: 'fixed-price contract', buyer_name: 'Acme Logistics',
    stated_budget_usd: 800, est_revenue_usd: 800, est_hours: 10, skills_required: ['python', 'csv', 'automation'], skill_fit: 0.9,
    difficulty: 0.3, competition: 0.4, risk: 0.15, risk_flags: [], p_win: 0.45, p_paid: 0.9, evidence_quality: 0.85, strategic_value: 0.6,
    confidence: 0.7, unknowns: ['data volume'], rationale: 'Explicit budget ($800) and clear scope: CSV validation + Markdown report.' } };
  if (prompt.includes('You are a pricing analyst')) return { body: { low_usd: 600, typical_usd: 900, high_usd: 1400, typical_hourly_rate_usd: 75, rationale: 'Small Python automation with validation and reporting; typical remote rates 50-100 USD/h for ~10h.' } };
  if (prompt.includes('Write a first reply')) return { body: {
    subject: 'Re: Python CSV automation for Acme Logistics',
    body: `Hello Acme team,\n\nYou mentioned needing a Python automation that validates daily shipment CSV exports and produces a Markdown summary plus a cleaned CSV. We can build this as a small, documented script with tests. A good first step would be a sample export (anonymised is fine) so we can confirm the validation rules.\n\nCould you share how many rows a typical file has, and which fields must never be empty?\n\n${DISCLOSURE}`,
    claims_made: ['We can build a documented Python script with tests'], questions_for_buyer: ['Typical row count?'] } };
  if (prompt.includes('You handle the commercial conversation')) return { body: { intent: 'question', agreed_price_usd: null, scope_summary: null, asked_if_ai: false,
    reply: 'Thank you — a typical file of a few thousand rows is fine. We will validate shipment_id and dates; shall we proceed at the quoted price?' } };
  if (prompt.includes('Classify this inbound message')) return { body: { category: 'prospect_reply', intent: 'positive', priority: 'high', summary: 'Buyer wants to proceed', reply_draft: `Thanks! ${DISCLOSURE}` } };
  if (prompt.includes('Turn this agreed project scope into a delivery plan')) return { body: {
    summary: 'CSV validation script with report', out_of_scope: ['hosting'],
    requirements: [{ description: 'Python script validates shipment CSV rows', acceptance_criteria: ['Script rejects rows with empty shipment_id', 'Script outputs a Markdown summary with row counts'] }],
    work_items: [{ key: 'validator', title: 'CSV validator script', requirement_index: 0, format: 'code', instructions: 'Write the Python script with usage docs.' }] } };
  if (prompt.includes('Produce the complete deliverable')) {
    producerCalls++;
    const base = `import csv, sys\n\ndef validate(path):\n    ok, bad = [], []\n    with open(path) as f:\n        for row in csv.DictReader(f):\n            (bad if not row.get('shipment_id') else ok).append(row)\n    return ok, bad\n\nif __name__ == '__main__':\n    ok, bad = validate(sys.argv[1])\n    print(f"# Shipment report\\n\\n- valid rows: {len(ok)}\\n- rejected rows (empty shipment_id): {len(bad)}")\n`;
    return { body: { title: 'validator.py', content: producerCalls === 1 ? base + '\n# TODO handle dates\n' : base, notes: 'Single-file script.', limitations: ['Not run against real client data'] } };
  }
  if (prompt.includes('independent QA reviewer #')) {
    const hasTodo = prompt.includes('# TODO handle dates');
    return { body: { criteria_results: [
      { criterion: 'Script rejects rows with empty shipment_id', met: true, evidence: "bad if not row.get('shipment_id')" },
      { criterion: 'Script outputs a Markdown summary with row counts', met: !hasTodo, evidence: hasTodo ? 'Unfinished TODO present' : 'prints "# Shipment report" with counts' }],
      issues: hasTodo ? ['Contains an unfinished TODO'] : [], summary: hasTodo ? 'Incomplete' : 'Meets all criteria' } };
  }
  return { status: 500, body: { error: `unexpected prompt in test: ${prompt.slice(0, 80)}` } };
};

const net = fakeFetch({ ai, json: {
  'https://hn.algolia.com/api/v1/search_by_date': HN_SEARCH,
  'https://hn.algolia.com/api/v1/items/90000001': HN_ITEM,
  'https://api.github.com/search/issues': { items: [] },
  'https://models.github.ai/catalog/models': [{ id: 'openai/gpt-4.1' }, { id: 'openai/gpt-4.1-mini' }, { id: 'openai/gpt-4.1-nano' }, { id: 'openai/gpt-4o-mini' }, { id: 'meta/Llama-3.3-70B-Instruct' }],
} });
const run = (workerId: string) => runWorker({ sql, workerId, env, fetchFn: net.fn, timeBudgetMs: 120_000 });

beforeAll(async () => { db = await freshDb(); sql = db.sql; await registerOwner(sql); });
afterAll(async () => { await db.drop(); });

describe('end-to-end business workflow', () => {
  let oppId: string; let leadId: string; let projectId: string;

  it('1-6: discovers a real-format opportunity, preserves evidence, scores and explains it, and requests approval to pursue', async () => {
    const r = await run('w-1');
    expect(r.failed).toBe(0);
    const opps = await sql`select * from public.opportunities order by discovered_at`;
    expect(opps.map((o) => o.buyer_name)).toEqual(expect.arrayContaining(['Acme Logistics', 'Sweet Bakery']));
    expect(opps.find((o) => o.title.includes('SEEKING WORK'))).toBeUndefined(); // freelancers advertising are not buyers
    const acme = opps.find((o) => o.buyer_name === 'Acme Logistics')!;
    oppId = acme.id;
    const ev = await sql`select e.* from public.evidence e join public.opportunity_evidence oe on oe.evidence_id = e.id where oe.opportunity_id = ${oppId}`;
    expect(ev[0].excerpt).toContain('Budget around $800');
    expect(ev[0].url).toBe('https://news.ycombinator.com/item?id=90000010');
    expect(acme.status).toBe('pursuing');   // shortlisted, then pursued automatically
    expect(Number(acme.score)).toBeGreaterThanOrEqual(62);
    expect(acme.score_breakdown.components).toHaveLength(10);
    expect(acme.decision_reasons.join(' ')).toMatch(/shortlist threshold/);
    expect(Number(acme.est_revenue_minor)).toBe(80000);
    const bakery = opps.find((o) => o.buyer_name === 'Sweet Bakery')!;
    expect(bakery.status).toBe('rejected');
    expect(bakery.decision_reasons[0]).toMatch(/Prefilter/);
    const [appr] = await sql`select * from public.approvals where action_type = 'opportunity.pursue' and entity_id = ${oppId}`;
    expect(appr.status).toBe('executed');                 // autonomy policy: pursuit is automatic
    expect(appr.decided_by).toBe('policy:auto');
    expect(appr.if_approved).toBeTruthy(); expect(appr.if_rejected).toBeTruthy(); expect(appr.evidence.length).toBeGreaterThan(0);
    // re-running discovery deduplicates
    await sql`update public.sources set next_run_at = now() - interval '1 minute' where key = 'hn_seeking_freelancer'`;
    await run('w-1b');
    expect((await sql`select count(*)::int n from public.opportunities`)[0].n).toBe(opps.length);
  });

  it('7 + 14: automatic pursuit → market-priced lead in CRM → honest outreach draft', async () => {
    await run('w-2');
    const [lead] = await sql`select * from public.leads where opportunity_id = ${oppId}`;
    leadId = lead.id;
    expect(lead.stage).toBe('qualified');
    expect(Number(lead.value_minor)).toBe(80000);          // client stated budget respected (never exceeded)
    expect(lead.quote.basis.join(' ')).toMatch(/stated budget/);
    const [contact] = await sql`select * from public.contacts where id = ${lead.contact_id}`;
    expect(contact.email).toBe('ops@acme-logistics.example');
    const [msg] = await sql`select m.* from public.messages m join public.conversations c on c.id = m.conversation_id where c.lead_id = ${leadId}`;
    expect(msg.status).toBe('approved');                   // autonomy policy: client messages are sent automatically
    expect(msg.body.length).toBeGreaterThan(80);
    const [salesTask] = await sql`select input from public.tasks where type = 'lead.draft_outreach' and entity_id = ${leadId}`;
    expect(salesTask).toBeDefined();
    await asOwner(sql, (tx) => tx`select public.owner_mark_message_sent(${msg.id}, 'sent from mailbox')`);
    expect((await sql`select stage from public.leads where id = ${leadId}`)[0].stage).toBe('contacted');
    // buyer replies → triage → lead engaged
    const [conv] = await sql`select id from public.conversations where lead_id = ${leadId}`;
    await asOwner(sql, (tx) => tx`select public.owner_log_inbound(${conv.id}, ${leadId}, 'Re: Python CSV', 'Sounds good, let us proceed. Price ok.', 'ops@acme-logistics.example')`);
    await run('w-3');
    expect((await sql`select stage from public.leads where id = ${leadId}`)[0].stage).toBe('engaged');
    const history = await sql`select from_stage, to_stage from public.lead_stage_history where lead_id = ${leadId} order by id`;
    expect(history.map((h) => h.to_stage)).toEqual(['qualified', 'contacted', 'engaged']);
  });

  it('8-13: project → plan → agent produces → independent QA rejects → correction → QA approves → delivery prepared', async () => {
    await asOwner(sql, async (tx) => {
      await tx`select public.owner_transition('lead', ${leadId}, 'proposal', null)`;
      await tx`select public.owner_transition('lead', ${leadId}, 'won', 'client accepted $800 fixed price')`;
    });
    const [{ id }] = await asOwner(sql, (tx) => tx`select public.owner_create_project(${leadId}, 'Acme CSV validator', ${'Python script that validates daily shipment CSV exports and prints a Markdown summary.'}, 80000, 'USD', null) as id`);
    projectId = id;
    await run('w-4');
    const dels = await sql`select * from public.deliverables where project_id = ${projectId} order by version`;
    expect(dels.map((d) => [d.version, d.status])).toEqual([[1, 'superseded'], [2, 'ready_for_delivery']]);
    const qa = await sql`select q.* from public.qa_reviews q join public.deliverables d on d.id = q.deliverable_id where d.project_id = ${projectId} order by q.created_at`;
    expect(qa.map((q) => q.verdict)).toEqual(['fail', 'pass', 'pass']);   // two independent passes required
    expect(qa.every((q) => q.reviewer_role === 'qa_reviewer')).toBe(true);
    expect(qa[0].issues.join(' ')).toMatch(/TODO|placeholder/);
    const [p] = await sql`select status from public.projects where id = ${projectId}`;
    expect(p.status).toBe('ready_for_delivery');
    const [payReq] = await sql`select * from public.approvals where entity_id = ${projectId} and action_type = 'payment.request.send'`;
    expect(payReq.status).toBe('pending');
    const [inv] = await sql`select status, amount_minor from public.invoices where project_id = ${projectId}`;
    expect(inv.status).toBe('issued'); expect(Number(inv.amount_minor)).toBe(80000);
    // payment-first: the client cannot receive the work before paying
    await expect(asOwner(sql, (tx) => tx`select public.owner_transition('project', ${projectId}, 'delivered', null)`)).rejects.toThrow(/not paid/);
  });

  it('15-17: finance records; revenue only counts with evidence; metrics reflect real records', async () => {
    const [inv] = await sql`select * from public.invoices where project_id = ${projectId}`;
    const [pending] = await asOwner(sql, (tx) => tx`select * from public.owner_record_payment(${inv.id}, 80000, 'USD', 'redotpay', 'RP-TEST-1', false)`);
    let [fin] = await asOwner(sql, (tx) => tx`select * from public.v_finance_by_currency where currency = 'USD'`);
    expect(Number(fin.confirmed_revenue_minor)).toBe(0);
    expect(Number(fin.receivable_minor)).toBe(80000);
    await expect(asOwner(sql, (tx) => tx`select public.owner_confirm_payment(${pending.id}, 'owner_confirmed', '', null)`)).rejects.toThrow();
    await asOwner(sql, (tx) => tx`select public.owner_confirm_payment(${pending.id}, 'statement_line', 'RedotPay statement 2026-11 line 14', null)`);
    [fin] = await asOwner(sql, (tx) => tx`select * from public.v_finance_by_currency where currency = 'USD'`);
    expect(Number(fin.confirmed_revenue_minor)).toBe(80000);
    expect((await sql`select status from public.invoices where id = ${inv.id}`)[0].status).toBe('paid');
    await run('w-5');   // payment confirmed → delivery released automatically
    expect((await sql`select status from public.projects where id = ${projectId}`)[0].status).toBe('delivered');
    const [delivery] = await sql`select m.status, m.body, m.attachments from public.messages m join public.conversations c on c.id = m.conversation_id where c.project_id = ${projectId} and m.subject like 'Delivery:%'`;
    expect(Buffer.from(delivery.attachments[0].content_b64, 'base64').toString()).toContain('Shipment report');   // files attached
    const m = await computeMetrics(sql);
    expect(m.leads_won).toBe(1); expect(m.revenue_confirmed_minor).toBe(80000);
    expect(m.qa_failure_rate).toBeCloseTo(1 / 3); expect(m.revisions).toBe(1);
    expect((await sql`select count(*)::int n from public.metric_snapshots`)[0].n).toBeGreaterThan(10);
    expect((await sql`select count(*)::int n from public.audit_log`)[0].n).toBeGreaterThan(10);
    const dead = await sql`select type, error from public.tasks where status = 'dead'`;
    expect(dead).toEqual([]);
  });

  it('AI outage: tasks are deferred and recoverable, never marked complete', async () => {
    await sql`insert into public.opportunities(source_key, external_id, fingerprint, title, description, url) values ('manual', 'out-1', 'fp-out-1', 'Python API integration', 'Need python api work', 'https://example.test/1')`;
    const [o] = await sql`select id from public.opportunities where external_id = 'out-1'`;
    const [e] = await sql`insert into public.evidence(source_key, url, content_hash, excerpt) values ('manual', 'https://example.test/1', 'h-out-1', 'Need python api work') returning id`;
    await sql`insert into public.opportunity_evidence values (${o.id}, ${e.id})`;
    await sql`select public.enqueue_task(p_type => 'opportunity.analyze', p_idempotency_key => 'outage-1', p_input => ${sql.json({ opportunity_id: o.id } as never)}, p_role_key => 'research_analyst')`;
    const down = fakeFetch({ ai: () => ({ status: 503 }), json: {} });
    await runWorker({ sql, workerId: 'w-outage', env, fetchFn: down.fn, timeBudgetMs: 60_000, maxTasks: 3 });
    const [t] = await sql`select status, attempts, deferrals, output from public.tasks where idempotency_key = 'outage-1'`;
    expect(t.status).toBe('retry_wait'); expect(t.deferrals).toBe(1); expect(t.output).toBeNull();
    expect((await sql`select score from public.opportunities where id = ${o.id}`)[0].score).toBeNull();
  });
});
