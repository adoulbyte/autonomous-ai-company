import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { connect, type Sql } from '../src/db.js';

/** Base server URL for tests (local Postgres 16 or CI service container). */
export const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:54322/postgres';
const ROOT = join(import.meta.dirname, '../..');

/** Create an isolated database with the Supabase shim + all migrations applied. */
export async function freshDb(): Promise<{ sql: Sql; url: string; drop: () => Promise<void> }> {
  const name = `aic_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  const sql = connect(url, { max: 6 });
  await sql.unsafe(readFileSync(join(ROOT, 'supabase/local/00_supabase_shim.sql'), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'supabase/migrations')).sort()) {
    await sql.unsafe(readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8'));
  }
  return {
    sql, url,
    drop: async () => {
      await sql.end({ timeout: 2 });
      const a = postgres(BASE_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export const OWNER_ID = '00000000-0000-4000-8000-000000000001';
export const STRANGER_ID = '00000000-0000-4000-8000-000000000002';

export async function registerOwner(sql: Sql) {
  await sql`insert into auth.users(id, email) values (${OWNER_ID}, 'owner@example.test'), (${STRANGER_ID}, 'stranger@example.test') on conflict do nothing`;
  await sql`insert into public.app_owner(user_id, email) values (${OWNER_ID}, 'owner@example.test') on conflict do nothing`;
}

/** Run as a Supabase API caller (anon / authenticated with a JWT subject), exactly as PostgREST does. */
export async function asRole<T>(sql: Sql, role: 'anon' | 'authenticated', sub: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>, extraClaims: Record<string, unknown> = {}): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role, ...extraClaims } : { role })}, true)`;
    return fn(tx as never);
  }) as Promise<T>;
}
export const asOwner = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>) => asRole(sql, 'authenticated', OWNER_ID, fn);
