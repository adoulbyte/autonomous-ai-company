import { z } from 'zod';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { CONNECTORS } from '../connectors/index.js';
import { PermanentError, RetryableError } from '../errors.js';
import { clamp01, detectInjection, normalizeForFingerprint, sha256, untrusted } from '../sanitize.js';
import { enqueue } from '../queue.js';
import { getSetting, logEvent } from '../db.js';
import { scoreOpportunity, type ScoringRules, type ScoringWeights } from '../scoring.js';

interface BusinessProfile { name: string; positioning: string; skills: string[]; excluded: string[]; target_hourly_rate_minor: number; currency: string; disclosure: string }

/** Deterministic prefilter: avoid spending AI calls on items with no overlap with what we can deliver. */
export function skillOverlap(text: string, skills: string[]): string[] {
  const t = text.toLowerCase();
  const extra = ['developer', 'engineer', 'automation', 'script', 'api', 'website', 'web app', 'backend', 'frontend', 'data', 'ai', 'llm',
    'scrap', 'integration', 'python', 'javascript', 'typescript', 'react', 'node', 'research', 'writer', 'writing', 'docs', 'bug', 'fix', 'feature'];
  return [...new Set([...skills, ...extra])].filter((s) => {
    const k = s.toLowerCase().split(/[\s/(]/)[0];
    return k.length >= 2 && new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t);
  });
}

// ---------------------------------------------------------------------------
// discovery.run_source — Opportunity Scout (deterministic connector)
// ---------------------------------------------------------------------------
export const runSource: Handler = async (ctx) => {
  const key = String(ctx.task.input.source_key ?? '');
  const [source] = await ctx.sql`select * from public.sources where key = ${key}`;
  if (!source) throw new PermanentError(`unknown source ${key}`);
  if (!source.enabled) return finish(ctx, async () => ({ skipped: 'source disabled' }));
  const connector = CONNECTORS[source.connector as string];
  if (!connector) throw new PermanentError(`no connector ${source.connector}`);

  let items;
  try {
    items = await connector({ config: source.config as Record<string, unknown>, maxItems: source.max_items_per_run as number, env: ctx.env, fetchFn: ctx.fetchFn });
  } catch (e) {
    await ctx.sql`update public.sources set health = case when consecutive_failures >= 2 then 'down' else 'degraded' end,
      consecutive_failures = consecutive_failures + 1, last_error = ${(e as Error).message.slice(0, 500)}, last_run_at = now() where key = ${key}`;
    throw e;
  }
  const profile = await getSetting<BusinessProfile>(ctx.sql, 'business.profile', { skills: [] } as unknown as BusinessProfile);

  return finish(ctx, async (tx) => {
    let created = 0, duplicates = 0, prefiltered = 0;
    for (const it of items) {
      const contentHash = sha256(it.text);
      const [ev] = await tx`insert into public.evidence(source_key, url, content_hash, title, excerpt, raw)
          values (${key}, ${it.url}, ${contentHash}, ${it.title}, ${it.text}, ${tx.json(it.raw as never)})
          on conflict (url, content_hash) do update set fetched_at = now() returning id`;
      const fingerprint = sha256(normalizeForFingerprint(`${it.title} ${it.text}`));
      const existing = await tx`select id from public.opportunities
          where (source_key = ${key} and external_id = ${it.externalId}) or fingerprint = ${fingerprint} limit 1`;
      if (existing.length) {
        await tx`insert into public.opportunity_evidence(opportunity_id, evidence_id) values (${existing[0].id}, ${ev.id}) on conflict do nothing`;
        await tx`update public.opportunities set last_verified_at = now() where id = ${existing[0].id}`;
        duplicates++; continue;
      }
      // near-duplicate across sources: same buyer + very similar title
      const near = await tx`select id from public.opportunities where lower(coalesce(buyer_name,'')) = lower(${it.buyerName ?? ''})
          and similarity(title, ${it.title}) > 0.8 limit 1`;
      if (near.length) {
        await tx`insert into public.opportunity_evidence(opportunity_id, evidence_id) values (${near[0].id}, ${ev.id}) on conflict do nothing`;
        duplicates++; continue;
      }
      const [opp] = await tx`insert into public.opportunities(source_key, external_id, fingerprint, title, description, url,
            buyer_name, buyer_contact, posted_at, last_verified_at)
          values (${key}, ${it.externalId}, ${fingerprint}, ${it.title}, ${it.text.slice(0, 4000)}, ${it.url},
            ${it.buyerName ?? null}, ${it.buyerContact ?? null}, ${it.postedAt ?? null}, now()) returning id`;
      await tx`insert into public.opportunity_evidence(opportunity_id, evidence_id) values (${opp.id}, ${ev.id})`;
      created++;
      const overlap = skillOverlap(it.text, profile.skills ?? []);
      if (overlap.length === 0) {
        await tx`update public.opportunities set status = 'rejected', decision = 'reject',
            decision_reasons = ${['Prefilter: no overlap with business skills (no AI call spent)']} where id = ${opp.id}`;
        await tx`insert into public.opportunity_decisions(opportunity_id, decision, reasons, decided_by)
            values (${opp.id}, 'reject', ${['Prefilter: no overlap with business skills']}, 'agent:opportunity_scout')`;
        prefiltered++; continue;
      }
      await enqueue(tx, { type: 'opportunity.analyze', key: `analyze:${opp.id}`, role: 'research_analyst', entityType: 'opportunity',
        entityId: opp.id, input: { opportunity_id: opp.id }, priority: 40, title: `Analyze: ${it.title.slice(0, 80)}`, timeoutSeconds: 240 });
    }
    await tx`update public.sources set last_run_at = now(), health = 'healthy', consecutive_failures = 0, last_error = null,
        items_found_total = items_found_total + ${created} where key = ${key}`;
    await logEvent(tx, 'source', key, 'discovery_completed', `${source.name}: ${items.length} items, ${created} new, ${duplicates} duplicates, ${prefiltered} prefiltered`,
      { found: items.length, created, duplicates, prefiltered });
    return { found: items.length, created, duplicates, prefiltered };
  });
};

