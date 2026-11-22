import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb } from './helpers.js';
import type { Sql } from '../src/db.js';
import { claim, complete, defer, enqueue, fail, heartbeat } from '../src/queue.js';

let db: Awaited<ReturnType<typeof freshDb>>; let sql: Sql;
beforeAll(async () => { db = await freshDb(); sql = db.sql; });
afterAll(async () => { await db.drop(); });

const status = async (id: string) => (await sql`select status, attempts, error, run_after from public.tasks where id = ${id}`)[0];

describe('durable task queue', () => {
  it('enqueue is idempotent', async () => {
    const a = await enqueue(sql, { type: 'analytics.snapshot', key: 'idem-1' });
    const b = await enqueue(sql, { type: 'analytics.snapshot', key: 'idem-1' });
    expect(a).toBe(b);
    expect((await sql`select count(*)::int n from public.tasks where idempotency_key = 'idem-1'`)[0].n).toBe(1);
    await sql`update public.tasks set status = 'cancelled' where id = ${a}`;
  });

  it('concurrent workers never claim the same task (SKIP LOCKED)', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => enqueue(sql, { type: 'x.concurrent', key: `conc-${i}` })));
    const results = await Promise.all(Array.from({ length: 5 }, (_, w) => claim(sql, `w${w}`, 3, ['x.concurrent'])));
    const claimed = results.flat().map((t) => t.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.length).toBe(10);
    for (const t of results.flat()) await complete(sql, t.id, t.lease_owner!, { ok: true });
    expect(ids.length).toBe(10);
  });

  it('retries with backoff, then dead-letters', async () => {
    const id = await enqueue(sql, { type: 'x.flaky', key: 'flaky-1', maxAttempts: 2 });
    let [t] = await claim(sql, 'w1', 1, ['x.flaky']);
    expect(await fail(sql, t.id, 'w1', 'boom', true)).toBe('retry_wait');
    const s1 = await status(id);
    expect(s1.status).toBe('retry_wait');
    expect(new Date(s1.run_after).getTime()).toBeGreaterThan(Date.now());
    expect(await claim(sql, 'w1', 1, ['x.flaky'])).toHaveLength(0); // backoff respected
    await sql`update public.tasks set run_after = now() where id = ${id}`;
    [t] = await claim(sql, 'w1', 1, ['x.flaky']);
    expect(await fail(sql, t.id, 'w1', 'boom again', true)).toBe('dead');
    expect((await status(id)).status).toBe('dead');
    const ev = await sql`select * from public.events where entity_id = ${id} and event_type = 'task_dead_lettered'`;
    expect(ev).toHaveLength(1);
  });

  it('permanent errors go straight to dead letter', async () => {
    const id = await enqueue(sql, { type: 'x.perm', key: 'perm-1', maxAttempts: 5 });
    const [t] = await claim(sql, 'w1', 1, ['x.perm']);
    expect(await fail(sql, t.id, 'w1', 'bad input', false)).toBe('dead');
    expect((await status(id)).attempts).toBe(1);
  });

  it('dependencies block until parents succeed, and cancel when parents die', async () => {
    const parent = await enqueue(sql, { type: 'x.parent', key: 'p-1' });
    const child = await enqueue(sql, { type: 'x.child', key: 'c-1', dependsOn: [parent] });
    expect((await status(child)).status).toBe('blocked');
    expect(await claim(sql, 'w', 5, ['x.child'])).toHaveLength(0);
    const [p] = await claim(sql, 'w', 1, ['x.parent']);
    await complete(sql, p.id, 'w', {});
    expect((await status(child)).status).toBe('pending');
    const parent2 = await enqueue(sql, { type: 'x.parent', key: 'p-2', maxAttempts: 1 });
    const child2 = await enqueue(sql, { type: 'x.child', key: 'c-2', dependsOn: [parent2] });
    const [p2] = await claim(sql, 'w', 1, ['x.parent']);
    await fail(sql, p2.id, 'w', 'fatal', false);
    expect((await status(child2)).status).toBe('cancelled');
  });

  it('recovers tasks from a crashed worker (lease expiry) and rejects late completion', async () => {
    const id = await enqueue(sql, { type: 'x.crash', key: 'crash-1', maxAttempts: 3 });
    const [t] = await claim(sql, 'dead-worker', 1, ['x.crash']);
    await sql`update public.tasks set lease_expires_at = now() - interval '1 second' where id = ${t.id}`;
    const n = (await sql`select public.recover_expired_leases() as n`)[0].n;
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await status(id)).status).toBe('retry_wait');
    // the crashed worker comes back and tries to complete: must be refused
    expect(await complete(sql, t.id, 'dead-worker', { late: true })).toBe(false);
    expect(await heartbeat(sql, t.id, 'dead-worker')).toBe(false);
    const runs = await sql`select status from public.task_runs where task_id = ${id}`;
    expect(runs[0].status).toBe('lease_expired');
  });

  it('defer does not consume attempts and is bounded', async () => {
    await sql`update public.settings set value = '2' where key = 'limits.max_deferrals'`;
    const id = await enqueue(sql, { type: 'x.defer', key: 'defer-1', maxAttempts: 1 });
    for (let i = 0; i < 2; i++) {
      await sql`update public.tasks set run_after = now() where id = ${id}`;
      const [t] = await claim(sql, 'w', 1, ['x.defer']);
      expect(await defer(sql, t.id, 'w', 60, 'no model')).toBe('deferred');
      expect((await status(id)).attempts).toBe(0);
    }
    await sql`update public.tasks set run_after = now() where id = ${id}`;
    const [t] = await claim(sql, 'w', 1, ['x.defer']);
    expect(await defer(sql, t.id, 'w', 60, 'no model')).toBe('dead');
  });

  it('kill switch stops all claiming', async () => {
    await enqueue(sql, { type: 'x.kill', key: 'kill-1' });
    await sql`update public.settings set value = 'true' where key = 'system.kill_switch'`;
    expect(await claim(sql, 'w', 5, ['x.kill'])).toHaveLength(0);
    await sql`update public.settings set value = 'false' where key = 'system.kill_switch'`;
    expect(await claim(sql, 'w', 5, ['x.kill'])).toHaveLength(1);
  });

  it('limits task fan-out per entity', async () => {
    await sql`update public.settings set value = '3' where key = 'limits.max_tasks_per_entity'`;
    for (let i = 0; i < 3; i++) await enqueue(sql, { type: 'x.fan', key: `fan-${i}`, entityType: 'e', entityId: 'one' });
    await expect(enqueue(sql, { type: 'x.fan', key: 'fan-4', entityType: 'e', entityId: 'one' })).rejects.toThrow(/fan-out limit/);
  });

  it('survives database unavailability with a clear error (no false success)', async () => {
    const { connect } = await import('../src/db.js');
    const bad = connect('postgres://postgres@localhost:1/nowhere', { max: 1 });
    await expect(claim(bad, 'w', 1)).rejects.toThrow();
    await bad.end({ timeout: 1 });
  });
});
