// Read-only production diagnostics: aggregated counts only (no names, emails or message bodies are printed).
import { loadConfig } from '../config.js';
import { connect } from '../db.js';

const sql = connect(loadConfig().databaseUrl);
const show = (title: string, rows: unknown) => console.log(`\n== ${title}\n${JSON.stringify(rows, null, 1)}`);
try {
  show('opportunities by status/decision', await sql`select status, decision, count(*)::int n from public.opportunities group by 1,2 order by 3 desc`);
  show('opportunities by source', await sql`select source_key, count(*)::int n, count(*) filter (where buyer_contact ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')::int with_email from public.opportunities group by 1 order by 2 desc`.catch((e) => String(e.message)));
  show('top decision reasons', await sql`select reason, count(*)::int n from public.opportunities, unnest(decision_reasons) reason group by 1 order by 2 desc limit 25`);
  show('score distribution', await sql`select width_bucket(score, 0, 100, 10) bucket, count(*)::int n from public.opportunities where score is not null group by 1 order by 1`);
  show('leads by stage', await sql`select stage, count(*)::int n from public.leads group by 1`);
  show('messages by direction/status', await sql`select direction, status, count(*)::int n from public.messages group by 1,2`);
  show('approvals by type/status', await sql`select action_type, status, count(*)::int n from public.approvals group by 1,2 order by 3 desc`);
  show('tasks by type/status', await sql`select type, status, count(*)::int n from public.tasks group by 1,2 order by 1,2`);
  show('recent task errors', await sql`select type, left(last_error, 300) err, count(*)::int n from public.tasks where last_error is not null group by 1,2 order by 3 desc limit 15`);
  show('settings', await sql`select key, value from public.settings where key in ('business.mode','comms.policy','scoring.rules','system.kill_switch','autonomy.policy')`);
  show('worker heartbeats', await sql`select worker_id, status, last_seen_at, tasks_succeeded, tasks_failed, note from public.worker_heartbeats order by last_seen_at desc limit 8`);
} catch (e) { console.error('diagnose failed:', (e as Error).message); process.exitCode = 1; }
finally { await sql.end({ timeout: 5 }); }
