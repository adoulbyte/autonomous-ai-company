import { z } from 'zod';
import type { Handler } from './context.js';
import { finish } from './context.js';
import type { Sql, Tx } from '../db.js';
import { getSetting } from '../db.js';
import { requestApproval } from '../queue.js';
import { validateWeights, type ScoringWeights } from '../scoring.js';

/** Compute today's metrics from real records only. Deterministic. */
export async function computeMetrics(sql: Sql | Tx): Promise<Record<string, number>> {
  const [m] = await sql`select
    (select count(*) from public.opportunities)::int as opportunities_total,
    (select count(*) from public.opportunities where discovered_at >= date_trunc('day', now()))::int as opportunities_today,
    (select count(*) from public.opportunities where status in ('discovered','analyzing'))::int as opportunities_in_evaluation,
    (select count(*) from public.opportunities where score is not null)::int as opportunities_scored,
    (select count(*) from public.opportunities where status in ('shortlisted','pursuing','won','lost'))::int as opportunities_selected,
    (select count(*) from public.opportunities where status = 'rejected')::int as opportunities_rejected,
    (select count(*) from public.leads)::int as leads_total,
    (select count(*) from public.leads where stage in ('contacted','engaged','proposal','negotiating','won','lost'))::int as leads_contacted,
    (select count(*) from public.leads where stage in ('engaged','proposal','negotiating','won'))::int as leads_responded,
    (select count(*) from public.leads where stage = 'won')::int as leads_won,
    (select count(*) from public.leads where stage in ('lost','disqualified'))::int as leads_lost,
    (select count(*) from public.projects)::int as projects_total,
    (select count(*) from public.projects where status in ('planning','in_progress','in_qa','revision','ready_for_delivery'))::int as projects_active,
    (select count(*) from public.projects where status in ('delivered','accepted','closed'))::int as projects_delivered,
    (select count(*) from public.qa_reviews)::int as qa_reviews,
    (select count(*) from public.qa_reviews where verdict = 'fail')::int as qa_failures,
    (select count(*) from public.deliverables where version = 1)::int as deliverables_first_versions,
    (select count(*) from public.deliverables d where d.version = 1 and exists (select 1 from public.qa_reviews q where q.deliverable_id = d.id and q.verdict = 'pass'))::int as deliverables_first_pass,
    (select count(*) from public.deliverables where version > 1)::int as revisions,
    (select coalesce(sum(amount_minor),0) from public.payments where status = 'confirmed')::bigint as revenue_confirmed_minor,
    (select coalesce(sum(amount_minor),0) from public.expenses)::bigint as expenses_minor,
    (select count(*) from public.ai_calls where at >= date_trunc('day', now()))::int as ai_calls_today,
    (select coalesce(sum(prompt_tokens + completion_tokens),0) from public.ai_calls where at >= date_trunc('day', now()))::bigint as ai_tokens_today,
    (select count(*) from public.tasks where status = 'dead')::int as tasks_dead,
    (select count(*) from public.tasks where status = 'succeeded' and finished_at >= date_trunc('day', now()))::int as tasks_succeeded_today,
    (select coalesce(avg(extract(epoch from (p.confirmed_at - i.issue_date::timestamptz)) / 86400), 0) from public.payments p join public.invoices i on i.id = p.invoice_id where p.status = 'confirmed')::float as avg_days_to_payment,
    (select coalesce(avg(extract(epoch from (delivered_at - created_at)) / 86400), 0) from public.projects where delivered_at is not null)::float as avg_days_to_delivery`;
  const r: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) r[k] = Number(v);
  r.win_rate = r.leads_won + r.leads_lost > 0 ? r.leads_won / (r.leads_won + r.leads_lost) : 0;
  r.response_rate = r.leads_contacted > 0 ? r.leads_responded / r.leads_contacted : 0;
  r.qa_failure_rate = r.qa_reviews > 0 ? r.qa_failures / r.qa_reviews : 0;
  r.qa_first_pass_rate = r.deliverables_first_versions > 0 ? r.deliverables_first_pass / r.deliverables_first_versions : 0;
  r.selection_rate = r.opportunities_scored > 0 ? r.opportunities_selected / r.opportunities_scored : 0;
  return r;
}

