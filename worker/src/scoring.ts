/**
 * Explainable, deterministic opportunity scoring. AI produces structured estimates;
 * arithmetic (this file) produces the score, decision and human-readable reasons.
 */
export interface ScoringWeights {
  version: number;
  value: number; p_win: number; p_paid: number; speed: number; skill_fit: number;
  strategic: number; evidence: number; freshness: number; competition: number; risk: number;
}
export interface ScoringRules {
  shortlist_threshold: number; monitor_threshold: number;
  min_skill_fit: number; max_risk: number; max_age_days: number;
  min_evidence_quality: number; value_cap_minor: number; min_value_minor: number;
}
export interface ScoringInput {
  est_revenue_minor: number | null;
  est_cost_minor: number | null;
  est_hours: number | null;
  p_win: number | null; p_paid: number | null;
  skill_fit: number | null; strategic_value: number | null;
  evidence_quality: number | null; competition: number | null; risk: number | null;
  posted_at: Date | string | null;
  risk_flags?: string[];
  now?: Date;
  /** Launch program (free work for a review): revenue is irrelevant, so value and payment
   *  probability are not scored and "unpaid"/"spec work" postings are acceptable. */
  pilot?: boolean;
}
export interface ScoreComponent { key: string; label: string; normalized: number; weight: number; points: number; explanation: string }
export interface ScoreResult {
  score: number;
  decision: 'pursue' | 'monitor' | 'reject' | 'investigate';
  status: 'shortlisted' | 'monitoring' | 'rejected';
  reasons: string[];
  components: ScoreComponent[];
  hard_constraints: { rule: string; passed: boolean; detail: string }[];
  expected_value_minor: number;
  weights_version: number;
}

const BLOCKING_FLAGS = ['illegal', 'tos_violation', 'requires_deception', 'unpaid', 'spec_work', 'scam_signals'];
const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function validateWeights(w: ScoringWeights): void {
  const keys: (keyof ScoringWeights)[] = ['value', 'p_win', 'p_paid', 'speed', 'skill_fit', 'strategic', 'evidence', 'freshness', 'competition', 'risk'];
  for (const k of keys) if (typeof w[k] !== 'number' || w[k] < 0 || w[k] > 1) throw new Error(`invalid weight ${k}`);
  const sum = keys.reduce((s, k) => s + (w[k] as number), 0);
  if (Math.abs(sum - 1) > 0.01) throw new Error(`weights must sum to 1 (got ${sum.toFixed(3)})`);
}

const PILOT_ACCEPTED_FLAGS = ['unpaid', 'spec_work'];

/** In the launch program, money-related weights are redistributed proportionally over the other criteria. */
export function pilotWeights(w: ScoringWeights): ScoringWeights {
  const rest = 1 - w.value - w.p_paid;
  const k = rest > 0 ? 1 / rest : 1;
  return { ...w, value: 0, p_paid: 0, p_win: w.p_win * k, speed: w.speed * k, skill_fit: w.skill_fit * k, strategic: w.strategic * k,
    evidence: w.evidence * k, freshness: w.freshness * k, competition: w.competition * k, risk: w.risk * k };
}

