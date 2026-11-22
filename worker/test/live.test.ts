/**
 * LIVE test — runs only with LIVE=1 (GitHub Actions "Live end-to-end" workflow).
 * Uses real public sources (HN Search API, GitHub Search API) and real AI (GitHub Models via GITHUB_TOKEN).
 * Owner actions are performed exactly as the dashboard performs them (owner-authenticated RPCs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, freshDb, registerOwner } from './helpers.js';
import type { Sql } from '../src/db.js';
import { runWorker } from '../src/runtime.js';

const LIVE = process.env.LIVE === '1';
let db: Awaited<ReturnType<typeof freshDb>>; let sql: Sql;
const log = (m: string) => console.log(`[live] ${m}`);
const run = (id: string, maxTasks = 40) => runWorker({ sql, workerId: id, env: process.env, timeBudgetMs: 6 * 60_000, maxTasks, log });

describe.skipIf(!LIVE)('LIVE pipeline with real sources and real AI', () => {
  beforeAll(async () => {
    db = await freshDb(); sql = db.sql; await registerOwner(sql);
    await sql`update public.sources set max_items_per_run = 6 where key = 'hn_seeking_freelancer'`;
    await sql`update public.sources set max_items_per_run = 4 where key = 'github_bounties'`;
  });
  afterAll(async () => { await db?.drop(); });

  let best: Record<string, any> | undefined;

  it('discovers real opportunities, analyses them with a real model and scores them', async () => {
    const r = await run('live-1', 30);
    log(`worker: ${JSON.stringify(r)}`);
    const opps = await sql`select id, title, source_key, status, score, decision, decision_reasons, est_revenue_minor, url, analysis->>'model' as model from public.opportunities order by score desc nulls last`;
    log(`opportunities: ${opps.length}`);
    for (const o of opps) log(`  [${o.status}] score=${o.score ?? '-'} ${o.source_key} ${String(o.title).slice(0, 90)} ${o.url} model=${o.model ?? '-'}`);
    expect(opps.length).toBeGreaterThan(0);
    const withEvidence = await sql`select count(distinct opportunity_id)::int n from public.opportunity_evidence`;
    expect(withEvidence[0].n).toBe(opps.length);
    const calls = await sql`select provider_key, model, status, count(*)::int n from public.ai_calls group by 1,2,3`;
    log(`ai calls: ${JSON.stringify(calls)}`);
    const scored = opps.filter((o) => o.score != null);
    expect(scored.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.status === 'ok')).toBe(true);
    best = scored[0];
    const dead = await sql`select type, error from public.tasks where status = 'dead'`;
    if (dead.length) log(`dead tasks: ${JSON.stringify(dead)}`);
  }, 900_000);

  it('pursues the best real opportunity: CRM lead + honest outreach draft awaiting approval', async () => {
    expect(best).toBeDefined();
    await asOwner(sql, (tx) => tx`select public.owner_pursue_opportunity(${best!.id})`);
    await run('live-2', 5);
    const [lead] = await sql`select * from public.leads where opportunity_id = ${best!.id}`;
    expect(lead).toBeDefined();
    const msgs = await sql`select m.status, m.subject, m.body from public.messages m join public.conversations c on c.id = m.conversation_id where c.lead_id = ${lead.id}`;
    const task = await sql`select status, error from public.tasks where type = 'lead.draft_outreach'`;
    log(`outreach task: ${JSON.stringify(task)}`);
    if (msgs[0]) log(`outreach draft (${msgs[0].status}):\n${msgs[0].subject}\n${msgs[0].body}`);
    expect(msgs.length + task.filter((t) => t.status === 'retry_wait').length).toBeGreaterThan(0);
    if (msgs[0]) { expect(msgs[0].status).toBe('awaiting_approval'); expect(msgs[0].body).toContain('AI-assisted'); }
  }, 600_000);

  it('turns it into a project: real AI plans, produces a deliverable, and independent QA reviews it', async () => {
    const [lead] = await sql`select id from public.leads where opportunity_id = ${best!.id}`;
    const [opp] = await sql`select title, description from public.opportunities where id = ${best!.id}`;
    await asOwner(sql, async (tx) => {
      await tx`select public.owner_transition('lead', ${lead.id}, 'proposal', null)`;
      await tx`select public.owner_transition('lead', ${lead.id}, 'won', 'live test: simulated client agreement on a scoped first deliverable')`;
    });
    const scope = `First deliverable for: ${opp.title}\n\nProduce a concise written technical proposal and implementation plan (architecture, steps, risks, estimate) that responds to this request:\n${String(opp.description).slice(0, 1500)}`;
    const [{ id }] = await asOwner(sql, (tx) => tx`select public.owner_create_project(${lead.id}, ${'Live test: ' + String(opp.title).slice(0, 60)}, ${scope}, 50000, 'USD', null) as id`);
    await sql`update public.projects set max_qa_cycles = 2 where id = ${id}`;
    for (let i = 0; i < 4; i++) {
      await run(`live-3-${i}`, 12);
      const [p] = await sql`select status from public.projects where id = ${id}`;
      log(`project status after run ${i}: ${p.status}`);
      if (['ready_for_delivery', 'on_hold'].includes(p.status)) break;
    }
    const dels = await sql`select id, title, version, status, produced_by_model, left(content, 700) as excerpt from public.deliverables where project_id = ${id} order by version`;
    const qa = await sql`select q.verdict, q.reviewer_role, q.model, q.summary, q.issues from public.qa_reviews q join public.deliverables d on d.id = q.deliverable_id where d.project_id = ${id} order by q.created_at`;
    for (const d of dels) log(`deliverable v${d.version} [${d.status}] by ${d.produced_by_model}: ${d.title}\n${d.excerpt}…`);
    for (const r of qa) log(`QA ${r.verdict} by ${r.reviewer_role}/${r.model}: ${r.summary} ${JSON.stringify(r.issues).slice(0, 400)}`);
    const tasks = await sql`select type, status, attempts, deferrals, error from public.tasks where entity_id = ${id} or input->>'project_id' = ${id}`;
    log(`project tasks: ${JSON.stringify(tasks)}`);
    expect(dels.length).toBeGreaterThan(0);
    expect(qa.length).toBeGreaterThan(0);
    expect(qa.every((r) => r.reviewer_role === 'qa_reviewer')).toBe(true);
  }, 1_200_000);
});
