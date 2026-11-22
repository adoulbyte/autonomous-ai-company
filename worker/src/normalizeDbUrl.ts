// Prints the normalized connection URL to stdout for tools like pg_dump. Use only inside command
// substitution ("$(...)") so the value never appears in logs.
import { applySupabasePoolerUser, parseDbUrl } from './db.js';
const p = applySupabasePoolerUser(parseDbUrl(process.env.DATABASE_URL ?? ''));
process.stdout.write(`postgresql://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${p.database}?sslmode=require`);
