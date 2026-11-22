import type { Sql } from './db.js';
import { getSetting, logEvent } from './db.js';
import { AiGateway, type FetchLike } from './ai/gateway.js';
import { claim, defer, enqueue, fail, heartbeat, type TaskRow } from './queue.js';
import { DeferError, PermanentError } from './errors.js';
import { LeaseLostError, type Handler } from './agents/context.js';
import { analyzeOpportunity, runSource, scoreOpportunityTask } from './agents/opportunity.js';
import { draftOutreach, triageMessage } from './agents/sales.js';
import { deliverProject, planProject, prepareDelivery, produceDeliverable, reviewDeliverable } from './agents/production.js';
import { quoteLead } from './agents/pricing.js';
import { analyticsSnapshot, healthCheck, strategyReview } from './agents/intelligence.js';
import { scrubSecrets } from './sanitize.js';

export const HANDLERS: Record<string, Handler> = {
  'discovery.run_source': runSource,
  'opportunity.analyze': analyzeOpportunity,
  'opportunity.score': scoreOpportunityTask,
  'lead.draft_outreach': draftOutreach,
  'comms.triage': triageMessage,
  'project.plan': planProject,
  'production.execute': produceDeliverable,
  'qa.review': reviewDeliverable,
  'project.prepare_delivery': prepareDelivery,
  'project.deliver': deliverProject,
  'pricing.quote': quoteLead,
  'analytics.snapshot': analyticsSnapshot,
  'strategy.review': strategyReview,
  'system.health_check': healthCheck,
};

export interface RuntimeOptions {
  sql: Sql; workerId: string; env?: NodeJS.ProcessEnv; fetchFn?: FetchLike; timeBudgetMs?: number; runUrl?: string;
  /** stop after this many tasks (tests) */
  maxTasks?: number;
  log?: (msg: string) => void;
}

/** Deterministic scheduler: enqueue due work idempotently (safe to run concurrently / repeatedly). */
export async function scheduleDueWork(sql: Sql, now = new Date()): Promise<Record<string, number>> {
  const recovered = Number((await sql`select public.recover_expired_leases() as n`)[0].n);
  const expired = Number((await sql`select public.expire_approvals() as n`)[0].n);
  const executed = Number((await sql`select public.execute_approved_actions() as n`)[0].n);
  let sources = 0;
  const due = await sql`select key, name, interval_minutes from public.sources where enabled and kind = 'api' and next_run_at <= ${now}`;
  for (const s of due) {
    const slot = Math.floor(now.getTime() / (Number(s.interval_minutes) * 60_000));
    await enqueue(sql, { type: 'discovery.run_source', key: `discovery:${s.key}:${slot}`, role: 'opportunity_scout', entityType: 'source',
      entityId: s.key as string, input: { source_key: s.key }, priority: 30, title: `Discover: ${s.name}`, timeoutSeconds: 180 });
    await sql`update public.sources set next_run_at = ${new Date(now.getTime() + Number(s.interval_minutes) * 60_000)} where key = ${s.key}`;
    sources++;
  }
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < 2) await sql`select public.apply_retention()`; // once per night (pg_cron also runs it when available)
  await enqueue(sql, { type: 'analytics.snapshot', key: `analytics:${day}:${Math.floor(now.getUTCHours() / 6)}`, role: 'business_intelligence', priority: 20, title: 'Metrics snapshot' });
  await enqueue(sql, { type: 'system.health_check', key: `health:${day}:${Math.floor(now.getUTCHours() / 6)}`, role: 'orchestrator', priority: 25, title: 'System health check' });
  const week = Math.floor(now.getTime() / (7 * 86_400_000));
  await enqueue(sql, { type: 'strategy.review', key: `strategy:${week}`, role: 'executive_strategist', priority: 10, title: 'Weekly strategy review', timeoutSeconds: 300 });
  // CRM reminders and follow-ups surface as alerts (once).
  const reminders = await sql`update public.reminders set notified_at = now() where done_at is null and notified_at is null and due_at <= now() returning id, title, entity_type, entity_id`;
  for (const r of reminders) await logEvent(sql, String(r.entity_type), String(r.entity_id), 'reminder_due', `Reminder due: ${r.title}`, {}, 'warning');
  const followUps = await sql`update public.leads set next_follow_up_at = null where stage = 'contacted' and next_follow_up_at <= now() returning id, title`;
  for (const l of followUps) await logEvent(sql, 'lead', String(l.id), 'follow_up_due', `Follow-up due for "${l.title}" (no reply logged)`, {}, 'warning');
  return { recovered, expired, executed, sources, reminders: reminders.length, follow_ups: followUps.length };
}

