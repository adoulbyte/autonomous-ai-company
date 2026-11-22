import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { connect, describeDbTarget } from './db.js';

/** Applies supabase/migrations/*.sql in order, exactly once each, inside transactions. */
export async function migrate(databaseUrl: string, dir = join(dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations'), log = console.log) {
  log(`database target: ${describeDbTarget(databaseUrl)}`);
  const sql = connect(databaseUrl, { max: 1 });
  try {
    await sql`create schema if not exists ops`;
    await sql`create table if not exists ops.schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
    await sql`revoke all on schema ops from public`;
    const applied = new Map((await sql`select name, checksum from ops.schema_migrations`).map((r) => [r.name as string, r.checksum as string]));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const body = readFileSync(join(dir, f), 'utf8');
      const sum = createHash('sha256').update(body).digest('hex');
      if (applied.has(f)) {
        if (applied.get(f) !== sum) throw new Error(`migration ${f} was modified after being applied (checksum mismatch). Create a new migration instead.`);
        continue;
      }
      log(`applying ${f}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into ops.schema_migrations(name, checksum) values (${f}, ${sum})`;
      });
    }
    log(`migrations up to date (${files.length} files)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
  migrate(url).catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
}
