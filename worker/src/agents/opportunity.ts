import { z } from 'zod';
import { promises as dns } from 'node:dns';
import type { Handler } from './context.js';
import { finish } from './context.js';
import { CONNECTORS } from '../connectors/index.js';
import { enrichContacts } from '../connectors/enrich.js';
import { PermanentError, RetryableError } from '../errors.js';
import { clamp01, detectInjection, normalizeForFingerprint, sha256, untrusted } from '../sanitize.js';
import { enqueue } from '../queue.js';
import { getSetting, logEvent, type Sql, type Tx } from '../db.js';
import type { RawOpportunity } from '../connectors/types.js';
import { areaAt } from '../connectors/osm.js';
import { scoreOpportunity, type ScoringRules, type ScoringWeights } from '../scoring.js';
import { getMode, isPilot } from '../mode.js';

interface BusinessProfile { name: string; positioning: string; skills: string[]; excluded: string[]; target_hourly_rate_minor: number; currency: string; disclosure: string }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
// Directory prospecting (B2B): businesses that publish a professional email address
// ---------------------------------------------------------------------------
export interface ProspectingPolicy { start_per_day: number; step_per_day: number; max_per_day: number; started_at: string }

/** Daily first-contact allowance with a progressive warm-up (protects the mailbox's sending reputation). */
export function dailyProspectCap(p: ProspectingPolicy, now = new Date()): number {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(p.started_at).getTime()) / 86_400_000));
  return Math.min(p.max_per_day, p.start_per_day + days * p.step_per_day);
}

async function advanceCursor(sql: Sql | Tx, key: string) {
  const [src] = await sql`select config from public.sources where key = ${key}`;
  const cfg = (src?.config ?? {}) as Record<string, unknown>;
  const done = areaAt(cfg); const next = areaAt({ ...cfg, cursor: done.cursor + 1 });
  // Progress shown on the dashboard: area just explored, next one, coverage.
  await sql`update public.sources set config = config || ${sql.json({ cursor: done.cursor + 1, last_city: done.city, next_city: next.city,
      areas_total: done.total, cities_total: done.cities } as never)} where key = ${key}`;
}

const NEED_LABEL: Record<string, string> = {
  website: 'No website listed: a simple, professional showcase website (one page or a few pages, mobile friendly) is the obvious quick win.',
  marketing: 'Already has a website: offer quick wins such as ad scripts/scenarios for social media, flyers or menus as PDF, price lists or planning in Excel, simple visuals.',
};

const mxCache = new Map<string, Promise<boolean>>();
/** True when the domain has a mail server (MX record, or an A record as the SMTP fallback). */
export function domainReceivesMail(domain: string): Promise<boolean> {
  if (!mxCache.has(domain)) mxCache.set(domain, (async () => {
    const timeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, ko) => setTimeout(() => ko(new Error('dns timeout')), 4000))]);
    try { if ((await timeout(dns.resolveMx(domain))).length) return true; } catch { /* try A */ }
    try { return (await timeout(dns.resolve4(domain))).length > 0; } catch { return false; }
  })());
  return mxCache.get(domain)!;
}