export const analyticsSnapshot: Handler = async (ctx) => finish(ctx, async (tx) => {
  const metrics = await computeMetrics(tx);
  for (const [metric, value] of Object.entries(metrics)) {
    await tx`insert into public.metric_snapshots(day, metric, value) values (current_date, ${metric}, ${value})
        on conflict (day, metric, dimension) do update set value = excluded.value, computed_at = now()`;
  }
  const sources = await tx`select key, opportunities, shortlisted_or_better, won from public.v_source_performance`;
  for (const s of sources) {
    for (const [metric, value] of [['source_opportunities', s.opportunities], ['source_selected', s.shortlisted_or_better], ['source_won', s.won]] as const) {
      await tx`insert into public.metric_snapshots(day, metric, dimension, value) values (current_date, ${metric}, ${'source:' + s.key}, ${Number(value)})
          on conflict (day, metric, dimension) do update set value = excluded.value, computed_at = now()`;
    }
  }
  return { metrics: Object.keys(metrics).length };
});

const StrategySchema = z.object({
  summary: z.string().max(1500),
  recommendations: z.array(z.string().max(400)).max(8),
  proposed_weights: z.record(z.string(), z.number()).nullable(),
  data_sufficient: z.boolean(),
});

/** strategy.review — Executive Strategist. Proposes; never applies. Changes to critical rules require approval. */
export const strategyReview: Handler = async (ctx) => {
  const metrics = await computeMetrics(ctx.sql);
  const weights = await getSetting<ScoringWeights>(ctx.sql, 'scoring.weights', null as never);
  const decided = await ctx.sql`select decision, count(*)::int as n, round(avg(score),1) as avg_score from public.opportunities where score is not null group by decision`;
  const sources = await ctx.sql`select * from public.v_source_performance`;
  const periodEnd = new Date(); const periodStart = new Date(Date.now() - 7 * 86_400_000);
  const minData = metrics.opportunities_scored >= 15;

  let summary: string; let recommendations: string[] = []; let proposed: ScoringWeights | null = null; let model: string | null = null;
  if (!minData) {
    summary = `Insufficient data for strategy changes: only ${metrics.opportunities_scored} scored opportunities and ${metrics.leads_won + metrics.leads_lost} closed leads. Keeping current weights.`;
  } else {
    const res = await ctx.ai.generate({ roleKey: 'executive_strategist', taskId: ctx.task.id, tier: 'strong', schema: StrategySchema, maxTokens: 1500,
      messages: [{ role: 'user', content: `Review our real operating metrics and propose evidence-based adjustments. Only cite numbers present below.
If outcomes (wins/losses/payments) are too few to justify changing scoring weights, set proposed_weights to null and data_sufficient false.
If you propose weights, use exactly the same keys as current weights (excluding "version"), each 0..1, summing to 1, and change any weight by at most 0.05.
Return JSON {summary, recommendations[], proposed_weights|null, data_sufficient}.
Metrics: ${JSON.stringify(metrics)}
Decisions: ${JSON.stringify(decided)}
Sources: ${JSON.stringify(sources)}
Current weights: ${JSON.stringify(weights)}` }] });
    summary = res.data.summary; recommendations = res.data.recommendations; model = res.model;
    if (res.data.proposed_weights && res.data.data_sufficient) {
      const cand = { ...weights, ...res.data.proposed_weights, version: weights.version + 1 } as ScoringWeights;
      try {
        validateWeights(cand);
        const tooBig = (Object.keys(weights) as (keyof ScoringWeights)[]).some((k) => k !== 'version' && Math.abs((cand[k] as number) - (weights[k] as number)) > 0.0501);
        if (!tooBig) proposed = cand; else recommendations.push('(Proposed weight change exceeded the ±0.05 guardrail and was discarded.)');
      } catch (e) { recommendations.push(`(Proposed weights invalid and discarded: ${(e as Error).message})`); }
    }
  }

  return finish(ctx, async (tx) => {
    let approvalId: string | null = null;
    if (proposed) {
      approvalId = await requestApproval(tx, {
        actionType: 'settings.change', title: 'Adjust opportunity scoring weights', requestedBy: 'executive_strategist',
        reason: summary, evidence: [{ metrics }, { current: weights }, { proposed }], expectedBenefit: recommendations.join(' '),
        risk: 'Changes which opportunities get shortlisted. Bounded to ±0.05 per weight.', riskLevel: 'medium',
        ifApproved: `scoring.weights is updated to version ${proposed.version}; future scores use it (past decisions keep their recorded version).`,
        ifRejected: 'Weights stay unchanged.', payload: { key: 'scoring.weights', value: proposed }, key: `strategy-weights:${ctx.task.id}`, taskId: ctx.task.id,
      });
    }
    await tx`insert into public.strategy_reviews(period_start, period_end, metrics, summary, recommendations, proposed_settings, approval_id, task_id)
        values (${periodStart}, ${periodEnd}, ${tx.json(metrics as never)}, ${summary}, ${tx.json(recommendations as never)},
          ${proposed ? tx.json(proposed as never) : null}, ${approvalId}, ${ctx.task.id})`;
    return { summary, proposed: !!proposed, model };
  });
};