export async function executeTask(o: RuntimeOptions, ai: AiGateway, task: TaskRow): Promise<'succeeded' | string> {
  const handler = HANDLERS[task.type];
  const log = o.log ?? (() => {});
  if (!handler) { await fail(o.sql, task.id, o.workerId, `no handler for task type ${task.type}`, false); return 'dead'; }
  const hb = setInterval(() => { heartbeat(o.sql, task.id, o.workerId).catch(() => {}); }, 30_000);
  const timeoutMs = task.timeout_seconds * 1000;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      handler({ sql: o.sql, ai, task, workerId: o.workerId, env: o.env ?? process.env, fetchFn: o.fetchFn as typeof fetch | undefined,
        heartbeat: async (p, n) => { await heartbeat(o.sql, task.id, o.workerId, p, n); } }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`task timed out after ${task.timeout_seconds}s`)), timeoutMs); }),
    ]);
    log(`✓ ${task.type} ${task.id}`);
    return 'succeeded';
  } catch (e) {
    const err = e as Error;
    const msg = scrubSecrets(`${err.name}: ${err.message}`);
    if (err instanceof LeaseLostError) { log(`! lease lost ${task.id}`); return 'lease_lost'; }
    if (err instanceof DeferError) { log(`… deferred ${task.type}: ${msg}`); return defer(o.sql, task.id, o.workerId, err.seconds, msg); }
    const state = await fail(o.sql, task.id, o.workerId, msg, !(err instanceof PermanentError));
    log(`✗ ${task.type} ${task.id} → ${state}: ${msg}`);
    return state;
  } finally {
    clearInterval(hb); if (timer) clearTimeout(timer);
  }
}

/** One bounded worker run (serverless-friendly): schedule, then drain the queue until the time budget is spent. */
export async function runWorker(o: RuntimeOptions): Promise<{ succeeded: number; failed: number; schedule: Record<string, number> }> {
  const log = o.log ?? (() => {});
  const started = Date.now();
  const budget = o.timeBudgetMs ?? (await getSetting<number>(o.sql, 'worker.time_budget_seconds', 420)) * 1000;
  await o.sql`insert into public.worker_heartbeats(worker_id, run_url) values (${o.workerId}, ${o.runUrl ?? null})
      on conflict (worker_id) do update set last_seen_at = now(), status = 'running'`;
  const schedule = await scheduleDueWork(o.sql);
  log(`schedule: ${JSON.stringify(schedule)}`);
  const ai = new AiGateway(o.sql, o.env ?? process.env, o.fetchFn ?? fetch);
  let succeeded = 0, failed = 0, n = 0;
  try {
    while (Date.now() - started < budget - 20_000) {
      if (o.maxTasks != null && n >= o.maxTasks) break;
      const [task] = await claim(o.sql, o.workerId, 1);
      if (!task) break;
      n++;
      const r = await executeTask(o, ai, task);
      if (r === 'succeeded') succeeded++; else failed++;
      await o.sql`update public.worker_heartbeats set last_seen_at = now(), tasks_succeeded = ${succeeded}, tasks_failed = ${failed} where worker_id = ${o.workerId}`;
    }
  } finally {
    await o.sql`update public.worker_heartbeats set last_seen_at = now(), status = 'finished', tasks_succeeded = ${succeeded}, tasks_failed = ${failed},
        note = ${`ran ${n} tasks in ${Math.round((Date.now() - started) / 1000)}s`} where worker_id = ${o.workerId}`;
    await o.sql`delete from public.worker_heartbeats where last_seen_at < now() - interval '14 days'`;
  }
  return { succeeded, failed, schedule };
}