const prospectFromDirectory = async (ctx: Parameters<Handler>[0], key: string, sourceName: string, found: RawOpportunity[]) => {
  let items = found;
  const policy = await getSetting<ProspectingPolicy>(ctx.sql, 'prospecting.policy', { start_per_day: 20, step_per_day: 10, max_per_day: 120, started_at: new Date().toISOString() });
  // Businesses that only list a website: look up the contact address published on their own site (bounded in time).
  const enriched = await enrichContacts(items.filter((i) => !i.buyerContact), { env: ctx.env, fetchFn: ctx.fetchFn, budgetMs: 60_000 });
  items = items.filter((i) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(i.buyerContact ?? '')));
  // Never write to a domain that cannot receive email: bounces hurt the mailbox reputation (and land the next emails in spam).
  let noMx = 0;
  if (ctx.env.GITHUB_ACTIONS === 'true') {
    const ok = await Promise.all(items.map((i) => domainReceivesMail(String(i.buyerContact).split('@')[1])));
    noMx = ok.filter((x) => !x).length;
    items = items.filter((_, k) => ok[k]);
  }
  return finish(ctx, async (tx) => {
    const [{ n: today }] = await tx`select count(*)::int as n from public.leads l join public.sources s on s.key = l.source
        where s.kind = 'directory' and l.created_at >= date_trunc('day', now())`;
    let room = Math.max(0, dailyProspectCap(policy) - Number(today));
    let created = 0, duplicates = 0, pursued = 0, kept = 0;
    // Prospects kept from previous days go first.
    const backlog = await tx`select o.id from public.opportunities o join public.sources s on s.key = o.source_key
        where s.kind = 'directory' and o.status = 'monitoring' and o.decision = 'investigate' order by o.discovered_at limit ${room}`;
    for (const b of backlog) { await tx`select public.pursue_opportunity(${b.id}::uuid)`; pursued++; room--; }
    for (const it of items) {
      const email = String(it.buyerContact ?? '').toLowerCase();
      const dup = await tx`select 1 from public.opportunities where (source_key = ${key} and external_id = ${it.externalId}) or lower(buyer_contact) = ${email}
          union all select 1 from public.contacts where lower(email) = ${email} limit 1`;
      if (dup.length) { duplicates++; continue; }
      const [ev] = await tx`insert into public.evidence(source_key, url, content_hash, title, excerpt, raw)
          values (${key}, ${it.url}, ${sha256(it.text)}, ${it.title}, ${it.text}, ${tx.json(it.raw as never)})
          on conflict (url, content_hash) do update set fetched_at = now() returning id`;
      const need = String(it.raw.need ?? 'website');
      const analysis = { prospect: true, need, language: it.raw.language ?? 'fr', category: it.raw.category, city: it.raw.city, website: it.raw.website ?? null,
        rationale: `${it.buyerName} (${it.raw.category}, ${it.raw.city}) publishes a professional email address. ${NEED_LABEL[need] ?? ''}` };
      const [opp] = await tx`insert into public.opportunities(source_key, external_id, fingerprint, title, description, url, buyer_name, buyer_contact,
            posted_at, last_verified_at, business_model, revenue_mechanism, skill_fit, risk, evidence_quality, analysis)
          values (${key}, ${it.externalId}, ${sha256(it.externalId)}, ${it.title}, ${it.text}, ${it.url}, ${it.buyerName ?? null}, ${email}, now(), now(),
            'ai_services', 'Proactive B2B proposal (launch program: free work for a review)', 0.85, 0.1, 0.7, ${tx.json(analysis as never)}) returning id`;
      await tx`insert into public.opportunity_evidence(opportunity_id, evidence_id) values (${opp.id}, ${ev.id})`;
      created++;
      await tx`update public.opportunities set status = 'monitoring', decision = 'investigate',
          decision_reasons = ${[`Prospect from ${sourceName}: ${NEED_LABEL[need] ?? need}`]} where id = ${opp.id}`;
      if (room > 0) { await tx`select public.pursue_opportunity(${opp.id}::uuid)`; pursued++; room--; } else kept++;
    }
    await advanceCursor(tx, key);
    await tx`update public.sources set last_run_at = now(), health = 'healthy', consecutive_failures = 0, last_error = null,
        items_found_total = items_found_total + ${created} where key = ${key}`;
    await logEvent(tx, 'source', key, 'discovery_completed', `${sourceName}: ${found.length} businesses (${enriched} emails found on their websites, ${noMx} without mail server), ${created} new, ${pursued} contacted today, ${kept} kept for the next days`,
      { found: found.length, enriched, no_mail_server: noMx, created, duplicates, pursued, kept });
    return { found: found.length, enriched, no_mail_server: noMx, created, duplicates, pursued, kept, city: found[0]?.raw.city ?? null };
  });
};

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
    if (source.kind === 'directory') await advanceCursor(ctx.sql, key);   // never stay stuck on one area
    await ctx.sql`update public.sources set health = case when consecutive_failures >= 2 then 'down' else 'degraded' end,
      consecutive_failures = consecutive_failures + 1, last_error = ${(e as Error).message.slice(0, 500)}, last_run_at = now() where key = ${key}`;
    throw e;
  }
  if (source.kind === 'directory') return prospectFromDirectory(ctx, key, String(source.name), items);
  const profile = await getSetting<BusinessProfile>(ctx.sql, 'business.profile', { skills: [] } as unknown as BusinessProfile);
  const requireEmail = (await getSetting<{ require_email_contact_for_outreach?: boolean }>(ctx.sql, 'comms.policy', {})).require_email_contact_for_outreach === true;
  // Postings without a printed email: look up the company's own published business contact (bounded in time).
  const knownIds = new Set((await ctx.sql`select external_id from public.opportunities where source_key = ${key}
      and external_id = any(${items.map((i) => i.externalId)})`).map((r) => String(r.external_id)));
  const enriched = requireEmail ? await enrichContacts(items.filter((i) => !knownIds.has(i.externalId)), { env: ctx.env, fetchFn: ctx.fetchFn, budgetMs: 70_000 }) : 0;

  return finish(ctx, async (tx) => {
    let created = 0, duplicates = 0, prefiltered = 0, unreachable = 0;
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
      if (requireEmail && !EMAIL_RE.test(String(it.buyerContact ?? ''))) {
        await tx`update public.opportunities set status = 'monitoring', decision = 'monitor',
            decision_reasons = ${['No published email address: cannot be contacted autonomously (no AI call spent)']} where id = ${opp.id}`;
        unreachable++; continue;
      }
      await enqueue(tx, { type: 'opportunity.analyze', key: `analyze:${opp.id}`, role: 'research_analyst', entityType: 'opportunity',
        entityId: opp.id, input: { opportunity_id: opp.id }, priority: 40, title: `Analyze: ${it.title.slice(0, 80)}`, timeoutSeconds: 240 });
    }
    await tx`update public.sources set last_run_at = now(), health = 'healthy', consecutive_failures = 0, last_error = null,
        items_found_total = items_found_total + ${created} where key = ${key}`;
    await logEvent(tx, 'source', key, 'discovery_completed', `${source.name}: ${items.length} items, ${created} new, ${duplicates} duplicates, ${prefiltered} prefiltered, ${enriched} contacts found on company sites, ${unreachable} without email`,
      { found: items.length, created, duplicates, prefiltered, enriched, unreachable });
    return { found: items.length, created, duplicates, prefiltered, enriched, unreachable };
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
    pilot: isPilot(await getMode(ctx.sql)),
  }, weights, rules);
  const comms = await getSetting<{ require_email_contact_for_outreach: boolean }>(ctx.sql, 'comms.policy', { require_email_contact_for_outreach: false });
  const hasEmail = EMAIL_RE.test(String(opp.buyer_contact ?? ''));
  const mode = await getMode(ctx.sql);
  if (r.status === 'shortlisted' && isPilot(mode)) {
    const [{ n }] = await ctx.sql`select count(*)::int as n from public.projects where budget_minor = 0 and status in ('planning','in_progress','in_qa','revision','ready_for_delivery')`;
    if (n >= mode.max_active_pilots) { r.status = 'monitoring'; r.decision = 'monitor'; r.reasons.push(`Launch program at capacity (${n}/${mode.max_active_pilots} free projects in progress): kept for later`); }
  }
  if (r.status === 'shortlisted' && comms.require_email_contact_for_outreach && !hasEmail) {
    r.status = 'monitoring'; r.decision = 'monitor';
    r.reasons.push('No direct email contact published: kept in monitoring (autonomous outreach only uses published email addresses)');
  }

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
      const { requestApproval, autoApproveIfPolicy } = await import('../queue.js');
      const approvalId = await requestApproval(tx, {
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
      if (await autoApproveIfPolicy(tx, approvalId)) await tx`select public.execute_approved_actions()`;
    }
    return { score: r.score, decision: r.decision, status: r.status };
  });
};