/** system.health_check — verifies DB, AI providers (catalog), sources; disables models missing from provider catalog. */
export const healthCheck: Handler = async (ctx) => {
  const results: { component: string; status: 'healthy' | 'degraded' | 'down'; detail: string }[] = [];
  results.push({ component: 'database', status: 'healthy', detail: 'query ok' });
  const fetchFn = ctx.fetchFn ?? fetch;
  if (ctx.env.GITHUB_TOKEN) {
    try {
      const res = await fetchFn('https://models.github.ai/catalog/models', { headers: { authorization: `Bearer ${ctx.env.GITHUB_TOKEN}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const catalog = (await res.json()) as { id: string }[];
        const ids = new Set(catalog.map((m) => m.id));
        const registered = await ctx.sql`select model from public.ai_models where provider_key = 'github_models'`;
        const missing = registered.map((r) => r.model as string).filter((m) => !ids.has(m));
        if (missing.length) await ctx.sql`update public.ai_models set enabled = false, last_error = 'not present in provider catalog' where provider_key = 'github_models' and model = any(${missing})`;
        const present = registered.map((r) => r.model as string).filter((m) => ids.has(m));
        if (present.length) await ctx.sql`update public.ai_models set enabled = true, last_error = null where provider_key = 'github_models' and model = any(${present}) and last_error = 'not present in provider catalog'`;
        results.push({ component: 'ai:github_models', status: missing.length === registered.length ? 'down' : 'healthy', detail: `${catalog.length} models in catalog; ${missing.length} registered models missing` });
      } else results.push({ component: 'ai:github_models', status: 'degraded', detail: `catalog HTTP ${res.status}` });
    } catch (e) { results.push({ component: 'ai:github_models', status: 'degraded', detail: (e as Error).message }); }
  } else results.push({ component: 'ai:github_models', status: 'down', detail: 'GITHUB_TOKEN not available to worker' });
  const providers = await ctx.sql`select key, api_key_env from public.ai_providers where key <> 'github_models' and enabled`;
  for (const p of providers) results.push({ component: `ai:${p.key}`, status: ctx.env[p.api_key_env as string] ? 'healthy' : 'down', detail: ctx.env[p.api_key_env as string] ? 'key configured' : 'no API key configured (optional)' });
  const sources = await ctx.sql`select key, health, last_error from public.sources where enabled`;
  for (const s of sources) results.push({ component: `source:${s.key}`, status: s.health === 'unknown' ? 'degraded' : s.health as 'healthy', detail: (s.last_error as string) ?? String(s.health) });

  return finish(ctx, async (tx) => {
    for (const r of results) await tx`insert into public.health_checks(component, status, detail) values (${r.component}, ${r.status}, ${r.detail.slice(0, 500)})`;
    const toolHealth: Record<string, string> = {
      llm: results.some((r) => r.component.startsWith('ai:') && r.status === 'healthy') ? 'healthy' : 'down',
      db: 'healthy',
    };
    for (const [k, h] of Object.entries(toolHealth)) await tx`update public.tools set health = ${h}, last_check_at = now() where key = ${k}`;
    await tx`delete from public.health_checks where at < now() - interval '30 days'`;
    return { checks: results.length };
  });
};
