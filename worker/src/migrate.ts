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
      // A migration whose text was scrubbed from the repository history (personal data removed) carries this marker:
      // it is not re-run; only its recorded name/checksum is updated. Its effects on the live database are unchanged.
      const scrubbed = body.includes('-- history-rewritten');
      const sameVersion = [...applied.keys()].find((n) => n !== f && n.slice(0, 15) === f.slice(0, 15));
      if (!applied.has(f) && scrubbed && sameVersion) {
        await sql`update ops.schema_migrations set name = ${f}, checksum = ${sum} where name = ${sameVersion}`;
        applied.delete(sameVersion); applied.set(f, sum); log(`recorded scrubbed migration ${f}`); continue;
      }
      if (applied.has(f)) {
        if (applied.get(f) !== sum) {
          if (!scrubbed) throw new Error(`migration ${f} was modified after being applied (checksum mismatch). Create a new migration instead.`);
          await sql`update ops.schema_migrations set checksum = ${sum} where name = ${f}`; log(`recorded scrubbed migration ${f}`);
        }
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