// ---------------------------------------------------------------------------
// opportunity.analyze — Research Analyst (AI, structured, conservative)
// ---------------------------------------------------------------------------
export const AnalysisSchema = z.object({
  is_real_request: z.boolean(),
  business_model: z.enum(['freelance', 'ai_services', 'digital_product', 'affiliate', 'partnership', 'bounty', 'retainer', 'other']),
  revenue_mechanism: z.string().max(200),
  buyer_name: z.string().max(120).nullable().optional(),
  stated_budget_usd: z.number().nonnegative().nullable().optional(),
  est_revenue_usd: z.number().nonnegative().nullable(),
  est_hours: z.number().nonnegative().nullable(),
  skills_required: z.array(z.string().max(60)).max(15),
  skill_fit: z.number().min(0).max(1),
  difficulty: z.number().min(0).max(1),
  competition: z.number().min(0).max(1),
  risk: z.number().min(0).max(1),
  risk_flags: z.array(z.string().max(40)).max(10),
  p_win: z.number().min(0).max(1),
  p_paid: z.number().min(0).max(1),
  evidence_quality: z.number().min(0).max(1),
  strategic_value: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  unknowns: z.array(z.string().max(200)).max(10),
  rationale: z.string().max(2000),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const analyzeOpportunity: Handler = async (ctx) => {
  const id = String(ctx.task.input.opportunity_id);
  const [opp] = await ctx.sql`select * from public.opportunities where id = ${id}`;
  if (!opp) throw new PermanentError('opportunity not found');
  if (!['discovered', 'analyzing', 'monitoring'].includes(opp.status as string)) {
    return finish(ctx, async () => ({ skipped: `status ${opp.status}` }));
  }
  const evidence = await ctx.sql`select e.url, e.excerpt, e.fetched_at from public.evidence e
      join public.opportunity_evidence oe on oe.evidence_id = e.id where oe.opportunity_id = ${id} order by e.fetched_at desc limit 3`;
  if (!evidence.length) throw new PermanentError('no evidence attached; refusing to analyze');
  if (opp.status !== 'analyzing') await ctx.sql`update public.opportunities set status = 'analyzing' where id = ${id}`;

  const profile = await getSetting<BusinessProfile>(ctx.sql, 'business.profile', {} as BusinessProfile);
  const injection = evidence.some((e) => detectInjection(String(e.excerpt)));
  const prompt = `Analyze this potential business opportunity for our company and return JSON with exactly these keys:
is_real_request (bool: a genuine request for paid work/purchase?), business_model (freelance|ai_services|digital_product|affiliate|partnership|bounty|retainer|other),
revenue_mechanism (string), buyer_name (string|null), stated_budget_usd (number|null, ONLY if explicitly stated), est_revenue_usd (number|null: realistic contract value; use stated budget if present, else estimate est_hours × typical market rate, null if impossible),
est_hours (number|null), skills_required (string[]), skill_fit (0-1: how well OUR skills cover it), difficulty (0-1), competition (0-1: expected number of competing bidders),
risk (0-1), risk_flags (string[] from: illegal, tos_violation, requires_deception, unpaid, spec_work, scam_signals, vague_scope, equity_only, low_budget, sensitive_data, on_site, needs_phone_calls),
p_win (0-1, be conservative: new vendor without reviews), p_paid (0-1), evidence_quality (0-1: how specific and verifiable the request is), strategic_value (0-1: repeatable/retainer potential),
confidence (0-1), unknowns (string[]), rationale (<= 120 words, cite the evidence).

Our company profile (trusted):
${JSON.stringify({ positioning: profile.positioning, skills: profile.skills, excluded: profile.excluded, target_hourly_rate_usd: (profile.target_hourly_rate_minor ?? 5000) / 100 })}

Opportunity metadata (trusted): source=${opp.source_key}, url=${opp.url}, posted_at=${opp.posted_at ?? 'unknown'}

${evidence.map((e, i) => untrusted(`evidence-${i + 1} ${e.url}`, String(e.excerpt), 6000)).join('\n\n')}`;

  const res = await ctx.ai.generate({ roleKey: 'research_analyst', taskId: ctx.task.id, tier: 'standard', schema: AnalysisSchema,
    messages: [{ role: 'user', content: prompt }], maxTokens: 1200 });
  const a = res.data;
  const revenueUsd = a.stated_budget_usd ?? a.est_revenue_usd;
  const hourlyCostMinor = 0; // AI providers are free-tier; owner time tracked separately
  const flags = [...new Set([...a.risk_flags.map((f) => f.toLowerCase()), ...(injection ? ['prompt_injection_suspected'] : []),
    ...(a.is_real_request ? [] : ['not_a_real_request'])])];

  return finish(ctx, async (tx) => {
    await tx`update public.opportunities set
        business_model = ${a.business_model}, revenue_mechanism = ${a.revenue_mechanism},
        buyer_name = coalesce(${a.buyer_name ?? null}, buyer_name),
        est_revenue_minor = ${revenueUsd == null ? null : Math.round(revenueUsd * 100)},
        est_cost_minor = ${a.est_hours == null ? null : Math.round(a.est_hours * hourlyCostMinor)},
        est_hours = ${a.est_hours}, skills = ${a.skills_required},
        skill_fit = ${clamp01(a.skill_fit)}, difficulty = ${clamp01(a.difficulty)}, competition = ${clamp01(a.competition)},
        risk = ${clamp01(injection ? Math.max(a.risk, 0.6) : a.risk)}, risk_flags = ${flags},
        p_win = ${clamp01(a.p_win)}, p_paid = ${clamp01(a.p_paid)},
        evidence_quality = ${clamp01(a.is_real_request ? a.evidence_quality : Math.min(a.evidence_quality, 0.2))},
        strategic_value = ${clamp01(a.strategic_value)}, confidence = ${clamp01(a.confidence)},
        analysis = ${tx.json({ ...a, model: res.model, provider: res.provider, injection_suspected: injection } as never)}
      where id = ${id}`;
    await enqueue(tx, { type: 'opportunity.score', key: `score:${id}:${ctx.task.id}`, role: 'scoring_engine', entityType: 'opportunity',
      entityId: id, input: { opportunity_id: id }, priority: 45, title: `Score: ${String(opp.title).slice(0, 80)}` });
    return { model: res.model, est_revenue_usd: revenueUsd, skill_fit: a.skill_fit, flags };
  });
};

// ---------------------------------------------------------------------------
// opportunity.score — Scoring Engine (deterministic, explainable)
// ---------------------------------------------------------------------------
export const scoreOpportunityTask: Handler = async (ctx) => {
  const id = String(ctx.task.input.opportunity_id);
  const [opp] = await ctx.sql`select * from public.opportunities where id = ${id}`;
  if (!opp) throw new PermanentError('opportunity not found');
  if (opp.analysis == null) throw new RetryableError('opportunity not analyzed yet');
  const weights = await getSetting<ScoringWeights>(ctx.sql, 'scoring.weights', null as never);
  const rules = await getSetting<ScoringRules>(ctx.sql, 'scoring.rules', null as never);
  const num = (v: unknown) => (v == null ? null : Number(v));
  const r = scoreOpportunity({
    est_revenue_minor: num(opp.est_revenue_minor), est_cost_minor: num(opp.est_cost_minor), est_hours: num(opp.est_hours),
    p_win: num(opp.p_win), p_paid: num(opp.p_paid), skill_fit: num(opp.skill_fit), strategic_value: num(opp.strategic_value),
    evidence_quality: num(opp.evidence_quality), competition: num(opp.competition), risk: num(opp.risk),
    posted_at: opp.posted_at as Date | null, risk_flags: opp.risk_flags as string[],
  }, weights, rules);

  return finish(ctx, async (tx) => {
    if (opp.status !== 'scored') {
      if (opp.status !== 'analyzing') await tx`update public.opportunities set status = 'analyzing' where id = ${id}`;
      await tx`update public.opportunities set status = 'scored' where id = ${id}`;
    }
    await tx`update public.opportunities set score = ${r.score}, score_breakdown = ${tx.json(r as never)}, score_version = ${r.weights_version},
        decision = ${r.decision}, decision_reasons = ${r.reasons}, status = ${r.status} where id = ${id}`;
    await tx`insert into public.opportunity_decisions(opportunity_id, decision, score, score_breakdown, reasons, weights_version, decided_by)
        values (${id}, ${r.decision}, ${r.score}, ${tx.json(r as never)}, ${r.reasons}, ${r.weights_version}, 'agent:scoring_engine')`;
    if (r.status === 'shortlisted') {
      const { requestApproval } = await import('../queue.js');
      await requestApproval(tx, {
        actionType: 'opportunity.pursue', title: `Pursue: ${String(opp.title).slice(0, 100)}`, requestedBy: 'scoring_engine',
        reason: r.reasons.join(' · '),
        evidence: [{ type: 'url', value: opp.url }, { type: 'score', value: r.score }],
        expectedBenefit: `Expected value ${(r.expected_value_minor / 100).toFixed(0)} ${opp.currency}; est. revenue ${opp.est_revenue_minor ? (Number(opp.est_revenue_minor) / 100).toFixed(0) : 'unknown'}`,
        risk: `Risk ${Math.round(Number(opp.risk ?? 0) * 100)}%; flags: ${(opp.risk_flags as string[]).join(', ') || 'none'}`,
        riskLevel: Number(opp.risk ?? 0) > 0.5 ? 'high' : 'medium', costMinor: 0, currency: String(opp.currency),
        ifApproved: 'A lead is created in the CRM and the Sales Agent drafts a personalised first message (which will itself need approval before sending).',
        ifRejected: 'The opportunity stays shortlisted without action; you can reject or monitor it from the Opportunities page.',
        entityType: 'opportunity', entityId: id, taskId: ctx.task.id, key: `pursue:${id}`,
      });
    }
    return { score: r.score, decision: r.decision, status: r.status };
  });
};