export function scoreOpportunity(input: ScoringInput, weights: ScoringWeights, rules: ScoringRules): ScoreResult {
  validateWeights(weights);
  const w = input.pilot ? pilotWeights(weights) : weights;
  const now = input.now ?? new Date();
  const ageDays = input.posted_at ? Math.max(0, (now.getTime() - new Date(input.posted_at).getTime()) / 86_400_000) : null;
  const revenue = Math.max(0, input.est_revenue_minor ?? 0);
  const cost = Math.max(0, input.est_cost_minor ?? 0);
  const pWin = input.p_win ?? 0.1;
  const pPaid = input.p_paid ?? 0.5;
  const fit = input.skill_fit ?? 0;
  const risk = input.risk ?? 0.5;
  const evidence = input.evidence_quality ?? 0;
  const competition = input.competition ?? 0.5;
  const hours = input.est_hours ?? null;
  const ev = Math.round(pWin * pPaid * Math.max(0, revenue - cost));

  // Normalisations (all 0..1, higher is better)
  const valueNorm = revenue > 0 ? Math.min(1, Math.log10(1 + (revenue - cost > 0 ? revenue - cost : 0) / 100) / Math.log10(1 + rules.value_cap_minor / 100)) : 0;
  const speedNorm = hours == null ? 0.3 : Math.max(0, Math.min(1, 1 - Math.log10(1 + hours) / Math.log10(1 + 200)));
  const freshNorm = ageDays == null ? 0.3 : Math.max(0, 1 - ageDays / rules.max_age_days);

  const parts: Omit<ScoreComponent, 'points'>[] = [
    { key: 'value', label: 'Net value', normalized: valueNorm, weight: w.value, explanation: revenue ? `est. revenue ${money(revenue)}, est. cost ${money(cost)}` : 'no revenue estimate' },
    { key: 'p_win', label: 'Probability of winning', normalized: pWin, weight: w.p_win, explanation: pct(pWin) },
    { key: 'p_paid', label: 'Probability of payment', normalized: pPaid, weight: w.p_paid, explanation: pct(pPaid) },
    { key: 'speed', label: 'Time to deliver', normalized: speedNorm, weight: w.speed, explanation: hours == null ? 'effort unknown' : `~${hours}h estimated` },
    { key: 'skill_fit', label: 'Skill fit', normalized: fit, weight: w.skill_fit, explanation: pct(fit) },
    { key: 'strategic', label: 'Strategic value', normalized: input.strategic_value ?? 0.3, weight: w.strategic, explanation: pct(input.strategic_value ?? 0.3) },
    { key: 'evidence', label: 'Evidence quality', normalized: evidence, weight: w.evidence, explanation: pct(evidence) },
    { key: 'freshness', label: 'Freshness', normalized: freshNorm, weight: w.freshness, explanation: ageDays == null ? 'posting date unknown' : `${ageDays.toFixed(1)} days old` },
    { key: 'competition', label: 'Low competition', normalized: 1 - competition, weight: w.competition, explanation: `competition ${pct(competition)}` },
    { key: 'risk', label: 'Low risk', normalized: 1 - risk, weight: w.risk, explanation: `risk ${pct(risk)}` },
  ];
  const components = parts.map((p) => ({ ...p, points: Math.round(p.normalized * p.weight * 10000) / 100 }));
  const score = Math.round(components.reduce((s, c) => s + c.points, 0) * 100) / 100;

  const flags = (input.risk_flags ?? []).map((f) => f.toLowerCase());
  const blocking = flags.filter((f) => BLOCKING_FLAGS.includes(f) && !(input.pilot && PILOT_ACCEPTED_FLAGS.includes(f)));
  const hard = [
    { rule: 'skill_fit', passed: fit >= rules.min_skill_fit, detail: `skill fit ${pct(fit)} (min ${pct(rules.min_skill_fit)})` },
    { rule: 'risk', passed: risk <= rules.max_risk, detail: `risk ${pct(risk)} (max ${pct(rules.max_risk)})` },
    { rule: 'freshness', passed: ageDays == null || ageDays <= rules.max_age_days, detail: ageDays == null ? 'age unknown' : `${ageDays.toFixed(0)} days (max ${rules.max_age_days})` },
    { rule: 'evidence', passed: evidence >= rules.min_evidence_quality, detail: `evidence ${pct(evidence)} (min ${pct(rules.min_evidence_quality)})` },
    { rule: 'blocking_flags', passed: blocking.length === 0, detail: blocking.length ? `blocking flags: ${blocking.join(', ')}` : 'none' },
    { rule: 'min_value', passed: input.pilot || revenue === 0 || revenue >= rules.min_value_minor, detail: revenue ? `${money(revenue)} (min ${money(rules.min_value_minor)})` : 'value unknown' },
  ];

  const failed = hard.filter((h) => !h.passed);
  const top = [...components].sort((a, b) => b.points - a.points).slice(0, 2).map((c) => `${c.label}: ${c.explanation}`);
  const weak = [...components].sort((a, b) => a.normalized - b.normalized).slice(0, 2).map((c) => `${c.label}: ${c.explanation}`);
  const reasons: string[] = [];
  let decision: ScoreResult['decision'];
  let status: ScoreResult['status'];

  if (failed.length) {
    decision = 'reject'; status = 'rejected';
    reasons.push(...failed.map((f) => `Hard constraint failed — ${f.detail}`));
  } else if (score >= rules.shortlist_threshold) {
    decision = 'pursue'; status = 'shortlisted';
    reasons.push(`Score ${score} ≥ shortlist threshold ${rules.shortlist_threshold}`, `Strengths — ${top.join('; ')}`);
  } else if (score >= rules.monitor_threshold) {
    decision = revenue === 0 ? 'investigate' : 'monitor'; status = 'monitoring';
    reasons.push(`Score ${score} between monitor (${rules.monitor_threshold}) and shortlist (${rules.shortlist_threshold}) thresholds`, `Weakest — ${weak.join('; ')}`);
  } else {
    decision = 'reject'; status = 'rejected';
    reasons.push(`Score ${score} < monitor threshold ${rules.monitor_threshold}`, `Weakest — ${weak.join('; ')}`);
  }
  if (input.pilot) reasons.push('Launch program: judged on fit, feasibility and reachability (work offered free for a review), not on revenue');
  else reasons.push(`Expected value (P(win)×P(paid)×(revenue−cost)) = ${money(ev)}`);
  return { score, decision, status, reasons, components, hard_constraints: hard, expected_value_minor: ev, weights_version: w.version };
}
