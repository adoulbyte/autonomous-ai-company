import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { freshDb } from './helpers.js';
import { fakeFetch } from './fakes.js';
import type { Sql } from '../src/db.js';
import { AiGateway } from '../src/ai/gateway.js';
import { DeferError, RetryableError } from '../src/errors.js';

let db: Awaited<ReturnType<typeof freshDb>>; let sql: Sql;
const env = { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv;
const schema = z.object({ answer: z.string() });
const msg = [{ role: 'user' as const, content: 'say hi' }];
beforeAll(async () => { db = await freshDb(); sql = db.sql; });
afterAll(async () => { await db.drop(); });
beforeEach(async () => {
  await sql`update public.ai_models set cooldown_until = null, enabled = true, consecutive_failures = 0, last_error = null`;
  await sql`delete from public.ai_calls`;
});

describe('AI gateway', () => {
  it('only uses providers whose API key is configured, preferring the requested tier', async () => {
    const ai = new AiGateway(sql, env);
    const c = await ai.candidates('standard');
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((m) => m.provider_key === 'github_models')).toBe(true);
    expect(c[0].tier).toBe('standard');
    expect(c.some((m) => m.tier === 'fast')).toBe(false); // no silent downgrade
  });

  it('returns validated output and records usage', async () => {
    const f = fakeFetch({ ai: () => ({ body: { answer: 'hi' } }) });
    const r = await new AiGateway(sql, env, f.fn).generate({ roleKey: 'research_analyst', tier: 'standard', schema, messages: msg });
    expect(r.data.answer).toBe('hi');
    const calls = await sql`select status, prompt_tokens from public.ai_calls`;
    expect(calls).toEqual([{ status: 'ok', prompt_tokens: 100 }]);
    expect(f.calls[0].prompt).toMatch(/untrusted_data/); // guard system prompt always included
  });

  it('falls back to the next model on rate limit and cools the limited model down', async () => {
    let first = true;
    const f = fakeFetch({ ai: (_p, model) => {
      if (first) { first = false; return { status: 429, headers: { 'retry-after': '120' }, body: { error: 'rate' } }; }
      return { body: { answer: `from ${model}` } };
    } });
    const r = await new AiGateway(sql, env, f.fn).generate({ roleKey: 'research_analyst', tier: 'standard', schema, messages: msg });
    expect(f.calls.length).toBe(2);
    expect(r.model).toBe(f.calls[1].model);
    const [m] = await sql`select cooldown_until from public.ai_models where model = ${f.calls[0].model!}`;
    expect(new Date(m.cooldown_until).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect((await sql`select status from public.ai_calls order by id`).map((x) => x.status)).toEqual(['rate_limited', 'ok']);
  });

  it('repairs invalid output once, then succeeds', async () => {
    let n = 0;
    const f = fakeFetch({ ai: () => (n++ === 0 ? { content: 'not json at all' } : { body: { answer: 'fixed' } }) });
    const r = await new AiGateway(sql, env, f.fn).generate({ roleKey: 'research_analyst', tier: 'standard', schema, messages: msg });
    expect(r.data.answer).toBe('fixed');
    expect(f.calls[1].prompt).toMatch(/did not match the required JSON schema/);
  });

  it('never reports success for persistently invalid output', async () => {
    const f = fakeFetch({ ai: () => ({ body: { wrong: true } }) });
    await expect(new AiGateway(sql, env, f.fn).generate({ roleKey: 'research_analyst', tier: 'standard', schema, messages: msg })).rejects.toBeInstanceOf(RetryableError);
  });

  it('defers (does not fail or fake) when every provider is unavailable', async () => {
    const f = fakeFetch({ ai: () => ({ status: 503 }) });
    await expect(new AiGateway(sql, env, f.fn).generate({ roleKey: 'research_analyst', tier: 'standard', schema, messages: msg })).rejects.toBeInstanceOf(DeferError);
    await expect(new AiGateway(sql, {} as NodeJS.ProcessEnv, f.fn).generate({ roleKey: 'research_analyst', tier: 'standard', schema, messages: msg })).rejects.toThrow(/no AI model available/);
  });

  it('disables models the provider reports as unknown (capability assessment)', async () => {
    let first = true;
    const f = fakeFetch({ ai: () => { if (first) { first = false; return { status: 404, body: { error: 'Unknown model' } }; } return { body: { answer: 'ok' } }; } });
    await new AiGateway(sql, env, f.fn).generate({ roleKey: 'research_analyst', tier: 'standard', schema, messages: msg });
    const [m] = await sql`select enabled from public.ai_models where model = ${f.calls[0].model!}`;
    expect(m.enabled).toBe(false);
  });

  it('enforces daily budgets per role and globally', async () => {
    await sql`update public.agent_roles set daily_call_budget = 1 where key = 'sales_agent'`;
    const f = fakeFetch({ ai: () => ({ body: { answer: 'x' } }) });
    const ai = new AiGateway(sql, env, f.fn);
    await ai.generate({ roleKey: 'sales_agent', tier: 'standard', schema, messages: msg });
    await expect(ai.generate({ roleKey: 'sales_agent', tier: 'standard', schema, messages: msg })).rejects.toThrow(/daily AI budget/);
    await sql`update public.settings set value = '1' where key = 'limits.daily_ai_calls'`;
    await expect(ai.generate({ roleKey: 'research_analyst', tier: 'standard', schema, messages: msg })).rejects.toThrow(/global daily AI call cap/);
    await sql`update public.settings set value = '300' where key = 'limits.daily_ai_calls'`;
  });

  it('prefers a different model for QA independence', async () => {
    const f = fakeFetch({ ai: () => ({ body: { answer: 'x' } }) });
    const ai = new AiGateway(sql, env, f.fn);
    const first = (await ai.candidates('standard'))[0].model; // the producer's model
    const r = await ai.generate({ roleKey: 'qa_reviewer', tier: 'standard', schema, messages: msg, avoidModel: first });
    expect(r.model).not.toBe(first);
  });
});
